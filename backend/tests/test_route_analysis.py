from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import main
from models import RouteAnalysisRequest, RouteAnalysisResponse
from route_analysis import RouteAnalysisError, analyze_route

FUTURE = datetime.now(timezone.utc) + timedelta(days=1)
PAST = datetime.now(timezone.utc) - timedelta(days=1)

VALID_PAYLOAD = {
    "origin": "名古屋駅",
    "destination": "下呂温泉",
    "departure_at": FUTURE.isoformat(),
}


def make_request(**overrides):
    data = {"origin": "名古屋駅", "destination": "下呂温泉", "departure_at": FUTURE}
    data.update(overrides)
    return RouteAnalysisRequest(**data)


def fake_route_response(request):
    return RouteAnalysisResponse(
        origin=request.origin,
        destination=request.destination,
        pass_point="道の駅 ロック・ガーデンひちそう",
        pass_at=request.departure_at,
        total_duration_minutes=42,
        total_distance_meters=1000,
    )


def mock_google_client(status_code, json_body):
    def handler(request):
        return httpx.Response(status_code, json=json_body)

    return httpx.Client(transport=httpx.MockTransport(handler))


class FakeClock:
    """time.monotonic()互換の呼び出し可能オブジェクト。テストからadvance()で
    経過時間を明示的に進められるようにし、TTL/レート制限のcleanupを
    実際にsleepすることなく検証する。
    """

    def __init__(self, start: float = 0.0):
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


class TestRouteAnalysisRequestValidation:
    def test_trims_origin_and_destination(self):
        request = RouteAnalysisRequest(
            origin="  名古屋駅  ", destination="  下呂温泉 ", departure_at=FUTURE
        )
        assert request.origin == "名古屋駅"
        assert request.destination == "下呂温泉"

    @pytest.mark.parametrize("value", ["", "   ", "\t\n"])
    def test_rejects_empty_or_whitespace_origin(self, value):
        with pytest.raises(ValidationError):
            make_request(origin=value)

    @pytest.mark.parametrize("value", ["", "   ", "\t\n"])
    def test_rejects_empty_or_whitespace_destination(self, value):
        with pytest.raises(ValidationError):
            make_request(destination=value)

    def test_rejects_origin_over_max_length(self):
        with pytest.raises(ValidationError):
            make_request(origin="a" * 201)

    def test_rejects_past_departure_at(self):
        with pytest.raises(ValidationError):
            make_request(departure_at=PAST)

    def test_rejects_naive_departure_at(self):
        with pytest.raises(ValidationError):
            make_request(departure_at=datetime.now() + timedelta(days=1))


