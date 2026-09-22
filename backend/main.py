import os
import secrets

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import Client, create_client

from models import (
    Item,
    QRVerifyRequest,
    QRVerifyResponse,
    ReservationCreate,
    ReservationCreateResponse,
    ReservationResponse,
)

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


def get_supabase() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(
            status_code=503,
            detail="SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured",
        )
    return create_client(url, key)


def require_staff_token(token: str | None) -> None:
    expected_token = os.getenv("STAFF_API_TOKEN")
    if not expected_token:
        raise HTTPException(status_code=503, detail="Staff authentication is not configured")
    if not token or not secrets.compare_digest(token, expected_token):
        raise HTTPException(status_code=401, detail="Invalid staff token")


def reservation_error(exc: Exception) -> HTTPException:
    code = getattr(exc, "code", "")
    message = getattr(exc, "message", str(exc))
    if "EXPERIENCE_DATE_REQUIRED" in message:
        return HTTPException(status_code=422, detail="Experience date is required")
    if "REQUESTED_AT_IN_PAST" in message:
        return HTTPException(status_code=422, detail="Requested date must be in the future")
    if code == "P0002" or "ITEM_NOT_FOUND" in message:
        return HTTPException(status_code=404, detail="Item not found")
    if code == "P0001" or "OUT_OF_STOCK" in message:
        return HTTPException(status_code=409, detail="Item is out of stock")
    return HTTPException(status_code=502, detail="Failed to create reservation")


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


@app.post("/qr/verify", response_model=QRVerifyResponse)
def verify_qr(
    request: QRVerifyRequest,
    x_staff_token: str | None = Header(default=None, alias="X-Staff-Token"),
):
    require_staff_token(x_staff_token)
    try:
        supabase = get_supabase()
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
        raise HTTPException(status_code=409, detail="Reservation is already completed")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to verify QR token") from exc
