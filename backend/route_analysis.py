"""Google Routes APIを使い、受取地点の到着予定時刻を算出する。

2つのモードがある(backend/main.pyのPICKUP_SELECTION_MODEで切り替える)。

- fixed (既定・rollback用): 七宗の基準地点(PASS_POINT)をintermediate stopover
  として経路に強制的に含め、originから基準地点までのlegの所要時間から通過時刻を
  求める(従来のMVPの挙動)。
- route: 経由地を指定せず、利用者の実際の経路(origin -> destination)を1回だけ
  取得する。stepごとのpolylineと所要時間から、DBの受取地点(pickup_locations)の
  うち経路から一定距離以内のものを候補として選び、経路上の最近接地点への到着
  予定時刻を求める。候補ごとの追加のGoogle呼び出しは行わない。
"""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from models import PickupCandidate, RouteAnalysisRequest, RouteAnalysisResponse

ROUTES_API_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"

# MVPで七宗通過とみなす固定地点。intermediate stopoverに指定するため、Googleが
# origin -> PASS_POINT -> destinationの順で走行可能な経路を計算する。
PASS_POINT = "道の駅 ロック・ガーデンひちそう"

# X-Goog-FieldMaskにはレスポンスで実際に利用するフィールドだけを列挙する。
# 不要なpolylineや案内情報を取得せず、レスポンス量とGoogle側の処理を抑える。
FIELD_MASK = "routes.duration,routes.distanceMeters,routes.legs.duration"

# route mode用。経路全体の所要時間(交通考慮/非考慮)・距離・polylineと、
# 到着予定時刻の補間に使うstepの非交通考慮時間・距離・polylineだけを取得する
# (stepには交通考慮のdurationが無いため、routeのduration/staticDurationの比で補正する)。
ROUTE_MODE_FIELD_MASK = ",".join(
    [
        "routes.duration",
        "routes.staticDuration",
        "routes.distanceMeters",
        "routes.polyline.encodedPolyline",
        "routes.legs.steps.staticDuration",
        "routes.legs.steps.distanceMeters",
        "routes.legs.steps.polyline.encodedPolyline",
    ]
)

# GoogleのAPI基盤(認証・APIキー・quota・組織ポリシー等)起因のエラーには、
# google.rpc.ErrorInfoのdomainとして"googleapis.com"が付与される。このdomainは
# Google自身が「Service Infrastructure用に予約されている」と定義しており
# (参照: https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto)、
# 配下のreason(API_KEY_INVALID, RATE_LIMIT_EXCEEDED, SERVICE_DISABLED等、
# 実測ではAPIキーが無効な場合に"API_KEY_INVALID"が返ることを確認済み)は
# いずれもBackend運用者が対応すべき問題であり、origin/destination/
# departureTimeといった利用者の入力エラーではない。
# 個々のreason文字列を推測して列挙するのではなく、ドキュメントに根拠のある
# このdomainの有無だけで判定する。
_GOOGLE_SERVICE_INFRA_ERROR_DOMAIN = "googleapis.com"


def _is_google_service_infra_error(response: httpx.Response) -> bool:
    """GoogleのHTTP 400 INVALID_ARGUMENTが、APIキー・権限・quota等の
    Service Infrastructure(Backend側で対応すべき問題)に起因すると
    判断できた場合にTrueを返す。

    レスポンス本文を解釈できない場合や、想定外の形式だった場合は、
    Backendの設定ミスを利用者の入力エラー(422)として見せてしまわないよう、
    安全側に倒してTrue(=502として扱う)を返す。
    """

    try:
        body = response.json()
    except ValueError:
        return True
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return True
    for detail in error.get("details") or []:
        if isinstance(detail, dict) and detail.get("domain") == _GOOGLE_SERVICE_INFRA_ERROR_DOMAIN:
            return True
    return False


class RouteAnalysisError(Exception):
    """ルート分析で想定される失敗をFastAPIのHTTPステータスへ渡す例外。"""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def _duration_seconds(value: Any) -> float:
    """Routes APIのDuration文字列（例: ``"123.5s"``）を秒へ変換する。"""

    if not isinstance(value, str) or not value.endswith("s"):
        raise RouteAnalysisError(502, "Google Routes API returned an invalid duration")
    try:
        return float(value[:-1])
    except ValueError as exc:
        raise RouteAnalysisError(
            502, "Google Routes API returned an invalid duration"
        ) from exc


