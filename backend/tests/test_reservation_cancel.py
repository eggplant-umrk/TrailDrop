"""Tests for POST /reservations/{id}/cancel.

main.get_supabase() constructs a real supabase-py Client directly (it is not
a FastAPI dependency), so these tests monkeypatch main.get_supabase itself
and replace it with an in-memory fake that mimics just enough of the
supabase-py RPC surface (`.rpc(name, params).execute()` returning an object
with `.data`) to exercise cancel_reservation_with_stock()'s contract as
implemented in
supabase/migrations/20260924090000_add_reservation_cancellation.sql:

- pending -> cancelled succeeds and returns exactly one unit of stock.
- completed -> cancelled and cancelled -> cancelled are both rejected
  (RESERVATION_NOT_CANCELLABLE / 409), with no stock change.
- an unknown id or a mismatched access_token are both rejected
  (RESERVATION_NOT_FOUND / 404), without distinguishing the two -- this
  mirrors GET /reservations/{id}'s existing behavior.

True concurrent-request atomicity (two simultaneous cancel calls for the
same reservation never both returning stock) is guaranteed by the RPC's
`SELECT ... FOR UPDATE` row lock in Postgres and is not something a
single-threaded Python fake can exercise; what IS tested here is the
API-level idempotency a caller observes: cancelling the same reservation
twice in a row only ever returns stock once, and the second call is
rejected.
"""

import pathlib
import sys
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import main  # noqa: E402


class FakePostgrestError(Exception):
    def __init__(self, message: str, code: str):
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
    """In-memory stand-in for the parts of the Supabase client that
    cancel_reservation_with_stock() needs, implementing the same
    id+access_token+status contract as the real SQL function.
    """

    def __init__(self, reservations, items):
        self.reservations = reservations  # dict[str, dict]
        self.items = items  # dict[str, dict] (id -> {"stock": int})
        self.rpc_call_count = 0

    def rpc(self, name, params):
        self.rpc_call_count += 1
        if name == "cancel_reservation_with_stock":
            return FakeRpcCall(self._cancel_reservation_with_stock, params)
        raise NotImplementedError(f"unexpected RPC: {name}")

    def _cancel_reservation_with_stock(self, params):
        reservation_id = params["p_reservation_id"]
        access_token = params["p_access_token"]

        reservation = self.reservations.get(reservation_id)
        if reservation is None or reservation["access_token"] != access_token:
            raise FakePostgrestError("RESERVATION_NOT_FOUND", "P0003")

        if reservation["status"] != "pending":
            raise FakePostgrestError("RESERVATION_NOT_CANCELLABLE", "P0004")

        reservation["status"] = "cancelled"
        self.items[reservation["item_id"]]["stock"] += 1
        return FakeRpcResult([deepcopy(reservation)])


def make_reservation(**overrides):
    data = {
        "id": str(uuid4()),
        "item_id": "11111111-1111-4111-8111-111111111111",
        "user_name": "テスト太郎",
        "qr_token": str(uuid4()),
        "access_token": str(uuid4()),
        "status": "pending",
        "requested_at": None,
        "reserved_at": "2026-09-24T00:00:00+00:00",
        # 実予約はcreate_reservation_with_stockが常にpayment_status="paid"
        # で作る(モック決済)。cancel_reservation_with_stockはpayment_*には
        # 一切触れない(今回のスコープ外)ので、デフォルトをpaidにしておき、
        # キャンセル後も変化しないことをテストで確認する。
        "payment_method": "paypay",
        "payment_status": "paid",
    }
    data.update(overrides)
    return data


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def fake_supabase(monkeypatch):
    items = {"11111111-1111-4111-8111-111111111111": {"stock": 5}}
    reservations = {}
    fake = FakeSupabase(reservations, items)
    monkeypatch.setattr(main, "get_supabase", lambda: fake)
    return fake


def cancel(client, reservation_id, token):
    headers = {"X-Reservation-Token": token} if token is not None else {}
    return client.post(f"/reservations/{reservation_id}/cancel", headers=headers)