class TestAnalyzeRouteGoogleErrorHandling:
    def test_missing_api_key_returns_503(self):
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route(make_request(), api_key=None)
        assert exc_info.value.status_code == 503

    def test_google_400_invalid_argument_without_infra_domain_maps_to_422(self):
        # A plain INVALID_ARGUMENT with no googleapis.com ErrorInfo detail (the
        # documented "Service Infrastructure" domain) has no signal that it's a
        # credentials/quota/policy problem, so it's treated as a genuine
        # origin/destination/departureTime input error.
        body = {
            "error": {
                "code": 400,
                "message": "The origin, destination or one or more waypoints could "
                "not be geocoded.",
                "status": "INVALID_ARGUMENT",
            }
        }
        client = mock_google_client(400, body)
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route(make_request(), api_key="test-key", client=client)
        assert exc_info.value.status_code == 422

    def test_google_400_does_not_leak_raw_error_detail(self):
        client = mock_google_client(400, {"error": {"message": "secret internal detail"}})
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route(make_request(), api_key="test-key", client=client)
        assert exc_info.value.status_code == 422
        assert "secret internal detail" not in exc_info.value.detail

    def test_google_400_with_invalid_api_key_stays_502(self):
        # Real response body captured from Google Routes API for an invalid key.
        # ErrorInfo.domain == "googleapis.com" is Google's documented marker for
        # Service Infrastructure errors (API key/permission/quota/policy), so this
        # must never be classified as a user input problem even though Google
        # reports it as HTTP 400 INVALID_ARGUMENT.
        body = {
            "error": {
                "code": 400,
                "message": "API key not valid. Please pass a valid API key.",
                "status": "INVALID_ARGUMENT",
                "details": [
                    {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        "reason": "API_KEY_INVALID",
                        "domain": "googleapis.com",
                    }
                ],
            }
        }
        client = mock_google_client(400, body)
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route(make_request(), api_key="test-key", client=client)
        assert exc_info.value.status_code == 502

    def test_google_400_unparseable_body_fails_safe_to_502(self):
        # If we can't parse/understand the error body at all, default to 502
        # rather than risk showing "your input is wrong" for what might be a
        # backend configuration problem we failed to recognize.
        def handler(request):
            return httpx.Response(400, content=b"not json")

        client = httpx.Client(transport=httpx.MockTransport(handler))
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route(make_request(), api_key="test-key", client=client)
        assert exc_info.value.status_code == 502

    def test_google_403_stays_502(self):
        client = mock_google_client(403, {"error": {"message": "permission denied"}})
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route(make_request(), api_key="test-key", client=client)
        assert exc_info.value.status_code == 502

    def test_google_429_stays_502(self):
        client = mock_google_client(
            429, {"error": {"message": "quota exceeded", "status": "RESOURCE_EXHAUSTED"}}
        )
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route(make_request(), api_key="test-key", client=client)
        assert exc_info.value.status_code == 502

    def test_google_500_stays_502(self):
        client = mock_google_client(500, {"error": {"message": "boom"}})
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route(make_request(), api_key="test-key", client=client)
        assert exc_info.value.status_code == 502

    def test_network_failure_maps_to_502(self):
        def handler(request):
            raise httpx.ConnectError("connection failed", request=request)

        client = httpx.Client(transport=httpx.MockTransport(handler))
        with pytest.raises(RouteAnalysisError) as exc_info:
            analyze_route(make_request(), api_key="test-key", client=client)
        assert exc_info.value.status_code == 502

    def test_successful_response_computes_pass_at_and_totals(self):
        body = {
            "routes": [
                {
                    "duration": "3600s",
                    "distanceMeters": 50000,
                    "legs": [{"duration": "1200s"}, {"duration": "2400s"}],
                }
            ]
        }
        client = mock_google_client(200, body)
        request = make_request()
        result = analyze_route(request, api_key="test-key", client=client)
        assert result.total_duration_minutes == 60
        assert result.total_distance_meters == 50000
        assert result.pass_at == request.departure_at + timedelta(seconds=1200)


def _reset_route_analysis_module_state():
    main._route_analysis_request_log.clear()
    main._route_analysis_cache.clear()
    main._route_analysis_rate_limit_last_cleanup = 0.0
    main._route_analysis_cache_last_cleanup = 0.0


@pytest.fixture(autouse=True)
def reset_route_analysis_state(monkeypatch):
    _reset_route_analysis_module_state()
    monkeypatch.setenv("ROUTE_ANALYSIS_CLIENT_KEY", "test-client-key")
    yield
    _reset_route_analysis_module_state()


@pytest.fixture
def client():
    return TestClient(main.app)


class TestRouteAnalyzeEndpointAuth:
    def test_missing_client_key_is_rejected(self, client):
        response = client.post("/routes/analyze", json=VALID_PAYLOAD)
        assert response.status_code == 401

    def test_wrong_client_key_is_rejected(self, client):
        response = client.post(
            "/routes/analyze", json=VALID_PAYLOAD, headers={"X-Client-Key": "wrong"}
        )
        assert response.status_code == 401

    def test_unconfigured_client_key_returns_503(self, client, monkeypatch):
        monkeypatch.delenv("ROUTE_ANALYSIS_CLIENT_KEY", raising=False)
        response = client.post(
            "/routes/analyze", json=VALID_PAYLOAD, headers={"X-Client-Key": "anything"}
        )
        assert response.status_code == 503

    def test_correct_client_key_succeeds(self, client, monkeypatch):
        monkeypatch.setattr(main, "analyze_route", lambda request, api_key: fake_route_response(request))
        response = client.post(
            "/routes/analyze",
            json=VALID_PAYLOAD,
            headers={"X-Client-Key": "test-client-key"},
        )
        assert response.status_code == 200
        assert response.json()["total_duration_minutes"] == 42


