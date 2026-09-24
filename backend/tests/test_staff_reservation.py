"""Tests for GET /staff/reservations/{id}, the new staff-only read-only
reservation lookup (PM spec: "スタッフ向け予約確認").

Like the other backend test modules, main.get_supabase() is monkeypatched
with an in-memory fake reproducing the small slice of the supabase-py table
query builder (`.table(...).select(...).eq(...).limit(...).execute()`) that
this endpoint uses, for both the "reservations" and "items" tables (it looks
up the item's title after finding the reservation).
"""

import pathlib
import sys
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import main  # noqa: E402


class FakeQueryResult:
    def __init__(self, data):
        self.data = data


class FakeTable:
    """Read-only subset of the supabase-py table query builder: select +
    eq + limit + execute. Filters are an AND of exact-match comparisons
    (stringified, matching how the real Postgrest client serializes them).
    """

    def __init__(self, rows):
        self.rows = rows
        self._filters = []

    def select(self, _fields):
        return self

    def eq(self, field, value):
        self._filters.append((field, value))
        return self

    def limit(self, _n):
        return self

    def execute(self):
        matches = [
            r
            for r in self.rows.values()
            if all(str(r.get(field)) == str(value) for field, value in self._filters)
        ]
        return FakeQueryResult([deepcopy(r) for r in matches])


class FakeSupabase:
    def __init__(self, reservations, items):
        self.reservations = reservations
        self.items = items

    def table(self, name):
        if name == "reservations":
            return FakeTable(self.reservations)
        if name == "items":
            return FakeTable(self.items)
        raise NotImplementedError(name)


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
        "payment_method": "paypay",
        "payment_status": "paid",
    }
    data.update(overrides)
    return data


def make_item(**overrides):
    data = {"id": "11111111-1111-4111-8111-111111111111", "title": "間伐材の薪（小）"}
    data.update(overrides)
    return data


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def fake_supabase(monkeypatch):
    monkeypatch.setenv("STAFF_API_TOKEN", "test-staff-token")
    items = {make_item()["id"]: make_item()}
    fake = FakeSupabase({}, items)
    monkeypatch.setattr(main, "get_supabase", lambda: fake)
    return fake


def lookup(client, reservation_id, staff_token="test-staff-token"):
    headers = {"X-Staff-Token": staff_token} if staff_token is not None else {}
    return client.get(f"/staff/reservations/{reservation_id}", headers=headers)


class TestGetStaffReservation:
    def test_pending_reservation_is_returned_with_item_title(self, client, fake_supabase):
        reservation = make_reservation(status="pending")
        fake_supabase.reservations[reservation["id"]] = reservation

        response = lookup(client, reservation["id"])

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "pending"
        assert body["item_title"] == "間伐材の薪（小）"
        assert body["user_name"] == "テスト太郎"

    def test_completed_reservation_is_returned(self, client, fake_supabase):
        reservation = make_reservation(status="completed")
        fake_supabase.reservations[reservation["id"]] = reservation

        response = lookup(client, reservation["id"])

        assert response.status_code == 200
        assert response.json()["status"] == "completed"

    def test_cancelled_reservation_is_returned(self, client, fake_supabase):
        reservation = make_reservation(status="cancelled", payment_status="cancelled")

        fake_supabase.reservations[reservation["id"]] = reservation

        response = lookup(client, reservation["id"])

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "cancelled"
        assert body["payment_status"] == "cancelled"

    def test_payment_fields_are_returned(self, client, fake_supabase):
        reservation = make_reservation(payment_method="credit_card", payment_status="paid")
        fake_supabase.reservations[reservation["id"]] = reservation

        response = lookup(client, reservation["id"])

        body = response.json()
        assert body["payment_method"] == "credit_card"
        assert body["payment_status"] == "paid"

    def test_access_token_is_never_returned(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = lookup(client, reservation["id"])

        assert "access_token" not in response.json()

    def test_unknown_reservation_returns_404(self, client, fake_supabase):
        response = lookup(client, str(uuid4()))

        assert response.status_code == 404
        assert response.json()["detail"] == "Reservation not found"

    def test_invalid_reservation_id_returns_404(self, client, fake_supabase):
        response = lookup(client, "not-a-uuid")

        assert response.status_code == 404

    def test_missing_staff_token_is_rejected(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = lookup(client, reservation["id"], staff_token=None)

        assert response.status_code == 401

    def test_wrong_staff_token_is_rejected(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = lookup(client, reservation["id"], staff_token="wrong")

        assert response.status_code == 401

    def test_staff_token_not_configured_returns_503(self, client, monkeypatch):
        monkeypatch.delenv("STAFF_API_TOKEN", raising=False)
        reservation = make_reservation()
        fake = FakeSupabase({reservation["id"]: reservation}, {})
        monkeypatch.setattr(main, "get_supabase", lambda: fake)

        response = lookup(client, reservation["id"], staff_token="anything")

        assert response.status_code == 503

    def test_reservation_token_header_is_not_accepted_as_staff_auth(
        self, client, fake_supabase
    ):
        # X-Reservation-Token (the customer-facing token) must not work as
        # a substitute for X-Staff-Token on this staff-only endpoint.
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.get(
            f"/staff/reservations/{reservation['id']}",
            headers={"X-Reservation-Token": reservation["access_token"]},
        )

        assert response.status_code in (401, 503)

    def test_missing_item_does_not_fail_the_lookup(self, client, fake_supabase):
        # Item title resolution failure (e.g. the item was deleted) must
        # not prevent the reservation itself from being shown.
        reservation = make_reservation(item_id=str(uuid4()))
        fake_supabase.reservations[reservation["id"]] = reservation

        response = lookup(client, reservation["id"])

        assert response.status_code == 200
        assert response.json()["item_title"] is None
