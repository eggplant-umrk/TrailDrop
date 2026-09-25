"""Tests for GET /reservations/{id}.

There was previously no dedicated test file for this endpoint. This adds
coverage for the normal fetch and, per the hardening pass, confirms an
invalid UUID (either the path id or the X-Reservation-Token header) is
rejected with a 4xx before ever reaching the database, instead of leaking a
raw Postgres error as a 502 (main.require_valid_uuid, the same helper
cancel_reservation/get_staff_reservation already use).
"""

import pathlib
import sys
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import main  # noqa: E402


class FakeQueryResult:
    def __init__(self, data):
        self.data = data


class FakeTable:
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
        return FakeQueryResult(matches)


class FakeSupabase:
    def __init__(self, reservations):
        self.reservations = reservations

    def table(self, name):
        if name == "reservations":
            return FakeTable(self.reservations)
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
        "pickup_window_start": None,
        "pickup_window_end": None,
    }
    data.update(overrides)
    return data


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase({})
    monkeypatch.setattr(main, "get_supabase", lambda: fake)
    return fake


def get(client, reservation_id, token):
    headers = {"X-Reservation-Token": token} if token is not None else {}
    return client.get(f"/reservations/{reservation_id}", headers=headers)


class TestGetReservation:
    def test_valid_reservation_is_returned(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = get(client, reservation["id"], reservation["access_token"])

        assert response.status_code == 200
        assert response.json()["id"] == reservation["id"]

    def test_missing_token_returns_404(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = get(client, reservation["id"], None)

        assert response.status_code == 404

    def test_wrong_token_returns_404(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = get(client, reservation["id"], str(uuid4()))

        assert response.status_code == 404

    def test_invalid_uuid_reservation_id_returns_404_not_502(self, client, fake_supabase):
        response = get(client, "not-a-uuid", str(uuid4()))

        assert response.status_code == 404

    def test_invalid_uuid_token_returns_404_not_502(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = get(client, reservation["id"], "not-a-uuid")

        assert response.status_code == 404

    def test_unknown_reservation_returns_404(self, client, fake_supabase):
        response = get(client, str(uuid4()), str(uuid4()))

        assert response.status_code == 404
