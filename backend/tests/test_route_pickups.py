"""Route-based pickup location selection (PICKUP_SELECTION_MODE=route).

The Google Routes API is always mocked (httpx.MockTransport) and Supabase is
replaced by a fake, so these tests never reach an external service.
"""

import math
import pathlib
import sys
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import main  # noqa: E402
import route_analysis  # noqa: E402
from models import RouteAnalysisRequest, RouteAnalysisResponse  # noqa: E402
from route_analysis import (  # noqa: E402
    PASS_POINT,
    ROUTE_MODE_FIELD_MASK,
    PickupLocation,
    RouteAnalysisError,
    analyze_route_with_pickups,
    decode_polyline,
    find_pickup_candidates,
    point_to_segment_distance,
    route_segments,
)

# A straight south-to-north route along longitude 137.0 (about 22 km).
ROUTE_LNG = 137.0
ROUTE_START_LAT = 35.0
ROUTE_END_LAT = 35.2
# One degree of longitude at this latitude, in meters (for east/west offsets).
METERS_PER_LNG_DEGREE = math.radians(1) * math.cos(math.radians(35.05)) * 6_371_008.8


def encode_polyline(points):
    def encode_value(value):
        value = ~(value << 1) if value < 0 else value << 1
        chunks = []
        while value >= 0x20:
            chunks.append(chr((0x20 | (value & 0x1F)) + 63))
            value >>= 5
        chunks.append(chr(value + 63))
        return "".join(chunks)

    out = []
    prev_lat = prev_lng = 0
    for lat, lng in points:
        lat_i, lng_i = round(lat * 1e5), round(lng * 1e5)
        out.append(encode_value(lat_i - prev_lat) + encode_value(lng_i - prev_lng))
        prev_lat, prev_lng = lat_i, lng_i
    return "".join(out)


def east_of_route(lat, meters):
    return PickupLocation(name=f"east-{meters}", lat=lat, lng=ROUTE_LNG + meters / METERS_PER_LNG_DEGREE)


def straight_route_body(*, steps=True, duration="1440s", static_duration="1200s"):
    """Two steps (south half, north half), 600s static each; traffic factor 1.2."""
    mid_lat = (ROUTE_START_LAT + ROUTE_END_LAT) / 2
    first = [(ROUTE_START_LAT, ROUTE_LNG), (mid_lat, ROUTE_LNG)]
    second = [(mid_lat, ROUTE_LNG), (ROUTE_END_LAT, ROUTE_LNG)]
    route = {
        "duration": duration,
        "staticDuration": static_duration,
        "distanceMeters": 22239,
        "polyline": {"encodedPolyline": encode_polyline(first + second[1:])},
    }
    if steps:
        route["legs"] = [
            {
                "steps": [
                    {
                        "staticDuration": "600s",
                        "distanceMeters": 11119,
                        "polyline": {"encodedPolyline": encode_polyline(first)},
                    },
                    {
                        "staticDuration": "600s",
                        "distanceMeters": 11119,
                        "polyline": {"encodedPolyline": encode_polyline(second)},
                    },
                ]
            }
        ]
    return {"routes": [route]}


def make_request(**overrides):
    data = {
        "origin": "名古屋駅",
        "destination": "下呂温泉",
        "departure_at": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    data.update(overrides)
    return RouteAnalysisRequest(**data)


class RecordingGoogle:
    def __init__(self, body=None, status_code=200):
        self.body = body if body is not None else straight_route_body()
        self.status_code = status_code
        self.requests = []

    def client(self):
        def handler(request):
            self.requests.append(request)
            return httpx.Response(self.status_code, json=self.body)

        return httpx.Client(transport=httpx.MockTransport(handler))


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------


class TestDecodePolyline:
    def test_decodes_googles_reference_example(self):
        # https://developers.google.com/maps/documentation/utilities/polylinealgorithm
        assert decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@") == [
            (38.5, -120.2),
            (40.7, -120.95),
            (43.252, -126.453),
        ]

    def test_empty_string_is_empty(self):
        assert decode_polyline("") == []

    def test_round_trips_with_test_encoder(self):
        points = [(35.0, 137.0), (35.12345, 137.54321), (34.9, 136.5)]
        assert decode_polyline(encode_polyline(points)) == points

    @pytest.mark.parametrize("encoded", ["_p~iF~ps|U_", "_p~iF", "\x00\x01"])
    def test_malformed_polyline_raises_value_error(self, encoded):
        with pytest.raises(ValueError):
            decode_polyline(encoded)


