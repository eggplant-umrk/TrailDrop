from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


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


class ReservationResponse(BaseModel):
    id: UUID
    item_id: UUID
    user_name: str
    qr_token: UUID
    status: str
    reserved_at: datetime | None = None


class QRVerifyRequest(BaseModel):
    qr_token: UUID
