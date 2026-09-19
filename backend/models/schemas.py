from pydantic import BaseModel


class PickupReservation(BaseModel):
    id: int | None = None
    resource_type: str  # "firewood" or "gibier"
    quantity: int
    pickup_point: str
    scheduled_at: str
    user_name: str


class WorkshopReservation(BaseModel):
    id: int | None = None
    workshop_name: str
    scheduled_at: str
    participants: int
    user_name: str
