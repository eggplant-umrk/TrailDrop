import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import Client, create_client

from models import Item, QRVerifyRequest, ReservationCreate, ReservationResponse

load_dotenv()

app = FastAPI(title="TrailDrop API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_supabase() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise HTTPException(
            status_code=503,
            detail="SUPABASE_URL and SUPABASE_KEY must be configured",
        )
    return create_client(url, key)


@app.get("/items", response_model=list[Item])
def list_items():
    try:
        response = get_supabase().table("items").select("*").execute()
        return response.data
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to fetch items") from exc


@app.post("/reservations", response_model=ReservationResponse, status_code=201)
def create_reservation(reservation: ReservationCreate):
    try:
        response = (
            get_supabase()
            .table("reservations")
            .insert(reservation.model_dump(mode="json"))
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=502, detail="Failed to create reservation")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to create reservation") from exc


@app.get("/reservations/{reservation_id}", response_model=ReservationResponse)
def get_reservation(reservation_id: str):
    try:
        response = (
            get_supabase()
            .table("reservations")
            .select("*")
            .eq("id", reservation_id)
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


@app.post("/qr/verify", response_model=ReservationResponse)
def verify_qr(request: QRVerifyRequest):
    try:
        response = (
            get_supabase()
            .table("reservations")
            .update({"status": "completed"})
            .eq("qr_token", str(request.qr_token))
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="QR token not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to verify QR token") from exc
