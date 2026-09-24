"""Tests for POST /reservations, covering the mock payment feature
(payment_method / payment_status) added on top of the existing
create_reservation_with_stock() contract.

main.get_supabase() is monkeypatched with an in-memory fake, as in
test_reservation_cancel.py and test_qr_verify.py. The fake reproduces the
same validation order as
supabase/migrations/20260924100000_add_reservation_payment.sql's RPC
(payment_method -> stock -> experience date -> requested_at), so tests that
exercise reservation_error()'s mapping still cover the pre-existing
ITEM_NOT_FOUND / OUT_OF_STOCK / EXPERIENCE_DATE_REQUIRED / REQUESTED_AT_IN_PAST
paths unchanged -- those are the "既存予約作成への回帰" cases.

payment_method itself is validated twice by design (defense in depth, same
as requested_at): main.py's create_reservation() rejects an invalid/missing
value with 400 before ever calling the RPC (VALID_PAYMENT_METHODS test
cases below never reach the fake RPC at all -- see rpc_call_count == 0
assertions); the fake RPC also re-validates it, for parity with the real SQL
function in case that first check is ever bypassed.
"""

import pathlib
import sys
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import main  # noqa: E402


class FakePostgrestError(Exception):
    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.message = message
        self.code = code


class FakeRpcResult:
    def __init__(self, data):
        self.data = data


class FakeRpcCall:
    def __init__(self, fn, params):
        self._fn = fn
        self._params = params

    def execute(self):
        return self._fn(self._params)


class FakeSupabase:
    """Reproduces create_reservation_with_stock()'s validation order and
    the mock-payment insert (payment_status always "paid" on success).
    """

    def __init__(self, items):
        self.items = items  # dict[str, dict] (id -> {"type": ..., "stock": ...})
        self.reservations = {}
        self.rpc_call_count = 0

    def rpc(self, name, params):
        self.rpc_call_count += 1
        if name == "create_reservation_with_stock":
            return FakeRpcCall(self._create_reservation_with_stock, params)
        raise NotImplementedError(f"unexpected RPC: {name}")

    def _create_reservation_with_stock(self, params):
        payment_method = params.get("p_payment_method")
        if payment_method not in ("paypay", "credit_card"):
            raise FakePostgrestError("INVALID_PAYMENT_METHOD", "22023")

        item_id = params["p_item_id"]
        item = self.items.get(item_id)
        if item is None:
            raise FakePostgrestError("ITEM_NOT_FOUND", "P0002")
        if item["stock"] <= 0:
            raise FakePostgrestError("OUT_OF_STOCK", "P0001")

        requested_at = params.get("p_requested_at")
        if item["type"] == "experience" and requested_at is None:
            raise FakePostgrestError("EXPERIENCE_DATE_REQUIRED", "22023")
        if requested_at is not None:
            parsed = datetime.fromisoformat(requested_at)
            if parsed <= datetime.now(timezone.utc):
                raise FakePostgrestError("REQUESTED_AT_IN_PAST", "22023")

        item["stock"] -= 1
        reservation_id = str(uuid4())
        reservation = {
            "id": reservation_id,
            "item_id": item_id,
            "user_name": params["p_user_name"],
            "qr_token": str(uuid4()),
            "access_token": str(uuid4()),
            "status": "pending",
            "requested_at": requested_at if item["type"] == "experience" else None,
            "reserved_at": "2026-09-24T00:00:00+00:00",
            "payment_method": payment_method,
            "payment_status": "paid",
        }
        self.reservations[reservation_id] = reservation
        return FakeRpcResult([deepcopy(reservation)])


def make_item(**overrides):
    data = {"type": "pickup", "stock": 5}
    data.update(overrides)
    return data


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def fake_supabase(monkeypatch):
    items = {"11111111-1111-4111-8111-111111111111": make_item()}
    fake = FakeSupabase(items)
    monkeypatch.setattr(main, "get_supabase", lambda: fake)
    return fake


def future_iso(days=1):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def create(client, **overrides):
    body = {
        "item_id": "11111111-1111-4111-8111-111111111111",
        "user_name": "テスト太郎",
        "payment_method": "paypay",
    }
    body.update(overrides)
    return client.post("/reservations", json=body)


class TestCreateReservationPayment:
    def test_paypay_succeeds(self, client, fake_supabase):
        response = create(client, payment_method="paypay")

        assert response.status_code == 201
        body = response.json()
        assert body["payment_method"] == "paypay"
        assert body["payment_status"] == "paid"
        assert body["status"] == "pending"

    def test_credit_card_succeeds(self, client, fake_supabase):
        response = create(client, payment_method="credit_card")

        assert response.status_code == 201
        body = response.json()
        assert body["payment_method"] == "credit_card"
        assert body["payment_status"] == "paid"

    def test_missing_payment_method_returns_400_without_hitting_the_rpc(
        self, client, fake_supabase
    ):
        body = {
            "item_id": "11111111-1111-4111-8111-111111111111",
            "user_name": "テスト太郎",
        }
        response = client.post("/reservations", json=body)

        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid payment method"
        assert fake_supabase.rpc_call_count == 0

    @pytest.mark.parametrize("invalid_method", ["bitcoin", "cash", "", "PayPay"])
    def test_invalid_payment_method_returns_400_without_hitting_the_rpc(
        self, client, fake_supabase, invalid_method
    ):
        response = create(client, payment_method=invalid_method)

        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid payment method"
        assert fake_supabase.rpc_call_count == 0

    def test_out_of_stock_returns_409_and_does_not_create_a_reservation(
        self, client, fake_supabase
    ):
        fake_supabase.items["11111111-1111-4111-8111-111111111111"]["stock"] = 0

        response = create(client, payment_method="paypay")

        assert response.status_code == 409
        assert fake_supabase.reservations == {}

    def test_repeated_identical_requests_each_create_their_own_reservation(
        self, client, fake_supabase
    ):
        # "二重送信" is guarded against on the Frontend (the confirm button
        # is disabled while a request is in flight; see Reservation.jsx).
        # There is no idempotency key in this API, so at the Backend level
        # two separate calls are indistinguishable from two separate
        # reservations by two different page loads -- each one decrements
        # stock and is accepted independently, same as before this feature.
        first = create(client, payment_method="paypay")
        second = create(client, payment_method="paypay")

        assert first.status_code == 201
        assert second.status_code == 201
        assert first.json()["id"] != second.json()["id"]
        assert fake_supabase.items["11111111-1111-4111-8111-111111111111"]["stock"] == 3

    def test_experience_reservation_still_requires_requested_at(self, client, fake_supabase):
        # Regression: the pre-existing experience-date requirement is
        # unaffected by adding payment_method.
        fake_supabase.items["22222222-2222-4222-8222-222222222222"] = make_item(
            type="experience"
        )

        response = create(
            client,
            item_id="22222222-2222-4222-8222-222222222222",
            payment_method="paypay",
        )

        assert response.status_code == 422
        assert response.json()["detail"] == "Experience date is required"

    def test_experience_reservation_with_valid_payment_and_date_succeeds(
        self, client, fake_supabase
    ):
        fake_supabase.items["22222222-2222-4222-8222-222222222222"] = make_item(
            type="experience"
        )

        response = create(
            client,
            item_id="22222222-2222-4222-8222-222222222222",
            payment_method="credit_card",
            requested_at=future_iso(),
        )

        assert response.status_code == 201
        body = response.json()
        assert body["payment_method"] == "credit_card"
        assert body["payment_status"] == "paid"
        assert body["requested_at"] is not None
