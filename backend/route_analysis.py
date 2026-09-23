"""Google Routes APIを使い、七宗の基準地点を通る時刻を算出する。

現段階のMVPでは、取得したpolylineが七宗を通るか空間的に判定するのではなく、
基準地点をintermediate stopoverとして経路に強制的に含めている。これにより実装を
小さく保ちながら、originから基準地点までの所要時間を独立したlegとして取得できる。

将来、利用者が本来選ぶ経路を変えずに七宗通過を判定する場合は、computeRoutesから
polylineを取得し、七宗の判定領域との交差を調べる実装へこのモジュール内で差し替える。
"""

import math
from datetime import timedelta, timezone
from typing import Any

import httpx

from models import RouteAnalysisRequest, RouteAnalysisResponse

ROUTES_API_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"

# MVPで七宗通過とみなす固定地点。intermediate stopoverに指定するため、Googleが
# origin -> PASS_POINT -> destinationの順で走行可能な経路を計算する。
PASS_POINT = "道の駅 ロック・ガーデンひちそう"

# X-Goog-FieldMaskにはレスポンスで実際に利用するフィールドだけを列挙する。
# 不要なpolylineや案内情報を取得せず、レスポンス量とGoogle側の処理を抑える。
FIELD_MASK = "routes.duration,routes.distanceMeters,routes.legs.duration"

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


def analyze_route(
    request: RouteAnalysisRequest,
    api_key: str | None,
    client: httpx.Client | None = None,
) -> RouteAnalysisResponse:
    """computeRoutesを呼び出し、七宗通過予定時刻と経路全体の値を返す。

    ``client`` は通常は省略し、この関数が生成したHTTPクライアントを使用する。
    引数として受け取れる形はGoogle通信をモックするテストのために用意している。
    """

    # API keyはブラウザへ渡さず、Backend環境変数から受け取った値だけをGoogleへの
    # X-Goog-Api-Keyヘッダーに設定する。未設定時は外部通信を行わず503にする。
    if not api_key:
        raise RouteAnalysisError(503, "Google Maps API key is not configured")

    # computeRoutesのdepartureTimeはRFC 3339のUTC時刻として送る。入力時のtimezoneは
    # Pydanticモデルで必須にしているため、利用者の意図した瞬間を失わず変換できる。
    departure_time = (
        request.departure_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    )
    payload = {
        "origin": {"address": request.origin},
        "destination": {"address": request.destination},
        # via指定のないintermediate waypointはstopoverとなり、その前後が別々の
        # routes.legsになる。MVPではこの仕様で七宗の基準地点を強制経由させる。
        "intermediates": [{"address": PASS_POINT}],
        # TrailDropの移動想定は自動車のためDRIVEに固定する。
        "travelMode": "DRIVE",
        # departureTimeを指定するには時刻を考慮するrouting modeが必要なため、
        # TRAFFIC_AWAREを使って出発予定時刻に応じた所要時間を取得する。
        "routingPreference": "TRAFFIC_AWARE",
        "departureTime": departure_time,
    }
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": FIELD_MASK,
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

    routes = data.get("routes")
    if not isinstance(routes, list) or not routes:
        raise RouteAnalysisError(502, "Google Routes API returned no routes")

    route = routes[0]
    legs = route.get("legs")
    # stopoverを1件指定しているため、origin -> 七宗と七宗 -> destinationの2 legsが
    # 必須。これを満たさないレスポンスから誤った通過時刻を算出しない。
    if not isinstance(legs, list) or len(legs) < 2:
        raise RouteAnalysisError(502, "Google Routes API returned insufficient route legs")

    # routes.legs[0].durationはoriginから最初のstopover（七宗基準地点）までの
    # 所要時間。出発日時へ加算した値をpass_atとして返す。
    first_leg_seconds = _duration_seconds(legs[0].get("duration"))
    total_seconds = _duration_seconds(route.get("duration"))
    total_distance = route.get("distanceMeters")
    if not isinstance(total_distance, int) or total_distance < 0:
        raise RouteAnalysisError(502, "Google Routes API returned an invalid distance")

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
