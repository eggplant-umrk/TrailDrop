from datetime import datetime, timezone
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


class ReservationCreateResponse(ReservationResponse):
    access_token: UUID


class QRVerifyResponse(ReservationResponse):
    pass


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
