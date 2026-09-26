from datetime import datetime, time, timedelta, timezone
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

# Frontendの氏名入力(Reservation.jsx、必須のtextフィールド)と揃える最大長。
USER_NAME_MAX_LENGTH = 100

# RouteTest.jsxのpickup windowは常にちょうど120分幅(WINDOW_DURATION_MINUTES)
# だが、offsetスライダー操作やクロックのずれを考慮し十分な余裕を持たせつつ、
# 直接APIを叩いた場合の「不自然に長い時間帯」を弾けるだけの上限にする。
PICKUP_WINDOW_MAX_DURATION = timedelta(hours=6)


class Item(BaseModel):
    id: UUID
    title: str
    type: str
    price: int
    stock: int
    location_name: str
    created_at: datetime | None = None
    # 非推奨: 受取場所は無人ロッカーで24時間受取可能なため、商品ごとの
    # 受取可能時間(営業時間)は廃止した。DBでは常にnullで、Frontendは
    # 参照しない(列はBackend/DBの同時デプロイを避けるために残しているだけ)。
    pickup_available_from: time | None = None
    pickup_available_to: time | None = None
    shop_id: UUID | None = None
    description: str | None = None
    category: str | None = None
    content_amount: str | None = None
    storage_method: str | None = None
    source_url: str | None = None
    price_note: str | None = None
    is_active: bool = True


