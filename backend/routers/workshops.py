from fastapi import APIRouter

router = APIRouter(prefix="/workshops", tags=["workshops"])


@router.get("/")
def list_workshops():
    """体験型ワークショップ予約一覧"""
    return []