def _departure_time(request: RouteAnalysisRequest) -> str:
    # computeRoutesのdepartureTimeはRFC 3339のUTC時刻として送る。入力時のtimezoneは
    # Pydanticモデルで必須にしているため、利用者の意図した瞬間を失わず変換できる。
    return request.departure_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _origin_waypoint(request: RouteAnalysisRequest) -> dict[str, Any]:
    # 「現在地を使う」で座標が指定された場合は、表示用ラベルのoriginではなく
    # 座標を出発地として送る。指定が無ければ従来どおり住所文字列。
    if request.origin_location is not None:
        return {
            "location": {
                "latLng": {
                    "latitude": request.origin_location.lat,
                    "longitude": request.origin_location.lng,
                }
            }
        }
    return {"address": request.origin}


def _post_compute_routes(
    payload: dict[str, Any],
    field_mask: str,
    api_key: str | None,
    client: httpx.Client | None,
) -> dict[str, Any]:
    # API keyはブラウザへ渡さず、Backend環境変数から受け取った値だけをGoogleへの
    # X-Goog-Api-Keyヘッダーに設定する。未設定時は外部通信を行わず503にする。
    if not api_key:
        raise RouteAnalysisError(503, "Google Maps API key is not configured")

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": field_mask,
    }

    owns_client = client is None
    http_client = client or httpx.Client(timeout=15.0)
    try:
        response = http_client.post(ROUTES_API_URL, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPStatusError as exc:
        # GoogleのINVALID_ARGUMENT(400)は、解決できないorigin/destinationや
        # departureTimeがGoogle側の制約に合わない場合の他に、APIキーが無効/未許可
        # といったBackend設定の問題でも返ってくる(実測で確認済み)。後者を利用者の
        # 入力エラーとして422にすると障害を利用者のせいに見せてしまうため、
        # Service Infrastructure起因と判定できなかった場合のみ422にする。
        # 判定できない場合は502(外部API障害扱い)側へ倒し、Googleの生エラーは
        # どちらの場合も露出しない。
        if exc.response.status_code == 400 and not _is_google_service_infra_error(exc.response):
            raise RouteAnalysisError(
                422,
                "Origin, destination, or departure time is not valid for route "
                "calculation",
            ) from exc
        raise RouteAnalysisError(502, "Google Routes API request failed") from exc
    except (httpx.HTTPError, ValueError) as exc:
        # 上記以外の通信失敗（タイムアウト・接続不可）や不正JSONは、外部サービス
        # 障害として統一して502を返す。API key等の詳細は露出しない。
        raise RouteAnalysisError(502, "Google Routes API request failed") from exc
    finally:
        if owns_client:
            http_client.close()

    if not isinstance(data, dict):
        raise RouteAnalysisError(502, "Google Routes API returned no routes")
    return data


def _first_route(data: dict[str, Any]) -> dict[str, Any]:
    routes = data.get("routes")
    if not isinstance(routes, list) or not routes or not isinstance(routes[0], dict):
        raise RouteAnalysisError(502, "Google Routes API returned no routes")
    return routes[0]


def _total_distance(route: dict[str, Any]) -> int:
    total_distance = route.get("distanceMeters")
    if not isinstance(total_distance, int) or total_distance < 0:
        raise RouteAnalysisError(502, "Google Routes API returned an invalid distance")
    return total_distance


def analyze_route(
    request: RouteAnalysisRequest,
    api_key: str | None,
    client: httpx.Client | None = None,
) -> RouteAnalysisResponse:
    """fixed mode: computeRoutesを呼び出し、七宗通過予定時刻と経路全体の値を返す。

    ``client`` は通常は省略し、この関数が生成したHTTPクライアントを使用する。
    引数として受け取れる形はGoogle通信をモックするテストのために用意している。
    """

    payload = {
        "origin": _origin_waypoint(request),
        "destination": {"address": request.destination},
        # via指定のないintermediate waypointはstopoverとなり、その前後が別々の
        # routes.legsになる。fixed modeではこの仕様で七宗の基準地点を強制経由させる。
        "intermediates": [{"address": PASS_POINT}],
        # TrailDropの移動想定は自動車のためDRIVEに固定する。
        "travelMode": "DRIVE",
        # departureTimeを指定するには時刻を考慮するrouting modeが必要なため、
        # TRAFFIC_AWAREを使って出発予定時刻に応じた所要時間を取得する。
        "routingPreference": "TRAFFIC_AWARE",
        "departureTime": _departure_time(request),
    }
    data = _post_compute_routes(payload, FIELD_MASK, api_key, client)

    route = _first_route(data)
    legs = route.get("legs")
    # stopoverを1件指定しているため、origin -> 七宗と七宗 -> destinationの2 legsが
    # 必須。これを満たさないレスポンスから誤った通過時刻を算出しない。
    if not isinstance(legs, list) or len(legs) < 2:
        raise RouteAnalysisError(502, "Google Routes API returned insufficient route legs")

    # routes.legs[0].durationはoriginから最初のstopover（七宗基準地点）までの
    # 所要時間。出発日時へ加算した値をpass_atとして返す。
    first_leg_seconds = _duration_seconds(legs[0].get("duration"))
    total_seconds = _duration_seconds(route.get("duration"))
    total_distance = _total_distance(route)

    return RouteAnalysisResponse(
        origin=request.origin,
        destination=request.destination,
        pass_point=PASS_POINT,
        # 入力datetimeへtimedeltaを足すことで、レスポンスは入力側のtimezoneを維持する。
        pass_at=request.departure_at + timedelta(seconds=first_leg_seconds),
        # UIで扱いやすい整数分にするため、端数秒を切り捨てず切り上げる。
        total_duration_minutes=math.ceil(total_seconds / 60),
        total_distance_meters=total_distance,
    )


# ---------------------------------------------------------------------------
# route mode: 実際の経路から受取地点候補を選ぶ
# ---------------------------------------------------------------------------

EARTH_RADIUS_METERS = 6_371_008.8


@dataclass(frozen=True)
class PickupLocation:
    name: str
    lat: float
    lng: float


def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    """Encoded Polyline Algorithm Format(精度1e-5)を(lat, lng)のリストへ復号する。

    不正な文字列(途中で途切れている等)はValueErrorにする。
    """
    points: list[tuple[float, float]] = []
    index = 0
    lat = 0
    lng = 0
    length = len(encoded)
    while index < length:
        deltas = []
        for _ in range(2):
            shift = 0
            result = 0
            while True:
                if index >= length:
                    raise ValueError("truncated polyline")
                byte = ord(encoded[index]) - 63
                index += 1
                if byte < 0 or byte > 0x3F:
                    raise ValueError("invalid polyline character")
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat += deltas[0]
        lng += deltas[1]
        points.append((lat / 1e5, lng / 1e5))
    return points


def _to_local_xy(
    lat: float, lng: float, origin_lat: float, origin_lng: float
) -> tuple[float, float]:
    """origin周辺の平面近似(正距円筒図法)でメートル座標へ変換する。

    受取地点の判定距離は数km程度のため、この近似の誤差は判定に影響しない。
    """
    x = math.radians(lng - origin_lng) * math.cos(math.radians(origin_lat)) * EARTH_RADIUS_METERS
    y = math.radians(lat - origin_lat) * EARTH_RADIUS_METERS
    return x, y


def point_to_segment_distance(
    point: tuple[float, float],
    seg_start: tuple[float, float],
    seg_end: tuple[float, float],
) -> tuple[float, float]:
    """点から線分への最短距離(メートル)と、線分上の最近接点の位置(0〜1)を返す。

    すべて(lat, lng)。長さ0の線分は点として扱う(位置は0)。
    """
    ax, ay = _to_local_xy(*seg_start, *point)
    bx, by = _to_local_xy(*seg_end, *point)
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(ax, ay), 0.0
    # 点(=原点)から線分への射影位置
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / length_sq))
    return math.hypot(ax + t * dx, ay + t * dy), t