class TestPointToSegmentDistance:
    def test_point_on_segment_is_zero(self):
        distance, t = point_to_segment_distance((35.1, ROUTE_LNG), (35.0, ROUTE_LNG), (35.2, ROUTE_LNG))
        assert distance == pytest.approx(0, abs=0.01)
        assert t == pytest.approx(0.5, abs=1e-6)

    def test_perpendicular_offset_is_measured_in_meters(self):
        location = east_of_route(35.1, 1000)
        distance, t = point_to_segment_distance(
            (location.lat, location.lng), (35.0, ROUTE_LNG), (35.2, ROUTE_LNG)
        )
        assert distance == pytest.approx(1000, rel=0.01)
        assert t == pytest.approx(0.5, abs=1e-3)

    def test_point_beyond_the_end_uses_the_endpoint(self):
        distance, t = point_to_segment_distance((35.3, ROUTE_LNG), (35.0, ROUTE_LNG), (35.2, ROUTE_LNG))
        assert t == 1.0
        assert distance == pytest.approx(0.1 * math.radians(1) * 6_371_008.8, rel=0.01)

    def test_zero_length_segment_is_treated_as_a_point(self):
        distance, t = point_to_segment_distance((35.0, ROUTE_LNG), (35.1, ROUTE_LNG), (35.1, ROUTE_LNG))
        assert t == 0.0
        assert distance == pytest.approx(0.1 * math.radians(1) * 6_371_008.8, rel=0.01)


# --------------------------------------------------------------------------
# Candidate selection
# --------------------------------------------------------------------------


def straight_segments():
    route = straight_route_body()["routes"][0]
    return route_segments(route, 1200.0)


class TestFindPickupCandidates:
    def test_candidates_are_ordered_along_the_route_not_by_input_or_distance(self):
        near_end = PickupLocation("ゴール寄り", 35.19, ROUTE_LNG)
        near_start = east_of_route(35.02, 2500)
        middle = east_of_route(35.1, 10)

        found = find_pickup_candidates(straight_segments(), [near_end, middle, near_start], 3000)

        assert [entry[0].name for entry in found] == [near_start.name, middle.name, "ゴール寄り"]

    def test_three_km_boundary_is_inclusive(self):
        location = east_of_route(35.1, 3000)
        distance = find_pickup_candidates(straight_segments(), [location], 10_000)[0][1]

        assert find_pickup_candidates(straight_segments(), [location], distance)
        assert not find_pickup_candidates(straight_segments(), [location], distance - 0.001)

    def test_locations_farther_than_the_limit_are_excluded(self):
        inside = east_of_route(35.1, 2900)
        outside = east_of_route(35.1, 3100)

        found = find_pickup_candidates(straight_segments(), [inside, outside], 3000)

        assert [entry[0].name for entry in found] == [inside.name]

    def test_no_locations_near_the_route_returns_empty(self):
        assert find_pickup_candidates(straight_segments(), [east_of_route(35.1, 20_000)], 3000) == []

    def test_elapsed_time_is_interpolated_along_the_steps(self):
        # 35.05 is a quarter of the way along a route of two 600s steps.
        found = find_pickup_candidates(straight_segments(), [PickupLocation("q", 35.05, ROUTE_LNG)], 3000)
        _location, _distance, static_seconds, _along = found[0]
        assert static_seconds == pytest.approx(300, abs=1)


class TestRouteSegments:
    def test_falls_back_to_the_route_polyline_when_steps_are_missing(self):
        route = straight_route_body(steps=False)["routes"][0]

        segments = route_segments(route, 1200.0)

        assert segments[0].start == (ROUTE_START_LAT, ROUTE_LNG)
        assert segments[-1].end == (ROUTE_END_LAT, ROUTE_LNG)
        assert sum(s.seconds for s in segments) == pytest.approx(1200)

    def test_missing_geometry_is_a_502(self):
        route = {"duration": "60s", "distanceMeters": 1}
        with pytest.raises(RouteAnalysisError) as exc_info:
            route_segments(route, 60.0)
        assert exc_info.value.status_code == 502

    def test_malformed_polyline_is_a_502(self):
        route = {"legs": [{"steps": [{"staticDuration": "60s", "polyline": {"encodedPolyline": "_p~iF"}}]}]}
        with pytest.raises(RouteAnalysisError) as exc_info:
            route_segments(route, 60.0)
        assert exc_info.value.status_code == 502


