import os
import secrets
import threading
import time
from uuid import UUID

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from supabase import Client, create_client

from models import (
    ExpiredReservationsResponse,
    Item,
    QRVerifyRequest,
    QRVerifyResponse,
    ReservationCreate,
    ReservationCreateResponse,
    ReservationResponse,
    RouteAnalysisRequest,
    RouteAnalysisResponse,
    StaffReservationResponse,
    StaffReservationSearchRequest,
)
from route_analysis import RouteAnalysisError, analyze_route

load_dotenv()


def get_allowed_origins() -> list[str]:
    configured_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173")
    return [origin.strip() for origin in configured_origins.split(",") if origin.strip()]


app = FastAPI(title="TrailDrop API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# create_client()はHTTPコネクションプールを内部に持つため、リクエストの
# たびに新規生成すると無駄にコネクションを張り直すことになる。supabase-py
# のClientはリクエストごとに独立したHTTP呼び出しを行うだけで、複数
# リクエストにまたがる可変状態を持たないため、プロセス内でsingletonとして
# 安全に使い回せる。テストはmain.get_supabase自体をmonkeypatchで丸ごと
# 差し替えるため、このキャッシュの影響を受けない。
_supabase_client: Client | None = None
_supabase_client_lock = threading.Lock()


def get_supabase() -> Client:
    global _supabase_client
    if _supabase_client is not None:
        return _supabase_client
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(
            status_code=503,
            detail="SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured",
        )
    with _supabase_client_lock:
        if _supabase_client is None:
            _supabase_client = create_client(url, key)
    return _supabase_client


# staff系エンドポイント(受取確認・予約照会・予約者名検索・期限切れ一括処理)
# 全てに共通のbrute-force対策。IP単位で「認証失敗(不正/欠落したX-Staff-
# Token)」の回数だけを数え、STAFF_API_TOKENの総当たりを遅くする(完全に
# 防ぐものではないが、レート制限が全く無い状態からの改善)。
# PMレビューm-b: 正しいトークンでの通常操作(連続したQR受取確認など)は
# カウントしない。店舗の同一NAT配下にいる複数のスタッフ端末が、正常な
# 操作だけで429になることを避けるため。ただし直近の失敗が上限に達した
# IPは、トークンの正誤に関わらずwindowが明けるまで429にする(正しいトー
# クンだけ通すと、総当たり中に正解を引いた瞬間に通ってしまい制限の意味が
# 無くなるため)。トークン自体はレスポンス・ログのどちらにも出力しない
# (既存どおり)。
STAFF_AUTH_RATE_LIMIT = 20
STAFF_AUTH_RATE_WINDOW_SECONDS = 60.0
STAFF_AUTH_RATE_LIMIT_CLEANUP_INTERVAL_SECONDS = STAFF_AUTH_RATE_WINDOW_SECONDS
_staff_auth_rate_lock = threading.Lock()
_staff_auth_failure_log: dict[str, list[float]] = {}
_staff_auth_rate_limit_last_cleanup = 0.0


def _cleanup_staff_auth_rate_limit_locked(now: float) -> None:
    global _staff_auth_rate_limit_last_cleanup
    if now - _staff_auth_rate_limit_last_cleanup < STAFF_AUTH_RATE_LIMIT_CLEANUP_INTERVAL_SECONDS:
        return
    window_start = now - STAFF_AUTH_RATE_WINDOW_SECONDS
    stale_ips = [
        ip
        for ip, timestamps in _staff_auth_failure_log.items()
        if not any(t > window_start for t in timestamps)
    ]
    for ip in stale_ips:
        del _staff_auth_failure_log[ip]
    _staff_auth_rate_limit_last_cleanup = now


def check_staff_auth_rate_limit(client_ip: str) -> None:
    """直近の認証失敗が上限に達していれば429。ここでは何も記録しない。"""
    now = time.monotonic()
    window_start = now - STAFF_AUTH_RATE_WINDOW_SECONDS
    with _staff_auth_rate_lock:
        _cleanup_staff_auth_rate_limit_locked(now)
        recent = [t for t in _staff_auth_failure_log.get(client_ip, []) if t > window_start]
        if recent:
            _staff_auth_failure_log[client_ip] = recent
        else:
            _staff_auth_failure_log.pop(client_ip, None)
        if len(recent) >= STAFF_AUTH_RATE_LIMIT:
            raise HTTPException(
                status_code=429,
                detail="Too many staff authentication attempts. Please try again later.",
            )


def record_staff_auth_failure(client_ip: str) -> None:
    now = time.monotonic()
    window_start = now - STAFF_AUTH_RATE_WINDOW_SECONDS
    with _staff_auth_rate_lock:
        recent = [t for t in _staff_auth_failure_log.get(client_ip, []) if t > window_start]
        recent.append(now)
        _staff_auth_failure_log[client_ip] = recent


def require_staff_token(token: str | None, client_ip: str) -> None:
    check_staff_auth_rate_limit(client_ip)
    expected_token = os.getenv("STAFF_API_TOKEN")
    if not expected_token:
        # サーバー側の設定不備であり、クライアントの認証失敗ではないため
        # 失敗回数には数えない。
        raise HTTPException(status_code=503, detail="Staff authentication is not configured")
    if not token or not secrets.compare_digest(token, expected_token):
        record_staff_auth_failure(client_ip)
        raise HTTPException(status_code=401, detail="Invalid staff token")


# /routes/analyzeは一般利用者向けの公開画面(/route-test)から呼ばれるため、
# スタッフ専用のSTAFF_API_TOKENは再利用できない。ROUTE_ANALYSIS_CLIENT_KEYは
# ブラウザに埋め込まれる前提の値であり秘匿は期待できないが、/docsからエンドポイント
# を見つけて叩くだけの無差別botや直接curlを弾き、下のレート制限と組み合わせて
# Google Routes APIのquota消費・想定外課金のリスクを下げる。
def get_trusted_proxy_ips() -> set[str]:
    configured = os.getenv("TRUSTED_PROXY_IPS", "")
    return {ip.strip() for ip in configured.split(",") if ip.strip()}


# reverse proxy配下では request.client.host が全リクエストで同一(proxyの
# アドレス)になり、IP単位のレート制限が実質無効化されてしまう。
# TRUSTED_PROXY_IPS に明示的に列挙されたIPからの接続に限り、
# X-Forwarded-For を信頼して実クライアントIPを取り出す。
#
# PMレビューm-4: このロジックは「TCP接続元からアプリまでの間に、信頼できる
# reverse proxyがちょうど1台だけ挟まる」構成を前提にしている(詳細は
# .env.example の TRUSTED_PROXY_IPS の説明を参照)。この前提の下では、
# X-Forwarded-Forのうち安全に信頼できるのは「その1台のproxyが自分の直接の
# 接続元として書き足した値」だけであり、それはヘッダの最右端になる
# (多くのproxyはクライアントから届いたX-Forwarded-Forを上書きせず、自分が
# 見た接続元IPを既存の値の末尾に追記する設定がデフォルトのため)。最左端を
# 採用すると、悪意あるクライアントが最初から
# `X-Forwarded-For: 1.2.3.4, ...` を付けてリクエストを送った場合に、
# proxyが末尾に追記した本当の接続元IPではなく偽装された1.2.3.4を信頼して
# しまう(なりすまし)。そのため最右端を採用する。
# 未設定時やTCP接続元がリストに無い場合は request.client.host を使う
# (今までと同じ安全な挙動)。任意のクライアントがX-Forwarded-Forを
# 偽装しても、信頼されたproxyを経由しない限りこの値は使われない。
def resolve_client_ip(http_request: Request) -> str:
    direct_ip = http_request.client.host if http_request.client else None
    trusted_proxies = get_trusted_proxy_ips()
    if direct_ip and trusted_proxies and direct_ip in trusted_proxies:
        forwarded_for = http_request.headers.get("X-Forwarded-For")
        if forwarded_for:
            last_hop = forwarded_for.split(",")[-1].strip()
            if last_hop:
                return last_hop
    return direct_ip or "unknown"


def require_route_analysis_client_key(client_key: str | None) -> None:
    expected_key = os.getenv("ROUTE_ANALYSIS_CLIENT_KEY")
    if not expected_key:
        raise HTTPException(
            status_code=503, detail="Route analysis authentication is not configured"
        )
    if not client_key or not secrets.compare_digest(client_key, expected_key):
        raise HTTPException(status_code=401, detail="Invalid route analysis client key")


# 単一プロセス構成のためインメモリでIP単位のスライディングウィンドウ制限を行う。
# 複数プロセス/インスタンスへスケールする場合はRedis等の共有ストアへ移行が必要。
ROUTE_ANALYSIS_RATE_LIMIT = 10
ROUTE_ANALYSIS_RATE_WINDOW_SECONDS = 60.0
# 期限切れIPエントリの一掃(cleanup)を実行する最短間隔。リクエストのたびに全IPを
# 掃除すると計算量がリクエスト数に比例してしまうため、この間隔に達した時だけ
# 全体を掃除する。ウィンドウと同じ長さにすることで、非アクティブなIPのエントリが
# 最大でもウィンドウ2つ分程度しかメモリに残らないようにする。
ROUTE_ANALYSIS_RATE_LIMIT_CLEANUP_INTERVAL_SECONDS = ROUTE_ANALYSIS_RATE_WINDOW_SECONDS
_route_analysis_rate_lock = threading.Lock()
_route_analysis_request_log: dict[str, list[float]] = {}
_route_analysis_rate_limit_last_cleanup = 0.0


def _cleanup_route_analysis_rate_limit_locked(now: float) -> None:
    """呼び出し元で_route_analysis_rate_lockを保持している前提の内部関数。
    ウィンドウ内に有効なリクエストが1件もないIPのエントリを削除する。
    """

    global _route_analysis_rate_limit_last_cleanup
    if now - _route_analysis_rate_limit_last_cleanup < ROUTE_ANALYSIS_RATE_LIMIT_CLEANUP_INTERVAL_SECONDS:
        return
    window_start = now - ROUTE_ANALYSIS_RATE_WINDOW_SECONDS
    stale_ips = [
        ip
        for ip, timestamps in _route_analysis_request_log.items()
        if not any(t > window_start for t in timestamps)
    ]
    for ip in stale_ips:
        del _route_analysis_request_log[ip]
    _route_analysis_rate_limit_last_cleanup = now


def enforce_route_analysis_rate_limit(client_ip: str) -> None:
    now = time.monotonic()
    window_start = now - ROUTE_ANALYSIS_RATE_WINDOW_SECONDS
    with _route_analysis_rate_lock:
        _cleanup_route_analysis_rate_limit_locked(now)
        recent = [t for t in _route_analysis_request_log.get(client_ip, []) if t > window_start]
        if len(recent) >= ROUTE_ANALYSIS_RATE_LIMIT:
            _route_analysis_request_log[client_ip] = recent
            raise HTTPException(
                status_code=429,
                detail="Too many route analysis requests. Please try again later.",
            )
        recent.append(now)
        _route_analysis_request_log[client_ip] = recent


# 同一条件(origin/destination/departure_at)の短時間キャッシュ。連続クリックや
# 同一条件の再試行でGoogle Routes APIを重複して呼ばないようにする。
#
# 「同一条件」とは以下の3つが一致することを指す。
#   - trim済みのorigin文字列が完全一致 (Pydanticのvalidatorで既にtrim済み)
#   - trim済みのdestination文字列が完全一致
#   - departure_atが指す瞬間(instant)が一致
# departure_atは`.timestamp()`(UTC基準のPOSIXタイムスタンプ)で比較する。これは
# "+09:00"表記と"+00:00"表記など、同じ瞬間を異なるtimezone表記で送った場合でも
# 正しく同一条件と判定するための正規化であり、実際に異なる出発時刻を同一視する
# ものではない(1秒でもずれれば別キーになる)。origin/destinationの表記や
# departure_atの値そのものを書き換えたり丸めたりすることはない。
ROUTE_ANALYSIS_CACHE_TTL_SECONDS = 60.0
# キャッシュのcleanupもレート制限と同じ考え方で、TTLと同じ間隔でしか全体を
# 掃除しない。
ROUTE_ANALYSIS_CACHE_CLEANUP_INTERVAL_SECONDS = ROUTE_ANALYSIS_CACHE_TTL_SECONDS
_route_analysis_cache_lock = threading.Lock()
_route_analysis_cache: dict[tuple[str, str, float], tuple[float, RouteAnalysisResponse]] = {}
_route_analysis_cache_last_cleanup = 0.0


def _route_analysis_cache_key(request: RouteAnalysisRequest) -> tuple[str, str, float]:
    return (request.origin, request.destination, request.departure_at.timestamp())


def _cleanup_route_analysis_cache_locked(now: float) -> None:
    """呼び出し元で_route_analysis_cache_lockを保持している前提の内部関数。
    TTLを超えたキャッシュエントリを削除する。
    """

    global _route_analysis_cache_last_cleanup
    if now - _route_analysis_cache_last_cleanup < ROUTE_ANALYSIS_CACHE_CLEANUP_INTERVAL_SECONDS:
        return
    expired_keys = [
        key
        for key, (cached_at, _response) in _route_analysis_cache.items()
        if now - cached_at > ROUTE_ANALYSIS_CACHE_TTL_SECONDS
    ]
    for key in expired_keys:
        del _route_analysis_cache[key]
    _route_analysis_cache_last_cleanup = now


def get_cached_route_analysis(key: tuple[str, str, float]) -> RouteAnalysisResponse | None:
    now = time.monotonic()
    with _route_analysis_cache_lock:
        _cleanup_route_analysis_cache_locked(now)
        entry = _route_analysis_cache.get(key)
        if entry is None:
            return None
        cached_at, cached_response = entry
        if now - cached_at > ROUTE_ANALYSIS_CACHE_TTL_SECONDS:
            del _route_analysis_cache[key]
            return None
        return cached_response


def store_route_analysis_cache(key: tuple[str, str, float], response: RouteAnalysisResponse) -> None:
    with _route_analysis_cache_lock:
        _route_analysis_cache[key] = (time.monotonic(), response)


# 実決済は行わないモック決済。フロントで選べる方法をここで一元管理し、
# create_reservation()側でPydanticのバリデーション(422)ではなくここで
# 明示的に400として弾く。
VALID_PAYMENT_METHODS = {"paypay", "credit_card"}


def reservation_error(exc: Exception) -> HTTPException:
    code = getattr(exc, "code", "")
    message = getattr(exc, "message", str(exc))
    if "EXPERIENCE_DATE_REQUIRED" in message:
        return HTTPException(status_code=422, detail="Experience date is required")
    if "REQUESTED_AT_IN_PAST" in message:
        return HTTPException(status_code=422, detail="Requested date must be in the future")
    # RPC側でもpayment_methodを再検証している(defense in depth)。通常は
    # create_reservation()のVALID_PAYMENT_METHODSチェックで先に400になる
    # ため、ここに到達するのはRPCを直接叩いた場合などの想定外経路のみ。
    if "INVALID_PAYMENT_METHOD" in message:
        return HTTPException(status_code=400, detail="Invalid payment method")
    if code == "P0002" or "ITEM_NOT_FOUND" in message:
        return HTTPException(status_code=404, detail="Item not found")
    if code == "P0001" or "OUT_OF_STOCK" in message:
        return HTTPException(status_code=409, detail="Item is out of stock")
    # 23514 = PostgreSQLのcheck_violation。reservations_pickup_window_
    # consistent制約(models.pyのバリデーションと同じルール)に引っかかった
    # 場合で、通常はBackend側のmodel_validatorで先に弾かれるため、ここに
    # 到達するのはRPCを直接叩いた場合などの想定外経路のみ(defense in
    # depth)。ここで拾わないと下のフォールバック(502)になり、Frontend側は
    # 「予約されたか分からない」曖昧な失敗として扱ってしまう
    # (DEFINITELY_NOT_CREATED_STATUSESに422はあるが502は無いため)。
    if code == "23514":
        return HTTPException(status_code=422, detail="Pickup window is invalid")
    return HTTPException(status_code=502, detail="Failed to create reservation")


def cancel_reservation_error(exc: Exception) -> HTTPException:
    code = getattr(exc, "code", "")
    message = getattr(exc, "message", str(exc))
    # "RESERVATION_NOT_FOUND"はid・access_tokenの組が一致しない場合に使われる。
    # get_reservation()と同じく、存在しないidと不正なtokenを区別しない
    # (予約の存在を推測できないようにするため)。
    if code == "P0003" or "RESERVATION_NOT_FOUND" in message:
        return HTTPException(status_code=404, detail="Reservation not found")
    # completed/cancelled済みなど、pending以外からのキャンセルは全てこちらになる。
    # どちらの状態からの拒否かをここで区別する必要はない。
    if code == "P0004" or "RESERVATION_NOT_CANCELLABLE" in message:
        return HTTPException(status_code=409, detail="Reservation cannot be cancelled")
    return HTTPException(status_code=502, detail="Failed to cancel reservation")


def require_valid_uuid(value: str) -> None:
    # FastAPIのpath/header型をUUIDにすると不正な値で422になってしまうため、
    # ここで手動検証して404にする(予約不存在と同じ扱いにするため)。
    # reservation_idだけでなくaccess_token(X-Reservation-Token)も同じ経路で
    # RPCに渡っており、どちらが不正な形式でもPostgres側の22P02がそのまま
    # 漏れるのを防ぐ。
    try:
        UUID(value)
    except ValueError:
        raise HTTPException(status_code=404, detail="Reservation not found")


@app.get("/items", response_model=list[Item])
def list_items():
    try:
        response = get_supabase().table("items").select("*").execute()
        return response.data
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to fetch items") from exc


@app.post("/reservations", response_model=ReservationCreateResponse, status_code=201)
def create_reservation(reservation: ReservationCreate):
    # 未指定・不正な値のどちらも同じ400として扱う(PayPay/クレジットカード
    # のどちらかを必須選択、という仕様に対して一貫したエラーにするため)。
    if reservation.payment_method not in VALID_PAYMENT_METHODS:
        raise HTTPException(status_code=400, detail="Invalid payment method")
    try:
        response = (
            get_supabase()
            .rpc(
                "create_reservation_with_stock",
                {
                    "p_item_id": str(reservation.item_id),
                    "p_user_name": reservation.user_name,
                    "p_requested_at": (
                        reservation.requested_at.isoformat()
                        if reservation.requested_at is not None
                        else None
                    ),
                    "p_payment_method": reservation.payment_method,
                    "p_pickup_window_start": (
                        reservation.pickup_window_start.isoformat()
                        if reservation.pickup_window_start is not None
                        else None
                    ),
                    "p_pickup_window_end": (
                        reservation.pickup_window_end.isoformat()
                        if reservation.pickup_window_end is not None
                        else None
                    ),
                },
            )
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=502, detail="Failed to create reservation")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise reservation_error(exc) from exc


@app.get("/reservations/{reservation_id}", response_model=ReservationResponse)
def get_reservation(
    reservation_id: str,
    x_reservation_token: str | None = Header(default=None, alias="X-Reservation-Token"),
):
    if not x_reservation_token:
        raise HTTPException(status_code=404, detail="Reservation not found")
    # cancel_reservation/get_staff_reservationと同じ方式でUUID形式を検証する。
    # 検証せずにDBへ渡すと、Postgresの22P02(invalid input syntax for type
    # uuid)が生の例外として漏れ、下のexcept Exceptionで502になってしまう。
    require_valid_uuid(reservation_id)
    require_valid_uuid(x_reservation_token)
    try:
        response = (
            get_supabase()
            .table("reservations")
            .select("*")
            .eq("id", reservation_id)
            .eq("access_token", x_reservation_token)
            .limit(1)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Reservation not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to fetch reservation") from exc


@app.post("/reservations/{reservation_id}/cancel", response_model=ReservationResponse)
def cancel_reservation(
    reservation_id: str,
    x_reservation_token: str | None = Header(default=None, alias="X-Reservation-Token"),
):
    # get_reservation()と同じ理由で、tokenが無い場合は404にして
    # (401ではなく)予約の存在自体を推測できないようにする。
    if not x_reservation_token:
        raise HTTPException(status_code=404, detail="Reservation not found")
    require_valid_uuid(reservation_id)
    require_valid_uuid(x_reservation_token)
    try:
        # status更新と在庫返却はcancel_reservation_with_stock RPC内で1つの
        # トランザクションとして原子的に行う(行ロックにより二重キャンセルでの
        # 在庫の二重返却を防ぐ)。Backend側では分割しない。
        response = (
            get_supabase()
            .rpc(
                "cancel_reservation_with_stock",
                {
                    "p_reservation_id": reservation_id,
                    "p_access_token": x_reservation_token,
                },
            )
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=502, detail="Failed to cancel reservation")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise cancel_reservation_error(exc) from exc


@app.post("/qr/verify", response_model=QRVerifyResponse)
def verify_qr(
    request: QRVerifyRequest,
    http_request: Request,
    x_staff_token: str | None = Header(default=None, alias="X-Staff-Token"),
):
    require_staff_token(x_staff_token, resolve_client_ip(http_request))
    try:
        supabase = get_supabase()

        # cancelled予約はpendingと同じ「未完了」に見えてしまうため、更新を
        # 試みる前に現在のstatusを見て、pending以外(completed/cancelled)を
        # 明示的に区別して拒否する。これにより、cancelled予約が誤って
        # completedへ更新されることは絶対にない。
        existing = (
            supabase
            .table("reservations")
            .select("status")
            .eq("qr_token", str(request.qr_token))
            .limit(1)
            .execute()
        )
        if not existing.data:
            raise HTTPException(status_code=404, detail="QR token not found")

        current_status = existing.data[0]["status"]
        if current_status == "cancelled":
            raise HTTPException(status_code=409, detail="Reservation is cancelled")
        if current_status == "completed":
            raise HTTPException(status_code=409, detail="Reservation is already completed")

        response = (
            supabase
            .table("reservations")
            .update({"status": "completed"})
            .eq("qr_token", str(request.qr_token))
            .eq("status", "pending")
            .execute()
        )
        if response.data:
            return response.data[0]

        # 上のselectとこのupdateの間にstatusが変わった場合(競合)のフォール
        # バック。updateは常に.eq("status", "pending")付きなので、pending
        # 以外に変わっていれば0件のままここに来る。もう一度現在のstatusを
        # 見て、どちらの理由で拒否するか判定する。
        refreshed = (
            supabase
            .table("reservations")
            .select("status")
            .eq("qr_token", str(request.qr_token))
            .limit(1)
            .execute()
        )
        if not refreshed.data:
            raise HTTPException(status_code=404, detail="QR token not found")
        if refreshed.data[0]["status"] == "cancelled":
            raise HTTPException(status_code=409, detail="Reservation is cancelled")
        raise HTTPException(status_code=409, detail="Reservation is already completed")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to verify QR token") from exc


@app.get("/staff/reservations/{reservation_id}", response_model=StaffReservationResponse)
def get_staff_reservation(
    reservation_id: str,
    http_request: Request,
    x_staff_token: str | None = Header(default=None, alias="X-Staff-Token"),
):
    # X-Reservation-Tokenは使わない(顧客用の予約照会とは別の認可軸)。
    # スタッフはX-Staff-Tokenのみで、どの予約でも参照できる。
    require_staff_token(x_staff_token, resolve_client_ip(http_request))
    require_valid_uuid(reservation_id)
    try:
        supabase = get_supabase()
        response = (
            supabase
            .table("reservations")
            .select("*")
            .eq("id", reservation_id)
            .limit(1)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Reservation not found")
        reservation = response.data[0]

        # 商品名の取得に失敗しても予約情報自体の表示は妨げない
        # (ReservationComplete.jsx/StaffVerify.jsxの既存の商品名解決と同じ
        # フォールバック方針)。access_token・qr_tokenはStaffReservationResponse
        # に定義していないため、reservationが実際は持っていても
        # response_modelによって自動的に除外される。
        item_title = None
        try:
            item_response = (
                supabase
                .table("items")
                .select("title")
                .eq("id", reservation["item_id"])
                .limit(1)
                .execute()
            )
            if item_response.data:
                item_title = item_response.data[0]["title"]
        except Exception:
            item_title = None

        return {**reservation, "item_title": item_title}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to fetch reservation") from exc


# 曖昧な失敗(POST /reservationsが502等で終わった場合)で予約IDが分からない
# 顧客に対し、現地スタッフが安全に予約を探せるようにする読み取り専用検索。
# 予約者名の部分一致のみを検索キーにする(他の利用者の予約を不用意に一覧化
# しないよう、空文字・1文字だけの検索は拒否し、件数もSTAFF_SEARCH_MAX_
# RESULTSで打ち切る)。X-Staff-Tokenは必須。パス名を/staff/reservations-
# searchにしているのは、/staff/reservations/{reservation_id}という既存の
# パスパラメータ付きルートと衝突しないようにするため。
# PMレビューm-3: 顧客の氏名がURL・アクセスログに残らないよう、GETの
# クエリパラメータではなくPOST + JSON bodyにする。
STAFF_SEARCH_MIN_QUERY_LENGTH = 2
STAFF_SEARCH_MAX_RESULTS = 20


# PMレビューm-3: ilikeのパターン中でユーザー入力がそのままワイルドカード
# として解釈されないようにエスケープする。対象は、SQLのLIKE/ILIKEが特別
# 扱いする"%"・"_"、PostgRESTがilikeのURL値中で"%"の代わりとして解釈する
# "*"、そしてエスケープ文字そのものである"\"(先にエスケープしないと、後段
# で挿入する"\"と衝突して意図しない解釈になる)。デフォルトのSQL ESCAPE文字
# は"\"のため、追加のESCAPE句指定は不要。
def escape_ilike_wildcards(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
        .replace("*", "\\*")
    )


@app.post("/staff/reservations-search", response_model=list[StaffReservationResponse])
def search_staff_reservations(
    http_request: Request,
    payload: StaffReservationSearchRequest,
    x_staff_token: str | None = Header(default=None, alias="X-Staff-Token"),
):
    require_staff_token(x_staff_token, resolve_client_ip(http_request))
    trimmed_query = payload.user_name.strip()
    if len(trimmed_query) < STAFF_SEARCH_MIN_QUERY_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"user_name must be at least {STAFF_SEARCH_MIN_QUERY_LENGTH} characters",
        )
    try:
        supabase = get_supabase()
        response = (
            supabase
            .table("reservations")
            .select("*")
            # ilikeは大文字小文字を区別しない部分一致。前後の%はこの検索自体の
            # 「部分一致」を表す意図的なワイルドカードで、trimmed_query内の
            # 文字は全てescape_ilike_wildcardsでエスケープ済み。
            .ilike("user_name", f"%{escape_ilike_wildcards(trimmed_query)}%")
            .order("reserved_at", desc=True)
            .limit(STAFF_SEARCH_MAX_RESULTS)
            .execute()
        )
        reservations = response.data or []

        # item_titleの解決はget_staff_reservationと同じ「失敗しても予約情報
        # 自体は返す」方針。N+1を避けるため、対象item_idをまとめて1回で取得
        # する。
        item_ids = {r["item_id"] for r in reservations if r.get("item_id")}
        item_titles: dict[str, str] = {}
        if item_ids:
            try:
                items_response = (
                    supabase.table("items").select("id,title").in_("id", list(item_ids)).execute()
                )
                item_titles = {row["id"]: row["title"] for row in items_response.data or []}
            except Exception:
                item_titles = {}

        return [
            {**r, "item_title": item_titles.get(r.get("item_id"))} for r in reservations
        ]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail="Failed to search reservations"
        ) from exc


@app.post("/staff/reservations/expire-stale", response_model=ExpiredReservationsResponse)
def expire_stale_reservations(
    http_request: Request,
    x_staff_token: str | None = Header(default=None, alias="X-Staff-Token"),
):
    # 自動実行基盤(cron等)はこのリポジトリに無いため、本番では外部の定期
    # 実行からこのAPI(またはRPCを直接)呼び出す(運用手順はREADMEの
    # 「期限切れ予約の自動キャンセル」を参照)。pickup_window_endから猶予
    # 30分を過ぎてもpendingのままの予約をcancelledにして在庫を返す。
    # pickup_window_endを記録していない予約(RouteTestを経由しない予約)は
    # 対象外で、statusがpending以外の予約にも影響しない。1回の呼び出しで
    # 最大500件(RPCのbatch_size)。
    require_staff_token(x_staff_token, resolve_client_ip(http_request))
    try:
        response = get_supabase().rpc("expire_stale_pending_reservations", {}).execute()
        expired = response.data or []
        return ExpiredReservationsResponse(
            expired_count=len(expired),
            expired_ids=[row["id"] for row in expired],
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail="Failed to expire stale reservations"
        ) from exc


@app.post("/routes/analyze", response_model=RouteAnalysisResponse)
def analyze_route_endpoint(
    request: RouteAnalysisRequest,
    http_request: Request,
    x_client_key: str | None = Header(default=None, alias="X-Client-Key"),
):
    require_route_analysis_client_key(x_client_key)

    client_ip = resolve_client_ip(http_request)
    enforce_route_analysis_rate_limit(client_ip)

    cache_key = _route_analysis_cache_key(request)
    cached_response = get_cached_route_analysis(cache_key)
    if cached_response is not None:
        return cached_response

    try:
        response = analyze_route(request, os.getenv("GOOGLE_MAPS_API_KEY"))
    except RouteAnalysisError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    store_route_analysis_cache(cache_key, response)
    return response