# payment_methodは意図的にLiteral/enumにしていない。不正な値をpydanticの
# バリデーションエラー(422)にはせず、main.pyのcreate_reservation()内で
# VALID_PAYMENT_METHODSと突き合わせて400として扱うため(未指定もここでは
# 許可しておき、endpoint側で「未指定も不正」として同じ400にまとめる)。
class ReservationCreate(BaseModel):
    item_id: UUID
    user_name: str
    requested_at: datetime | None = None
    payment_method: str | None = None
    # RouteTestで選択した受取時間帯(2時間固定の枠)。requested_at(experience
    # 種別専用の単一時刻)とは別概念で、pickup/experienceどちらの種別でも
    # 設定できる。RouteTestを経由しない予約では両方Noneのまま。
    pickup_window_start: datetime | None = None
    pickup_window_end: datetime | None = None
    # 予約操作ごとにFrontendが生成するキー。タイムアウト後の再送などで同じ
    # キーが届いた場合、RPCは作成済みの予約をそのまま返す(在庫を二重に
    # 減らさない)。未指定の場合は従来どおり毎回新しい予約を作る。
    idempotency_key: UUID | None = None

    # Frontendは既にrequired属性で空文字を弾いているが、Backend側でも
    # trim・空白のみ・長すぎる値を422で拒否する(直接APIを叩いた場合の防御)。
    @field_validator("user_name")
    @classmethod
    def user_name_must_be_non_blank_and_sized(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("user_name must not be blank")
        if len(trimmed) > USER_NAME_MAX_LENGTH:
            raise ValueError(f"user_name must be at most {USER_NAME_MAX_LENGTH} characters")
        return trimmed

    @field_validator("requested_at")
    @classmethod
    def requested_at_requires_timezone(cls, value: datetime | None):
        if value is not None and value.utcoffset() is None:
            raise ValueError("requested_at must include a timezone offset")
        if value is not None and value <= datetime.now(timezone.utc):
            raise ValueError("requested_at must be in the future")
        return value

    # requested_atと同じくtimezone offset必須(naive datetimeは422で拒否)。
    # このフィールド単体のvalidatorをmodel_validator(下のordering check)
    # より先に走らせることで、tz-aware/naiveが混在した状態でstart>=endを
    # 比較してTypeErrorになり500が漏れる、という事態を未然に防ぐ
    # (Pydantic v2はfield_validatorが全て通ってからmodel_validator(mode=
    # "after")を実行するため、ここで拒否されればordering checkには到達
    # しない)。
    @field_validator("pickup_window_start", "pickup_window_end")
    @classmethod
    def pickup_window_requires_timezone(cls, value: datetime | None):
        if value is not None and value.utcoffset() is None:
            raise ValueError("pickup_window_start/pickup_window_end must include a timezone offset")
        return value

    # pickup_window_start/endはRPC(create_reservation_with_stock)側でも
    # reservations_pickup_window_consistent制約で二重に検証されるが、ここで
    # 先に弾くことでBackend/DBの往復なしに422で拒否できる(requested_atの
    # バリデーションと同じ、フィールド単体では表現できないルールのため
    # model_validatorを使う)。
    @model_validator(mode="after")
    def pickup_window_must_be_fully_specified_and_ordered(self):
        start = self.pickup_window_start
        end = self.pickup_window_end
        if (start is None) != (end is None):
            raise ValueError(
                "pickup_window_start and pickup_window_end must both be set or both be omitted"
            )
        if start is not None and end is not None:
            if start >= end:
                raise ValueError("pickup_window_start must be before pickup_window_end")
            # PMレビューBLOCKER B1: startが未来であることまでは要求しない。
            # RouteTest.jsxのオフセットスライダー(±180分、変更しない仕様)は
            # windowStart = pass_at + (offset - 60分)を計算するため、pass_at
            # が近い将来(例: 30分後)でoffsetを大きくマイナス側に振ると、
            # windowStartだけが既に過去になるのは正常な操作の結果であり、
            # これを拒否すると既存のオフセット機能を壊してしまう。
            # 「受取時間帯として完全に無効」と言えるのは、終了時刻(end)まで
            # 過ぎてしまった場合(= start <= end <= now)のみ。
            # start <= now < end(受取枠の途中に差し掛かっている)は許可する。
            if end <= datetime.now(timezone.utc):
                raise ValueError("pickup window has already ended")
            # RouteTest.jsxの受取枠は常にちょうど120分幅(offsetで枠自体が伸び
            # 縮みすることはない)。それを大きく超える幅は直接APIを叩いた場合
            # などの不自然な値とみなし、余裕を持たせた上限で拒否する。
            if end - start > PICKUP_WINDOW_MAX_DURATION:
                raise ValueError("pickup window is too long")
        return self


class ReservationItem(BaseModel):
    """予約照会に必要な、公開状態に左右されない最小の商品情報。"""

    id: UUID
    title: str
    location_name: str
    pickup_available_from: time | None = None
    pickup_available_to: time | None = None


class ReservationResponse(BaseModel):
    id: UUID
    item_id: UUID
    user_name: str
    qr_token: UUID
    status: str
    requested_at: datetime | None = None
    reserved_at: datetime | None = None
    # payment_method/payment_statusは予約のstatus(pending/completed/cancelled)
    # とは別の関心事(支払い方法のモックと、その決済状態)。両方とも
    # reservationsテーブルの実カラムで、Noneは「この予約が作られた時点では
    # 支払い情報を持っていなかった」(cancellation migration以前の既存予約)
    # ことを表す。
    payment_method: str | None = None
    payment_status: str | None = None
    # RouteTestで選択した受取時間帯。両方Noneなら「未設定」(この機能追加
    # 以前の既存予約、またはRouteTestを経由しない予約)。
    pickup_window_start: datetime | None = None
    pickup_window_end: datetime | None = None


class ReservationDetailResponse(ReservationResponse):
    # 予約済み商品の表示にGET /itemsを使うと、後からinactiveになった商品を
    # 表示できない。予約へのアクセス権を確認した同じレスポンスに、必要最小限
    # の商品情報だけを含める。予約作成・キャンセル・QR verifyの既存レスポンス
    # にはこのフィールドを追加せず、今回の変更を予約照会APIだけに限定する。
    item: ReservationItem | None = None


class ReservationCreateResponse(ReservationResponse):
    access_token: UUID


class QRVerifyResponse(ReservationResponse):
    pass


# スタッフ向け予約確認(GET /staff/reservations/{id})専用のレスポンス。
# 読み取り専用の確認用途なので、ReservationResponseは継承せず返す項目を
# 明示する。access_token(顧客の照会用)とqr_token(受取完了に使う秘密情報)
# は絶対に含めない。qr_tokenを返すと、予約IDだけでQR受取確認まで通せて
# しまうため。item_titleはBackend側でitemsテーブルから引いて埋める。
class StaffReservationResponse(BaseModel):
    id: UUID
    item_id: UUID
    item_title: str | None = None
    user_name: str
    status: str
    requested_at: datetime | None = None
    reserved_at: datetime | None = None
    payment_method: str | None = None
    payment_status: str | None = None
    pickup_window_start: datetime | None = None
    pickup_window_end: datetime | None = None


class QRVerifyRequest(BaseModel):
    qr_token: UUID


# PMレビューm-3: 顧客氏名での検索はGETのクエリパラメータではなくPOST+JSON
# bodyで送る(氏名がURL・アクセスログに残らないようにするため)。
class StaffReservationSearchRequest(BaseModel):
    user_name: str


# POST /staff/reservations/expire-stale の応答。取消した予約のIDのみを返し
# (StaffReservationResponseと同じくaccess_token/qr_tokenは含めない)、
# 何件処理したかをexpired_countで明示する。
class ExpiredReservationsResponse(BaseModel):
    expired_count: int
    expired_ids: list[UUID]


ROUTE_LOCATION_MIN_LENGTH = 1
ROUTE_LOCATION_MAX_LENGTH = 200


class LatLng(BaseModel):
    # 範囲外・NaN/Infinityは422で拒否する。
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lng: float = Field(ge=-180, le=180, allow_inf_nan=False)


class RouteAnalysisRequest(BaseModel):
    origin: str
    destination: str
    departure_at: datetime
    # RouteTestの「現在地を使う」で取得した端末の現在地。指定された場合は
    # originの文字列(表示用ラベル)ではなくこの座標を出発地としてGoogleに
    # 送る。DB保存・ログ出力はしない。
    origin_location: LatLng | None = None

    @field_validator("origin", "destination")
    @classmethod
    def location_must_be_trimmed_and_sized(cls, value: str) -> str:
        trimmed = value.strip()
        if not (ROUTE_LOCATION_MIN_LENGTH <= len(trimmed) <= ROUTE_LOCATION_MAX_LENGTH):
            raise ValueError(
                f"must be between {ROUTE_LOCATION_MIN_LENGTH} and "
                f"{ROUTE_LOCATION_MAX_LENGTH} characters after trimming"
            )
        return trimmed

    @field_validator("departure_at")
    @classmethod
    def departure_at_requires_timezone(cls, value: datetime):
        if value.utcoffset() is None:
            raise ValueError("departure_at must include a timezone offset")
        if value <= datetime.now(timezone.utc):
            raise ValueError("departure_at must be in the future")
        return value


class PickupCandidate(BaseModel):
    """ルートから一定距離以内にある受取地点の候補(route mode)。"""

    name: str
    lat: float
    lng: float
    # ルート上で、この受取地点に最も近い地点への到着予定時刻(目安)。
    # 受取地点への実際の寄り道時間は含まない。
    pass_at: datetime
    distance_from_route_meters: int


class RouteAnalysisResponse(BaseModel):
    origin: str
    destination: str
    # 選択中(初期値はルート上で最初に出会う候補)の受取地点。route modeで
    # 候補が1件も無い場合はpass_point/pass_atともにNone(正常な結果)。
    # fixed modeでは従来どおり七宗の固定地点(座標は持たないためlat/lngはNone)。
    pass_point: str | None
    pass_at: datetime | None
    pass_point_lat: float | None = None
    pass_point_lng: float | None = None
    # route順に並んだ候補。fixed modeでは常に空。
    pickup_candidates: list[PickupCandidate] = []
    total_duration_minutes: int
    total_distance_meters: int