class TestRouteAnalyzeEndpointValidation:
    @pytest.mark.parametrize("origin", ["", "   "])
    def test_empty_or_blank_origin_returns_422(self, client, origin):
        payload = {**VALID_PAYLOAD, "origin": origin}
        response = client.post(
            "/routes/analyze", json=payload, headers={"X-Client-Key": "test-client-key"}
        )
        assert response.status_code == 422

    @pytest.mark.parametrize("destination", ["", "   "])
    def test_empty_or_blank_destination_returns_422(self, client, destination):
        payload = {**VALID_PAYLOAD, "destination": destination}
        response = client.post(
            "/routes/analyze", json=payload, headers={"X-Client-Key": "test-client-key"}
        )
        assert response.status_code == 422

    def test_over_max_length_origin_returns_422(self, client):
        payload = {**VALID_PAYLOAD, "origin": "a" * 201}
        response = client.post(
            "/routes/analyze", json=payload, headers={"X-Client-Key": "test-client-key"}
        )
        assert response.status_code == 422

    def test_past_departure_at_returns_422(self, client):
        payload = {**VALID_PAYLOAD, "departure_at": PAST.isoformat()}
        response = client.post(
            "/routes/analyze", json=payload, headers={"X-Client-Key": "test-client-key"}
        )
        assert response.status_code == 422


class TestRouteAnalyzeRateLimit:
    def test_exceeding_rate_limit_returns_429(self, client, monkeypatch):
        monkeypatch.setattr(main, "analyze_route", lambda request, api_key: fake_route_response(request))
        headers = {"X-Client-Key": "test-client-key"}

        for _ in range(main.ROUTE_ANALYSIS_RATE_LIMIT):
            response = client.post("/routes/analyze", json=VALID_PAYLOAD, headers=headers)
            assert response.status_code == 200

        response = client.post("/routes/analyze", json=VALID_PAYLOAD, headers=headers)
        assert response.status_code == 429


