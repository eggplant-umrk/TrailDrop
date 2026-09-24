from datetime import datetime, time, timezone
from uuid import UUID

from pydantic import BaseModel, field_validator


class Item(BaseModel):
    id: UUID
    title: str
    type: str
    price: int
    stock: int
    location_name: str
    created_at: datetime | None = None
    # 商品の受取可能時間(毎日繰り返す時間帯)。どちらかがNoneの場合は
    # 「受取可能時間が未設定」を意味し、「常に受取可能」とは解釈しない
    # (Frontend側の時間帯フィルタで、未設定の商品は表示対象から除外する)。
    pickup_available_from: time | None = None
    pickup_available_to: time | None = None


# payment_methodは意図的にLiteral/enumにしていない。不正な値をpydanticの
# バリデーションエラー(422)にはせず、main.pyのcreate_reservation()内で
# VALID_PAYMENT_METHODSと突き合わせて400として扱うため(未指定もここでは
# 許可しておき、endpoint側で「未指定も不正」として同じ400にまとめる)。
class ReservationCreate(BaseModel):
    item_id: UUID
    user_name: str
    requested_at: datetime | None = None
    payment_method: str | None = None

    @field_validator("requested_at")
    @classmethod
    def requested_at_requires_timezone(cls, value: datetime | None):
        if value is not None and value.utcoffset() is None:
            raise ValueError("requested_at must include a timezone offset")
        if value is not None and value <= datetime.now(timezone.utc):
            raise ValueError("requested_at must be in the future")
        return value


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


class QRVerifyRequest(BaseModel):
    qr_token: UUID


ROUTE_LOCATION_MIN_LENGTH = 1
ROUTE_LOCATION_MAX_LENGTH = 200


class RouteAnalysisRequest(BaseModel):
    origin: str
    destination: str
    departure_at: datetime

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


class RouteAnalysisResponse(BaseModel):
    origin: str
    destination: str
    pass_point: str
    pass_at: datetime
    total_duration_minutes: int
    total_distance_meters: int
