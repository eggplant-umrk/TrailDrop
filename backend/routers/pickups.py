from fastapi import APIRouter

router = APIRouter(prefix="/pickups", tags=["pickups"])


@router.get("/")
def list_pickups():
    """薪・ジビエのスマート受取（移動ついで受取）予約一覧"""
    return []