# --------------------------------------------------------------------------
# analyze_route_with_pickups (Google mocked)
# --------------------------------------------------------------------------


class TestAnalyzeRouteWithPickups:
    def test_calls_google_once_without_forced_waypoint_and_with_route_field_mask(self):
        google = RecordingGoogle()
        locations = [east_of_route(35.05, 500), east_of_route(35.15, 500), PickupLocation("on", 35.1, ROUTE_LNG)]

        analyze_route_with_pickups(make_request(), "key", locations, 3000, client=google.client())

        assert len(google.requests) == 1
        sent = google.requests[0]
        body = httpx.Response(200, content=sent.content).json()
        assert "intermediates" not in body
        assert body["origin"] == {"address": "名古屋駅"}
        assert body["destination"] == {"address": "下呂温泉"}
        assert body["routingPreference"] == "TRAFFIC_AWARE"
        assert sent.headers["X-Goog-FieldMask"] == ROUTE_MODE_FIELD_MASK
        for field in ("routes.duration", "routes.staticDuration", "routes.distanceMeters", "routes.polyline.encodedPolyline"):
            assert field in ROUTE_MODE_FIELD_MASK.split(",")
        assert "routes.legs.steps.navigationInstruction" not in ROUTE_MODE_FIELD_MASK

    def test_origin_location_is_sent_as_lat_lng(self):
        google = RecordingGoogle()
        request = make_request(origin="現在地", origin_location={"lat": 35.01, "lng": 136.99})

        analyze_route_with_pickups(request, "key", [], 3000, client=google.client())

        body = httpx.Response(200, content=google.requests[0].content).json()
        assert body["origin"] == {"location": {"latLng": {"latitude": 35.01, "longitude": 136.99}}}

    def test_selects_the_first_candidate_along_the_route_with_pass_at(self):
        departure = datetime(2999, 1, 1, 9, 0, tzinfo=timezone(timedelta(hours=9)))
        request = make_request(departure_at=departure)
        first = east_of_route(35.05, 800)
        later = PickupLocation("later", 35.15, ROUTE_LNG)

        result = analyze_route_with_pickups(
            request, "key", [later, first], 3000, client=RecordingGoogle().client()
        )

        assert [c.name for c in result.pickup_candidates] == [first.name, "later"]
        assert result.pass_point == first.name
        assert (result.pass_point_lat, result.pass_point_lng) == (first.lat, first.lng)
        # quarter of 1200s static = 300s, times traffic factor 1440/1200 = 360s
        assert result.pass_at == result.pickup_candidates[0].pass_at
        assert (result.pass_at - departure).total_seconds() == pytest.approx(360, abs=2)
        assert result.pass_at.utcoffset() == timedelta(hours=9)
        assert result.pickup_candidates[0].distance_from_route_meters == pytest.approx(800, abs=10)
        assert result.total_duration_minutes == 24
        assert result.total_distance_meters == 22239

    def test_no_candidates_is_a_normal_result(self):
        result = analyze_route_with_pickups(
            make_request(), "key", [east_of_route(35.1, 50_000)], 3000, client=RecordingGoogle().client()
        )

        assert result.pass_point is None
        assert result.pass_at is None
        assert result.pass_point_lat is None and result.pass_point_lng is None
        assert result.pickup_candidates == []
        assert result.total_duration_minutes == 24

    def test_missing_api_key_is_503_without_calling_google(self):
        google = RecordingGoogle()
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route_with_pickups(make_request(), None, [], 3000, client=google.client())
        assert exc_info.value.status_code == 503
        assert google.requests == []

    def test_google_errors_keep_the_existing_mapping(self):
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route_with_pickups(
                make_request(), "key", [], 3000, client=RecordingGoogle(body={}, status_code=500).client()
            )
        assert exc_info.value.status_code == 502

    def test_empty_routes_is_a_502(self):
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route_with_pickups(make_request(), "key", [], 3000, client=RecordingGoogle(body={}).client())
        assert exc_info.value.status_code == 502