def _haversine_meters(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_METERS * math.asin(math.sqrt(min(1.0, h)))


@dataclass(frozen=True)
class RouteSegment:
    start: tuple[float, float]
    end: tuple[float, float]
    # 出発からこの線分の始点までの非交通考慮の所要秒数・経路上の距離(m)と、
    # この線分自体の所要秒数・長さ(m)
    start_seconds: float
    seconds: float
    start_along_meters: float
    length_meters: float


def _segments_from_polyline(
    points: list[tuple[float, float]],
    start_seconds: float,
    total_seconds: float,
    start_along_meters: float,
) -> list[RouteSegment]:
    """1本のpolylineを線分に分け、所要時間を各線分の長さに比例して割り振る。"""
    lengths = [_haversine_meters(points[i], points[i + 1]) for i in range(len(points) - 1)]
    polyline_length = sum(lengths)
    segments = []
    elapsed = start_seconds
    along = start_along_meters
    for i, length in enumerate(lengths):
        seconds = total_seconds * (length / polyline_length) if polyline_length > 0 else 0.0
        segments.append(RouteSegment(points[i], points[i + 1], elapsed, seconds, along, length))
        elapsed += seconds
        along += length
    return segments


def route_segments(route: dict[str, Any], static_total_seconds: float) -> list[RouteSegment]:
    """stepごとのpolyline・非交通考慮時間から、経路全体を時間付きの線分列にする。

    stepの情報が揃っていない場合は、経路全体のpolylineと全体の非交通考慮時間
    (距離比例)にfallbackする。どちらも無ければ502。
    """
    try:
        steps = [
            step
            for leg in route.get("legs") or []
            for step in (leg.get("steps") or [])
        ]
        segments: list[RouteSegment] = []
        elapsed = 0.0
        along = 0.0
        usable = bool(steps)
        for step in steps:
            encoded = (step.get("polyline") or {}).get("encodedPolyline")
            if not isinstance(encoded, str):
                usable = False
                break
            points = decode_polyline(encoded)
            step_seconds = _duration_seconds(step.get("staticDuration", "0s"))
            if len(points) >= 2:
                step_segments = _segments_from_polyline(points, elapsed, step_seconds, along)
                segments.extend(step_segments)
                along += sum(s.length_meters for s in step_segments)
            elapsed += step_seconds
        if usable and segments:
            return segments

        encoded = (route.get("polyline") or {}).get("encodedPolyline")
        if isinstance(encoded, str):
            points = decode_polyline(encoded)
            if len(points) >= 2:
                return _segments_from_polyline(points, 0.0, static_total_seconds, 0.0)
    except (AttributeError, TypeError, ValueError) as exc:
        raise RouteAnalysisError(
            502, "Google Routes API returned an invalid route geometry"
        ) from exc
    raise RouteAnalysisError(502, "Google Routes API returned an invalid route geometry")


def find_pickup_candidates(
    segments: list[RouteSegment],
    locations: list[PickupLocation],
    max_distance_meters: float,
) -> list[tuple[PickupLocation, float, float, float]]:
    """経路からmax_distance_meters以内(境界を含む)の受取地点を、経路上の順に返す。

    戻り値は(地点, 経路からの距離m, 出発からの非交通考慮秒数, 経路上の位置m)。
    経路上の複数箇所が同じ距離なら、先に出会う方を採用する。
    """
    found = []
    for location in locations:
        point = (location.lat, location.lng)
        best: tuple[float, float, float] | None = None
        for segment in segments:
            distance, t = point_to_segment_distance(point, segment.start, segment.end)
            if best is None or distance < best[0]:
                best = (
                    distance,
                    segment.start_seconds + segment.seconds * t,
                    segment.start_along_meters + segment.length_meters * t,
                )
        if best is not None and best[0] <= max_distance_meters:
            found.append((location, *best))
    found.sort(key=lambda entry: (entry[3], entry[0].name))
    return found


def _pass_at(departure_at: datetime, elapsed_seconds: float) -> datetime:
    # 入力datetimeへtimedeltaを足し、入力側のtimezoneを維持する(fixed modeと同じ)。
    return departure_at + timedelta(seconds=elapsed_seconds)


def analyze_route_with_pickups(
    request: RouteAnalysisRequest,
    api_key: str | None,
    pickup_locations: list[PickupLocation],
    max_distance_meters: float,
    client: httpx.Client | None = None,
) -> RouteAnalysisResponse:
    """route mode: 実際の経路を1回だけ取得し、経路周辺の受取地点候補を返す。

    候補が無いのは正常な結果として、pass_point/pass_atをNoneにして返す。
    """
    payload = {
        "origin": _origin_waypoint(request),
        "destination": {"address": request.destination},
        # 経由地は指定しない(利用者の実際の経路を取得する)。
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE",
        "departureTime": _departure_time(request),
        "polylineEncoding": "ENCODED_POLYLINE",
    }
    data = _post_compute_routes(payload, ROUTE_MODE_FIELD_MASK, api_key, client)

    route = _first_route(data)
    total_seconds = _duration_seconds(route.get("duration"))
    static_seconds = _duration_seconds(route.get("staticDuration", route.get("duration")))
    total_distance = _total_distance(route)
    segments = route_segments(route, static_seconds)

    # stepの時間は交通を考慮しないため、経路全体の交通考慮/非考慮の比で補正する。
    traffic_factor = total_seconds / static_seconds if static_seconds > 0 else 1.0

    candidates = [
        PickupCandidate(
            name=location.name,
            lat=location.lat,
            lng=location.lng,
            pass_at=_pass_at(request.departure_at, static_elapsed * traffic_factor),
            distance_from_route_meters=round(distance),
        )
        for location, distance, static_elapsed, _along in find_pickup_candidates(
            segments, pickup_locations, max_distance_meters
        )
    ]
    selected = candidates[0] if candidates else None

    return RouteAnalysisResponse(
        origin=request.origin,
        destination=request.destination,
        pass_point=selected.name if selected else None,
        pass_at=selected.pass_at if selected else None,
        pass_point_lat=selected.lat if selected else None,
        pass_point_lng=selected.lng if selected else None,
        pickup_candidates=candidates,
        total_duration_minutes=math.ceil(total_seconds / 60),
        total_distance_meters=total_distance,
    )