class TestCancelReservation:
    def test_pending_reservation_is_cancelled(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = cancel(client, reservation["id"], reservation["access_token"])

        assert response.status_code == 200
        assert response.json()["status"] == "cancelled"

    def test_cancelling_a_paid_reservation_leaves_payment_fields_unchanged(
        self, client, fake_supabase
    ):
        # Regression for the payment-mock feature: cancel_reservation_with_
        # stock() is unmodified and has no opinion on payment_method/
        # payment_status, so cancelling a reservation created through the
        # mock payment flow must still work exactly as before, and the
        # payment fields it carried in must come back unchanged.
        reservation = make_reservation(payment_method="credit_card", payment_status="paid")
        fake_supabase.reservations[reservation["id"]] = reservation

        response = cancel(client, reservation["id"], reservation["access_token"])

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "cancelled"
        assert body["payment_method"] == "credit_card"
        assert body["payment_status"] == "paid"

    def test_cancelling_returns_one_unit_of_stock(self, client, fake_supabase):
        reservation = make_reservation(item_id="11111111-1111-4111-8111-111111111111")
        fake_supabase.reservations[reservation["id"]] = reservation
        stock_before = fake_supabase.items[reservation["item_id"]]["stock"]

        cancel(client, reservation["id"], reservation["access_token"])

        stock_after = fake_supabase.items[reservation["item_id"]]["stock"]
        assert stock_after == stock_before + 1

    def test_completed_reservation_cannot_be_cancelled(self, client, fake_supabase):
        reservation = make_reservation(status="completed")
        fake_supabase.reservations[reservation["id"]] = reservation
        stock_before = fake_supabase.items[reservation["item_id"]]["stock"]

        response = cancel(client, reservation["id"], reservation["access_token"])

        assert response.status_code == 409
        assert fake_supabase.reservations[reservation["id"]]["status"] == "completed"
        assert fake_supabase.items[reservation["item_id"]]["stock"] == stock_before

    def test_already_cancelled_reservation_cannot_be_cancelled_again(
        self, client, fake_supabase
    ):
        reservation = make_reservation(status="cancelled")
        fake_supabase.reservations[reservation["id"]] = reservation
        stock_before = fake_supabase.items[reservation["item_id"]]["stock"]

        response = cancel(client, reservation["id"], reservation["access_token"])

        assert response.status_code == 409
        assert fake_supabase.items[reservation["item_id"]]["stock"] == stock_before

    def test_double_cancel_does_not_return_stock_twice(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation
        stock_before = fake_supabase.items[reservation["item_id"]]["stock"]

        first = cancel(client, reservation["id"], reservation["access_token"])
        second = cancel(client, reservation["id"], reservation["access_token"])

        assert first.status_code == 200
        assert second.status_code == 409
        assert fake_supabase.items[reservation["item_id"]]["stock"] == stock_before + 1

    def test_unknown_reservation_returns_404(self, client, fake_supabase):
        response = cancel(client, str(uuid4()), str(uuid4()))

        assert response.status_code == 404

    def test_wrong_access_token_returns_404(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = cancel(client, reservation["id"], str(uuid4()))

        assert response.status_code == 404
        assert fake_supabase.reservations[reservation["id"]]["status"] == "pending"

    def test_missing_access_token_header_returns_404(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = cancel(client, reservation["id"], None)

        assert response.status_code == 404
        assert fake_supabase.reservations[reservation["id"]]["status"] == "pending"

    @pytest.mark.parametrize(
        "invalid_id",
        ["not-a-uuid", "12345", "11111111-1111-1111-1111-11111111111"],
    )
    def test_invalid_reservation_id_returns_404_without_hitting_the_rpc(
        self, client, fake_supabase, invalid_id
    ):
        # PM review MINOR m1: a malformed id must be rejected as 404 (same as
        # "not found") before it ever reaches the RPC, instead of surfacing
        # Postgres's raw 22P02 "invalid input syntax for type uuid" error.
        response = cancel(client, invalid_id, str(uuid4()))

        assert response.status_code == 404
        assert response.json()["detail"] == "Reservation not found"
        assert fake_supabase.rpc_call_count == 0

    @pytest.mark.parametrize(
        "invalid_token",
        ["not-a-uuid", "12345", "11111111-1111-1111-1111-11111111111"],
    )
    def test_invalid_access_token_returns_404_without_hitting_the_rpc(
        self, client, fake_supabase, invalid_token
    ):
        # PM review MINOR m1': same treatment for a malformed
        # X-Reservation-Token as for a malformed reservation_id -- 404
        # "Reservation not found" without ever reaching the RPC (and thus
        # without a raw Postgres 22P02 leaking through).
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = cancel(client, reservation["id"], invalid_token)

        assert response.status_code == 404
        assert response.json()["detail"] == "Reservation not found"
        assert fake_supabase.rpc_call_count == 0
        assert fake_supabase.reservations[reservation["id"]]["status"] == "pending"