# --------------------------------------------------------------------------
# Request validation
# --------------------------------------------------------------------------


class TestOriginLocationValidation:
    def test_origin_location_is_optional(self):
        assert make_request().origin_location is None

    @pytest.mark.parametrize(
        "origin_location",
        [
            {"lat": 90.0001, "lng": 0},
            {"lat": -90.0001, "lng": 0},
            {"lat": 0, "lng": 180.0001},
            {"lat": 0, "lng": -180.0001},
            {"lat": float("nan"), "lng": 0},
            {"lat": 0, "lng": float("inf")},
            {"lat": 35.0},
            {"lat": "north", "lng": 137.0},
        ],
    )
    def test_invalid_origin_location_is_rejected(self, origin_location):
        with pytest.raises(ValidationError):
            make_request(origin_location=origin_location)

    @pytest.mark.parametrize("lat,lng", [(90, 180), (-90, -180), (35.1, 137.0)])
    def test_boundary_and_normal_values_are_accepted(self, lat, lng):
        assert make_request(origin_location={"lat": lat, "lng": lng}).origin_location.lat == lat


# --------------------------------------------------------------------------
# Endpoint: mode switch, caches
# --------------------------------------------------------------------------


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakePickupTable:
    def __init__(self, owner):
        self.owner = owner
        self.filters = []

    def select(self, fields):
        self.owner.selected_fields = fields
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def execute(self):
        self.owner.fetch_count += 1
        self.owner.last_filters = list(self.filters)
        if self.owner.fail:
            raise RuntimeError("db down")
        rows = self.owner.rows
        if ("is_active", True) in self.filters:
            rows = [r for r in rows if r.get("is_active", True)]
        return FakeResult([{k: r[k] for k in ("name", "latitude", "longitude") if k in r} for r in rows])


class FakeSupabase:
    def __init__(self, rows):
        self.rows = rows
        self.fetch_count = 0
        self.fail = False
        self.last_filters = None
        self.selected_fields = None

    def table(self, name):
        assert name == "pickup_locations"
        return FakePickupTable(self)


@pytest.fixture(autouse=True)
def reset_state(monkeypatch):
    main._route_analysis_request_log.clear()
    main._route_analysis_cache.clear()
    main._route_analysis_rate_limit_last_cleanup = 0.0
    main._route_analysis_cache_last_cleanup = 0.0
    main._pickup_locations_cache = None
    monkeypatch.setenv("ROUTE_ANALYSIS_CLIENT_KEY", "test-client-key")
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "test-google-key")
    monkeypatch.delenv("PICKUP_SELECTION_MODE", raising=False)
    monkeypatch.delenv("PICKUP_MAX_DISTANCE_METERS", raising=False)
    yield
    main._route_analysis_cache.clear()
    main._pickup_locations_cache = None


@pytest.fixture
def client():
    return TestClient(main.app)


HEADERS = {"X-Client-Key": "test-client-key"}


