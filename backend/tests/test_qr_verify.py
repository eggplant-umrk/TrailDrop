"""Tests for POST /qr/verify, focused on the PM review MAJOR fix: a
cancelled reservation must be rejected with a distinct 409 ("Reservation is
cancelled") and must never be moved to "completed" by this endpoint.

Like test_reservation_cancel.py, main.get_supabase() is monkeypatched with
an in-memory fake, here reproducing the small slice of the supabase-py
table query builder (`.table(...).select(...)/.update(...).eq(...).eq(...)
.limit(...).execute()`) that verify_qr() actually uses.

Also covers the select-then-update race fallback (a concurrent request
cancels the reservation between verify_qr()'s initial status lookup and its
conditional UPDATE): FakeSupabase.race lets a test inject that status change
at the exact point the UPDATE's WHERE filtering runs, so it legitimately
matches 0 rows the way the real conditional UPDATE would.

DEMO_MODE's equivalent guard (frontend/src/api/client.js verifyQr) is JS
that runs in the browser and isn't exercised by this Python suite; it was
verified manually in the browser instead (see the PR description).
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


class FakeReservationsTable:
    """Reproduces just the chained-filter subset of the supabase-py table
    query builder that verify_qr() calls: select/update + eq + limit +
    execute. Filters are applied as an AND of exact-match comparisons
    (stringified, so UUID vs. str values compare equal, matching how the
    real Postgrest client serializes them).
    """

    def __init__(self, supabase):
        self.supabase = supabase
        self.reservations = supabase.reservations
        self._update_values = None
        self._filters = []

    def select(self, _fields):
        return self

    def update(self, values):
        self._update_values = values
        return self

    def eq(self, field, value):
        self._filters.append((field, value))
        return self

    def limit(self, _n):
        return self

    def execute(self):
        if self._update_values is not None:
            # Simulates another request changing the row's status between
            # verify_qr()'s initial SELECT and this UPDATE (see
            # FakeSupabase.race / test_select_update_race_falls_back_to_...
            # below). Applied at most once, right before this UPDATE's own
            # WHERE filtering runs, so a status="pending" filter here
            # legitimately matches 0 rows -- exactly like the real
            # conditional UPDATE would if the row changed underneath it.
            race = self.supabase.race
            if race is not None:
                target = self.reservations.get(race["reservation_id"])
                if target is not None:
                    target["status"] = race["new_status"]
                self.supabase.race = None

        matches = [
            r
            for r in self.reservations.values()
            if all(str(r.get(field)) == str(value) for field, value in self._filters)
        ]
        if self._update_values is not None:
            for r in matches:
                r.update(self._update_values)
        return FakeQueryResult([deepcopy(r) for r in matches])


class FakeSupabase:
    def __init__(self, reservations):
        self.reservations = reservations
        # Set by a test to {"reservation_id": ..., "new_status": ...} to
        # simulate a concurrent status change landing between verify_qr()'s
        # initial SELECT and its conditional UPDATE. None (the default)
        # means no race -- normal sequential behavior.
        self.race = None

    def table(self, name):
        if name == "reservations":
            return FakeReservationsTable(self)
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
    }
    data.update(overrides)
    return data


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def fake_supabase(monkeypatch):
    monkeypatch.setenv("STAFF_API_TOKEN", "test-staff-token")
    reservations = {}
    fake = FakeSupabase(reservations)
    monkeypatch.setattr(main, "get_supabase", lambda: fake)
    return fake


def verify(client, qr_token, staff_token="test-staff-token"):
    headers = {"X-Staff-Token": staff_token} if staff_token is not None else {}
    return client.post("/qr/verify", json={"qr_token": qr_token}, headers=headers)


class TestVerifyQr:
    def test_pending_reservation_is_completed(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = verify(client, reservation["qr_token"])

        assert response.status_code == 200
        assert response.json()["status"] == "completed"

    def test_completed_reservation_returns_409_already_completed(
        self, client, fake_supabase
    ):
        reservation = make_reservation(status="completed")
        fake_supabase.reservations[reservation["id"]] = reservation

        response = verify(client, reservation["qr_token"])

        assert response.status_code == 409
        assert response.json()["detail"] == "Reservation is already completed"

    def test_cancelled_reservation_returns_409_cancelled(self, client, fake_supabase):
        # PM review MAJOR: previously this fell through to the generic
        # "already completed" 409, indistinguishable from a real handoff.
        reservation = make_reservation(status="cancelled")
        fake_supabase.reservations[reservation["id"]] = reservation

        response = verify(client, reservation["qr_token"])

        assert response.status_code == 409
        assert response.json()["detail"] == "Reservation is cancelled"

    def test_cancelled_reservation_status_is_unchanged_after_verify(
        self, client, fake_supabase
    ):
        reservation = make_reservation(status="cancelled")
        fake_supabase.reservations[reservation["id"]] = reservation

        verify(client, reservation["qr_token"])

        assert fake_supabase.reservations[reservation["id"]]["status"] == "cancelled"

    def test_select_update_race_falls_back_to_cancelled_409(self, client, fake_supabase):
        # PM review MINOR m3': the initial SELECT sees status="pending", but
        # by the time the conditional UPDATE (.eq("status", "pending")) runs,
        # another request has already cancelled the reservation, so the
        # UPDATE matches 0 rows. verify_qr() must then re-check the current
        # status and report 409 "Reservation is cancelled" -- not silently
        # treat 0 rows updated as "already completed", and never complete
        # the handoff.
        reservation = make_reservation(status="pending")
        fake_supabase.reservations[reservation["id"]] = reservation
        fake_supabase.race = {
            "reservation_id": reservation["id"],
            "new_status": "cancelled",
        }

        response = verify(client, reservation["qr_token"])

        assert response.status_code == 409
        assert response.json()["detail"] == "Reservation is cancelled"
        assert fake_supabase.reservations[reservation["id"]]["status"] == "cancelled"

    def test_unknown_qr_token_returns_404(self, client, fake_supabase):
        response = verify(client, str(uuid4()))

        assert response.status_code == 404
        assert response.json()["detail"] == "QR token not found"

    def test_missing_staff_token_is_rejected(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = verify(client, reservation["qr_token"], staff_token=None)

        assert response.status_code == 401
        assert fake_supabase.reservations[reservation["id"]]["status"] == "pending"

    def test_wrong_staff_token_is_rejected(self, client, fake_supabase):
        reservation = make_reservation()
        fake_supabase.reservations[reservation["id"]] = reservation

        response = verify(client, reservation["qr_token"], staff_token="wrong")

        assert response.status_code == 401
        assert fake_supabase.reservations[reservation["id"]]["status"] == "pending"