class TestRouteAnalyzeCaching:
    def test_identical_request_uses_cache_without_recalling_google(self, client, monkeypatch):
        call_count = {"n": 0}

        def fake_analyze_route(request, api_key):
            call_count["n"] += 1
            return fake_route_response(request)

        monkeypatch.setattr(main, "analyze_route", fake_analyze_route)
        headers = {"X-Client-Key": "test-client-key"}

        first = client.post("/routes/analyze", json=VALID_PAYLOAD, headers=headers)
        second = client.post("/routes/analyze", json=VALID_PAYLOAD, headers=headers)

        assert first.status_code == 200
        assert second.status_code == 200
        assert call_count["n"] == 1

    def test_same_instant_different_utc_offset_hits_cache(self, client, monkeypatch):
        # "same condition" is defined as the departure INSTANT matching, not the
        # literal string. These two payloads name the same moment in time via two
        # different UTC offsets and must share one cache entry.
        call_count = {"n": 0}

        def fake_analyze_route(request, api_key):
            call_count["n"] += 1
            return fake_route_response(request)

        monkeypatch.setattr(main, "analyze_route", fake_analyze_route)
        headers = {"X-Client-Key": "test-client-key"}

        jst = timezone(timedelta(hours=9))
        payload_utc = {**VALID_PAYLOAD, "departure_at": FUTURE.isoformat()}
        payload_jst = {
            **VALID_PAYLOAD,
            "departure_at": FUTURE.astimezone(jst).isoformat(),
        }
        assert payload_utc["departure_at"] != payload_jst["departure_at"]

        first = client.post("/routes/analyze", json=payload_utc, headers=headers)
        second = client.post("/routes/analyze", json=payload_jst, headers=headers)

        assert first.status_code == 200
        assert second.status_code == 200
        assert call_count["n"] == 1

    def test_different_departure_at_does_not_share_cache(self, client, monkeypatch):
        # Cache correctness: requests that differ by even one second must not be
        # treated as the same condition or return each other's cached result.
        call_count = {"n": 0}

        def fake_analyze_route(request, api_key):
            call_count["n"] += 1
            return fake_route_response(request)

        monkeypatch.setattr(main, "analyze_route", fake_analyze_route)
        headers = {"X-Client-Key": "test-client-key"}

        payload_a = {**VALID_PAYLOAD}
        payload_b = {**VALID_PAYLOAD, "departure_at": (FUTURE + timedelta(seconds=1)).isoformat()}

        first = client.post("/routes/analyze", json=payload_a, headers=headers)
        second = client.post("/routes/analyze", json=payload_b, headers=headers)

        assert first.status_code == 200
        assert second.status_code == 200
        assert call_count["n"] == 2

    def test_cache_expires_after_ttl_and_calls_google_again(self, client, monkeypatch):
        clock = FakeClock(1_000.0)
        monkeypatch.setattr(main.time, "monotonic", clock)

        call_count = {"n": 0}

        def fake_analyze_route(request, api_key):
            call_count["n"] += 1
            return fake_route_response(request)

        monkeypatch.setattr(main, "analyze_route", fake_analyze_route)
        headers = {"X-Client-Key": "test-client-key"}

        first = client.post("/routes/analyze", json=VALID_PAYLOAD, headers=headers)
        assert first.status_code == 200
        assert call_count["n"] == 1

        clock.advance(main.ROUTE_ANALYSIS_CACHE_TTL_SECONDS + 1)

        second = client.post("/routes/analyze", json=VALID_PAYLOAD, headers=headers)
        assert second.status_code == 200
        assert call_count["n"] == 2


class TestRouteAnalyzeCleanup:
    def test_rate_limit_log_does_not_grow_unbounded(self, monkeypatch):
        clock = FakeClock(0.0)
        monkeypatch.setattr(main.time, "monotonic", clock)

        for i in range(50):
            main.enforce_route_analysis_rate_limit(f"203.0.113.{i}")
        assert len(main._route_analysis_request_log) == 50

        # Move well past the rate window + cleanup interval so every entry
        # above is stale, then make one more request from a fresh IP.
        clock.advance(
            main.ROUTE_ANALYSIS_RATE_WINDOW_SECONDS
            + main.ROUTE_ANALYSIS_RATE_LIMIT_CLEANUP_INTERVAL_SECONDS
            + 1
        )
        main.enforce_route_analysis_rate_limit("203.0.113.999")

        # The 50 stale IPs were cleaned up; only the just-seen IP remains.
        assert len(main._route_analysis_request_log) == 1
        assert list(main._route_analysis_request_log.keys()) == ["203.0.113.999"]

    def test_cache_does_not_grow_unbounded(self, monkeypatch):
        clock = FakeClock(0.0)
        monkeypatch.setattr(main.time, "monotonic", clock)

        for i in range(50):
            key = (f"Origin {i}", f"Destination {i}", float(i))
            main.store_route_analysis_cache(key, fake_route_response(make_request()))
        assert len(main._route_analysis_cache) == 50

        clock.advance(
            main.ROUTE_ANALYSIS_CACHE_TTL_SECONDS
            + main.ROUTE_ANALYSIS_CACHE_CLEANUP_INTERVAL_SECONDS
            + 1
        )

        # A single lookup (miss) triggers a cleanup sweep of all stale entries.
        assert main.get_cached_route_analysis(("new", "key", 999.0)) is None
        assert len(main._route_analysis_cache) == 0