def payload(**overrides):
    data = {
        "origin": "名古屋駅",
        "destination": "下呂温泉",
        "departure_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    }
    data.update(overrides)
    return data


ACTIVE_ROWS = [
    {"name": "道の駅A", "latitude": 35.05, "longitude": ROUTE_LNG + 500 / METERS_PER_LNG_DEGREE, "is_active": True},
    {"name": "道の駅B", "latitude": 35.15, "longitude": ROUTE_LNG, "is_active": True},
    {"name": "休止中", "latitude": 35.1, "longitude": ROUTE_LNG, "is_active": False},
]


def use_route_mode_with_google(monkeypatch, rows=ACTIVE_ROWS, body=None):
    monkeypatch.setenv("PICKUP_SELECTION_MODE", "route")
    fake_db = FakeSupabase(rows)
    monkeypatch.setattr(main, "get_supabase", lambda: fake_db)
    google_calls = []
    real = route_analysis.analyze_route_with_pickups

    def fake_analyze(request, api_key, locations, max_distance):
        google_calls.append((request, locations, max_distance))
        google = RecordingGoogle(body=body)
        return real(request, api_key, locations, max_distance, client=google.client())

    monkeypatch.setattr(main, "analyze_route_with_pickups", fake_analyze)
    return fake_db, google_calls


class TestModeSwitch:
    def test_default_mode_is_fixed_and_unchanged(self, client, monkeypatch):
        called = {}

        def fake_fixed(request, api_key):
            called["fixed"] = True
            return RouteAnalysisResponse(
                origin=request.origin,
                destination=request.destination,
                pass_point=PASS_POINT,
                pass_at=request.departure_at + timedelta(minutes=60),
                total_duration_minutes=120,
                total_distance_meters=60000,
            )

        def must_not_run(*args, **kwargs):
            raise AssertionError("route mode must not run by default")

        monkeypatch.setattr(main, "analyze_route", fake_fixed)
        monkeypatch.setattr(main, "analyze_route_with_pickups", must_not_run)
        monkeypatch.setattr(main, "get_supabase", must_not_run)

        response = client.post("/routes/analyze", json=payload(), headers=HEADERS)

        assert response.status_code == 200
        body = response.json()
        assert called == {"fixed": True}
        assert body["pass_point"] == PASS_POINT
        assert body["pickup_candidates"] == []
        assert body["pass_point_lat"] is None and body["pass_point_lng"] is None

    @pytest.mark.parametrize("value", ["", "ROUTE-ish", "fixed", "unknown"])
    def test_unknown_mode_values_fall_back_to_fixed(self, monkeypatch, value):
        monkeypatch.setenv("PICKUP_SELECTION_MODE", value)
        assert main.get_pickup_selection_mode() == "fixed"

    def test_route_mode_value_is_case_insensitive(self, monkeypatch):
        monkeypatch.setenv("PICKUP_SELECTION_MODE", " Route ")
        assert main.get_pickup_selection_mode() == "route"

    @pytest.mark.parametrize(
        "value,expected",
        [(None, 3000.0), ("1500", 1500.0), ("abc", 3000.0), ("0", 3000.0), ("-5", 3000.0), ("inf", 3000.0), ("nan", 3000.0)],
    )
    def test_max_distance_env(self, monkeypatch, value, expected):
        if value is not None:
            monkeypatch.setenv("PICKUP_MAX_DISTANCE_METERS", value)
        assert main.get_pickup_max_distance_meters() == expected

    def test_fixed_mode_sends_origin_location_as_lat_lng_but_keeps_the_waypoint(self):
        google = RecordingGoogle(
            body={"routes": [{"duration": "600s", "distanceMeters": 100, "legs": [{"duration": "60s"}, {"duration": "540s"}]}]}
        )
        request = make_request(origin="現在地", origin_location={"lat": 35.0, "lng": 137.0})

        result = route_analysis.analyze_route(request, "key", client=google.client())

        body = httpx.Response(200, content=google.requests[0].content).json()
        assert body["origin"] == {"location": {"latLng": {"latitude": 35.0, "longitude": 137.0}}}
        assert body["intermediates"] == [{"address": PASS_POINT}]
        assert result.pass_point == PASS_POINT
        assert result.pickup_candidates == []


class TestRouteModeEndpoint:
    def test_returns_active_candidates_in_route_order(self, client, monkeypatch):
        fake_db, _calls = use_route_mode_with_google(monkeypatch)

        response = client.post("/routes/analyze", json=payload(), headers=HEADERS)

        assert response.status_code == 200
        body = response.json()
        assert [c["name"] for c in body["pickup_candidates"]] == ["道の駅A", "道の駅B"]
        assert body["pass_point"] == "道の駅A"
        assert body["pass_at"] == body["pickup_candidates"][0]["pass_at"]
        assert body["pass_point_lat"] == pytest.approx(35.05)
        assert ("is_active", True) in fake_db.last_filters
        assert fake_db.selected_fields == "name,latitude,longitude"

    def test_no_candidates_is_200_with_null_pass_point(self, client, monkeypatch):
        use_route_mode_with_google(monkeypatch, rows=[{"name": "遠い", "latitude": 36.5, "longitude": 139.0, "is_active": True}])

        response = client.post("/routes/analyze", json=payload(), headers=HEADERS)

        assert response.status_code == 200
        body = response.json()
        assert body["pass_point"] is None
        assert body["pass_at"] is None
        assert body["pickup_candidates"] == []

    def test_invalid_pickup_rows_are_skipped(self, client, monkeypatch):
        rows = [
            {"name": "", "latitude": 35.1, "longitude": ROUTE_LNG},
            {"name": "範囲外", "latitude": 91, "longitude": ROUTE_LNG},
            {"name": "型不正", "latitude": "35.1", "longitude": ROUTE_LNG},
            {"name": "正常", "latitude": 35.1, "longitude": ROUTE_LNG},
        ]
        use_route_mode_with_google(monkeypatch, rows=rows)

        response = client.post("/routes/analyze", json=payload(), headers=HEADERS)

        assert [c["name"] for c in response.json()["pickup_candidates"]] == ["正常"]

    def test_pickup_location_fetch_failure_is_502_and_not_cached(self, client, monkeypatch):
        fake_db, calls = use_route_mode_with_google(monkeypatch)
        fake_db.fail = True

        response = client.post("/routes/analyze", json=payload(), headers=HEADERS)

        assert response.status_code == 502
        assert response.json()["detail"] == "Failed to fetch pickup locations"
        assert calls == []
        assert main._pickup_locations_cache is None

    def test_invalid_origin_location_is_422(self, client, monkeypatch):
        use_route_mode_with_google(monkeypatch)

        response = client.post(
            "/routes/analyze", json=payload(origin_location={"lat": 123, "lng": 0}), headers=HEADERS
        )

        assert response.status_code == 422

    def test_pickup_locations_are_cached_between_analyses(self, client, monkeypatch):
        fake_db, calls = use_route_mode_with_google(monkeypatch)

        client.post("/routes/analyze", json=payload(destination="下呂温泉"), headers=HEADERS)
        client.post("/routes/analyze", json=payload(destination="高山駅"), headers=HEADERS)

        assert len(calls) == 2
        assert fake_db.fetch_count == 1

    def test_pickup_locations_cache_expires(self, client, monkeypatch):
        fake_db, _calls = use_route_mode_with_google(monkeypatch)
        now = [1000.0]
        monkeypatch.setattr(main.time, "monotonic", lambda: now[0])

        client.post("/routes/analyze", json=payload(destination="A"), headers=HEADERS)
        now[0] += main.PICKUP_LOCATIONS_CACHE_TTL_SECONDS + 1
        client.post("/routes/analyze", json=payload(destination="B"), headers=HEADERS)

        assert fake_db.fetch_count == 2


class TestRouteAnalysisCacheKey:
    def test_identical_request_with_origin_location_is_served_from_cache(self, client, monkeypatch):
        _db, calls = use_route_mode_with_google(monkeypatch)
        body = payload(origin="現在地", origin_location={"lat": 35.0, "lng": 137.0})

        client.post("/routes/analyze", json=body, headers=HEADERS)
        client.post("/routes/analyze", json=body, headers=HEADERS)

        assert len(calls) == 1

    def test_coordinates_within_rounding_share_the_cache(self, client, monkeypatch):
        _db, calls = use_route_mode_with_google(monkeypatch)
        departure = payload()["departure_at"]

        for lat in (35.00001, 35.00002):
            client.post(
                "/routes/analyze",
                json=payload(origin="現在地", departure_at=departure, origin_location={"lat": lat, "lng": 137.0}),
                headers=HEADERS,
            )

        assert len(calls) == 1

    def test_different_locations_do_not_share_the_cache(self, client, monkeypatch):
        _db, calls = use_route_mode_with_google(monkeypatch)
        departure = payload()["departure_at"]

        for lat in (35.0, 35.01):
            client.post(
                "/routes/analyze",
                json=payload(origin="現在地", departure_at=departure, origin_location={"lat": lat, "lng": 137.0}),
                headers=HEADERS,
            )

        assert len(calls) == 2

    def test_mode_is_part_of_the_cache_key(self, monkeypatch):
        request = make_request()
        fixed_key = main._route_analysis_cache_key(request)
        monkeypatch.setenv("PICKUP_SELECTION_MODE", "route")
        assert main._route_analysis_cache_key(request) != fixed_key

    def test_cache_key_has_no_raw_coordinates(self):
        request = make_request(origin_location={"lat": 35.123456789, "lng": 137.987654321})
        key = main._route_analysis_cache_key(request)
        assert (35.1235, 137.9877) in key
        assert "35.123456789" not in str(key)
