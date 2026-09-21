from datetime import datetime
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


class ReservationCreate(BaseModel):
    item_id: UUID
    user_name: str
    requested_at: datetime | None = None

    @field_validator("requested_at")
    @classmethod
    def requested_at_requires_timezone(cls, value: datetime | None):
        if value is not None and value.utcoffset() is None:
            raise ValueError("requested_at must include a timezone offset")
        return value


class ReservationResponse(BaseModel):
    id: UUID
    item_id: UUID
    user_name: str
    qr_token: UUID
    status: str
    requested_at: datetime | None = None
    reserved_at: datetime | None = None


class ReservationCreateResponse(ReservationResponse):
    access_token: UUID


class QRVerifyResponse(ReservationResponse):
    pass


class QRVerifyRequest(BaseModel):
    qr_token: UUID
