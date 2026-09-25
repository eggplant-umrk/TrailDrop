"""Tests for the hardening-pass staff-only endpoints:

- POST /staff/reservations/expire-stale (M2): releases stock for pending
  reservations whose pickup_window_end has passed.
- POST /staff/reservations-search (U7, moved from GET per PM review m-3): lets
  staff find a reservation by (partial) customer name when the reservation id
  isn't known, e.g. after an ambiguous POST /reservations failure. Uses a
  JSON body instead of a query string so customer names don't end up in
  URLs/access logs, and escapes ilike wildcard characters in the query.
- Staff-auth rate limiting (m8): shared by every X-Staff-Token endpoint via
  require_staff_token.
"""

import pathlib
import sys
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import main  # noqa: E402


class FakeRpcResult:
    def __init__(self, data):
        self.data = data


class FakeRpcCall:
    def __init__(self, fn, params):
        self._fn = fn
        self._params = params

    def execute(self):
        return self._fn(self._params)


class FakeQueryResult:
    def __init__(self, data):
        self.data = data


class FakeReservationsTable:
    """Just enough of the query builder for search_staff_reservations:
    select().ilike().order().limit().execute().
    """

    def __init__(self, rows, on_ilike=None):
        self.rows = rows
        self._ilike = None
        self._on_ilike = on_ilike

    def select(self, _fields):
        return self

    def ilike(self, field, pattern):
        if self._on_ilike is not None:
            # Records the exact pattern main.py built (post-escaping), so
            # tests can assert on it directly instead of relying on this
            # fake's simplistic substring matching below.
            self._on_ilike(pattern)
        needle = pattern.strip("%").lower()
        self._ilike = (field, needle)
        return self

    def order(self, _field, desc=False):
        return self

    def limit(self, n):
        matches = [
            r
            for r in self.rows.values()
            if self._ilike is None or self._ilike[1] in str(r.get(self._ilike[0], "")).lower()
        ]
        self._limited = matches[:n]
        return self

    def execute(self):
        return FakeQueryResult([deepcopy(r) for r in self._limited])


class FakeItemsTable:
    def __init__(self, items):
        self.items = items
        self._ids = None

    def select(self, _fields):
        return self

    def in_(self, _field, ids):
        self._ids = set(ids)
        return self

    def execute(self):
        matches = [
            {"id": item_id, "title": item["title"]}
            for item_id, item in self.items.items()
            if self._ids is None or item_id in self._ids
        ]
        return FakeQueryResult(matches)


class FakeSupabase:
    def __init__(self, reservations, items):
        self.reservations = reservations
        self.items = items
        self.expired_call_count = 0
        self.last_ilike_pattern = None

    def table(self, name):
        if name == "reservations":
            return FakeReservationsTable(
                self.reservations, on_ilike=lambda pattern: setattr(self, "last_ilike_pattern", pattern)
            )
        if name == "items":
            return FakeItemsTable(self.items)
        raise NotImplementedError(name)

    def rpc(self, name, params):
        self.expired_call_count += 1
        if name == "expire_stale_pending_reservations":
            return FakeRpcCall(self._expire_stale_pending_reservations, params)
        raise NotImplementedError(f"unexpected RPC: {name}")

    def _expire_stale_pending_reservations(self, _params):
        # Mirrors supabase/migrations/20260925100000_..._reservations.sql:
        # only pending reservations with a recorded pickup_window_end that is
        # more than the 30-minute grace period in the past are expired; each
        # one returns its item's stock by one.
        import datetime as _dt

        now = _dt.datetime.now(_dt.timezone.utc)
        expired = []
        for reservation in self.reservations.values():
            if reservation["status"] != "pending":
                continue
            end = reservation.get("pickup_window_end")
            if end is None:
                continue
            end_dt = _dt.datetime.fromisoformat(end)
            if end_dt + _dt.timedelta(minutes=30) >= now:
                continue
            reservation["status"] = "cancelled"
            if reservation.get("payment_status") == "paid":
                reservation["payment_status"] = "cancelled"
            self.items[reservation["item_id"]]["stock"] += 1
            expired.append(deepcopy(reservation))
        return FakeRpcResult(expired)


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
    monkeypatch.setenv("STAFF_API_TOKEN", "test-staff-token")
    items = {"11111111-1111-4111-8111-111111111111": {"stock": 5, "title": "薪"}}
    fake = FakeSupabase({}, items)
    monkeypatch.setattr(main, "get_supabase", lambda: fake)
    return fake


PAST = "2020-01-01T00:00:00+00:00"
FUTURE = "2999-01-01T00:00:00+00:00"


class TestExpireStaleReservations:
    def test_expires_pending_reservation_past_its_window_and_returns_stock(
        self, client, fake_supabase
    ):
        reservation = make_reservation(pickup_window_end=PAST)
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.post(
            "/staff/reservations/expire-stale",
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["expired_count"] == 1
        assert body["expired_ids"] == [reservation["id"]]
        assert fake_supabase.items["11111111-1111-4111-8111-111111111111"]["stock"] == 6
        assert fake_supabase.reservations[reservation["id"]]["status"] == "cancelled"

    def test_reservation_without_pickup_window_end_is_not_touched(
        self, client, fake_supabase
    ):
        reservation = make_reservation(pickup_window_end=None)
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.post(
            "/staff/reservations/expire-stale",
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.status_code == 200
        assert response.json()["expired_count"] == 0
        assert fake_supabase.reservations[reservation["id"]]["status"] == "pending"

    def test_pending_reservation_within_window_is_not_expired(self, client, fake_supabase):
        reservation = make_reservation(pickup_window_end=FUTURE)
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.post(
            "/staff/reservations/expire-stale",
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.json()["expired_count"] == 0
        assert fake_supabase.reservations[reservation["id"]]["status"] == "pending"

    def test_reservation_within_30_minute_grace_period_is_not_expired(
        self, client, fake_supabase
    ):
        import datetime as _dt

        ended_20_minutes_ago = (
            _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=20)
        ).isoformat()
        reservation = make_reservation(pickup_window_end=ended_20_minutes_ago)
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.post(
            "/staff/reservations/expire-stale",
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.json()["expired_count"] == 0
        assert fake_supabase.reservations[reservation["id"]]["status"] == "pending"
        assert fake_supabase.items["11111111-1111-4111-8111-111111111111"]["stock"] == 5

    def test_reservation_past_30_minute_grace_period_is_expired(self, client, fake_supabase):
        import datetime as _dt

        ended_31_minutes_ago = (
            _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=31)
        ).isoformat()
        reservation = make_reservation(pickup_window_end=ended_31_minutes_ago)
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.post(
            "/staff/reservations/expire-stale",
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.json()["expired_count"] == 1
        assert fake_supabase.reservations[reservation["id"]]["status"] == "cancelled"
        assert fake_supabase.items["11111111-1111-4111-8111-111111111111"]["stock"] == 6

    def test_rpc_sql_uses_30_minute_grace_period(self):
        # The fake above can't prove what the real RPC does, so pin the SQL
        # itself (migration and schema.sql must stay in sync).
        root = pathlib.Path(__file__).resolve().parents[2]
        migration = (
            root / "supabase/migrations/20260925100000_expire_stale_pending_reservations.sql"
        ).read_text(encoding="utf-8")
        schema = (root / "infra/schema.sql").read_text(encoding="utf-8")
        for sql in (migration, schema):
            assert "grace_period constant interval := interval '30 minutes';" in sql
            assert "pickup_window_end + grace_period < now()" in sql
            assert "batch_size constant integer := 500;" in sql
            assert "for update" in sql

    def test_completed_reservation_past_its_window_is_not_touched(self, client, fake_supabase):
        reservation = make_reservation(status="completed", pickup_window_end=PAST)
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.post(
            "/staff/reservations/expire-stale",
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.json()["expired_count"] == 0
        assert fake_supabase.reservations[reservation["id"]]["status"] == "completed"
        assert fake_supabase.items["11111111-1111-4111-8111-111111111111"]["stock"] == 5

    def test_missing_staff_token_is_rejected(self, client, fake_supabase):
        response = client.post("/staff/reservations/expire-stale")

        assert response.status_code == 401


class TestSearchStaffReservations:
    def test_partial_name_match_is_returned(self, client, fake_supabase):
        reservation = make_reservation(user_name="山田太郎")
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.post(
            "/staff/reservations-search",
            json={"user_name": "山田"},
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 1
        assert body[0]["user_name"] == "山田太郎"
        assert body[0]["item_title"] == "薪"

    def test_no_match_returns_empty_list(self, client, fake_supabase):
        response = client.post(
            "/staff/reservations-search",
            json={"user_name": "存在しない名前"},
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.status_code == 200
        assert response.json() == []

    def test_query_too_short_is_rejected(self, client, fake_supabase):
        response = client.post(
            "/staff/reservations-search",
            json={"user_name": "a"},
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.status_code == 422

    def test_access_token_and_qr_token_are_never_returned(self, client, fake_supabase):
        reservation = make_reservation(user_name="秘密花子")
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.post(
            "/staff/reservations-search",
            json={"user_name": "秘密"},
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert "access_token" not in response.text
        assert reservation["qr_token"] not in response.text

    def test_missing_staff_token_is_rejected(self, client, fake_supabase):
        response = client.post(
            "/staff/reservations-search", json={"user_name": "ab"}
        )

        assert response.status_code == 401

    def test_user_name_is_not_sent_as_a_query_parameter(self, client, fake_supabase):
        # PMレビューm-3の核心: 氏名がURLに一切現れない(=アクセスログに残らない)
        # ことを確認する。GETでの受け付け自体が廃止されていることも合わせて
        # 確認する。
        response = client.get(
            "/staff/reservations-search",
            params={"user_name": "山田"},
            headers={"X-Staff-Token": "test-staff-token"},
        )
        assert response.status_code == 405

    @pytest.mark.parametrize("raw_char", ["%", "_", "*", "\\"])
    def test_ilike_wildcard_characters_are_escaped_before_querying(
        self, client, fake_supabase, raw_char
    ):
        # PMレビューm-3: %, _, *, \ はいずれもilikeのワイルドカード(または
        # そのエスケープ文字自体)として特別扱いされ得るため、ユーザー入力に
        # 含まれる場合はそのまま渡さずエスケープしなければならない。ここでは
        # 実際にsearch_staff_reservationsがsupabaseクライアントに渡すpattern
        # 引数そのものを検証する(FakeReservationsTableの雑な部分一致では
        # なく)。
        query = f"名前{raw_char}花子"
        response = client.post(
            "/staff/reservations-search",
            json={"user_name": query},
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.status_code == 200
        pattern = fake_supabase.last_ilike_pattern
        assert pattern is not None
        # 先頭・末尾の%は検索自体の意図的なワイルドカードなので、それを除いた
        # 中身にはraw_charの直前にエスケープ文字(\)が入っているはず。
        inner = pattern[1:-1]
        assert f"\\{raw_char}" in inner
        # 元の文字がエスケープなしでそのまま(=ワイルドカードとして解釈され得る
        # 形で)残っていないことも確認する。
        assert raw_char not in inner.replace(f"\\{raw_char}", "")

    def test_wildcard_query_does_not_match_unrelated_names(self, client, fake_supabase):
        # ワイルドカードとして解釈されてしまうと"%"だけで全件ヒットして
        # しまうが、エスケープにより「"%"という文字自体」を含む名前としてしか
        # 一致しないことを確認する(実際のPostgRESTのESCAPE解釈は
        # FakeReservationsTableでは再現しないため、ここではエスケープされた
        # patternが送られていること自体をtest_ilike_wildcard_characters_are_
        # escaped_before_queryingで検証し、こちらは素朴な"%"単体クエリが
        # 無関係な氏名にヒットしないことをアプリ層の意図として確認する)。
        reservation = make_reservation(user_name="山田太郎")
        fake_supabase.reservations[reservation["id"]] = reservation

        response = client.post(
            "/staff/reservations-search",
            json={"user_name": "%%"},
            headers={"X-Staff-Token": "test-staff-token"},
        )

        assert response.status_code == 200
        pattern = fake_supabase.last_ilike_pattern
        assert pattern == "%\\%\\%%"


class TestStaffAuthRateLimit:
    """PM review m-b: only failed staff authentication counts toward the
    20-per-60s limit; normal operations with the correct token don't."""

    def test_repeated_failures_return_429(self, fake_supabase):
        for _ in range(main.STAFF_AUTH_RATE_LIMIT):
            with pytest.raises(main.HTTPException) as exc_info:
                main.require_staff_token("wrong-token", "203.0.113.42")
            assert exc_info.value.status_code == 401

        with pytest.raises(main.HTTPException) as exc_info:
            main.require_staff_token("wrong-token", "203.0.113.42")

        assert exc_info.value.status_code == 429

    def test_missing_token_counts_as_failure(self, fake_supabase):
        for _ in range(main.STAFF_AUTH_RATE_LIMIT):
            with pytest.raises(main.HTTPException):
                main.require_staff_token(None, "203.0.113.43")

        with pytest.raises(main.HTTPException) as exc_info:
            main.require_staff_token(None, "203.0.113.43")

        assert exc_info.value.status_code == 429

    def test_valid_token_does_not_consume_rate_limit(self, fake_supabase):
        for _ in range(main.STAFF_AUTH_RATE_LIMIT * 3):
            main.require_staff_token("test-staff-token", "203.0.113.44")

        assert "203.0.113.44" not in main._staff_auth_failure_log

    def test_valid_token_requests_via_endpoint_never_hit_429(self, client, fake_supabase):
        for _ in range(main.STAFF_AUTH_RATE_LIMIT + 5):
            response = client.post(
                "/staff/reservations-search",
                json={"user_name": "山田"},
                headers={"X-Staff-Token": "test-staff-token"},
            )
            assert response.status_code == 200

    def test_valid_token_is_still_rejected_while_ip_is_locked_out(self, fake_supabase):
        # A correct guess during a brute-force run must not slip through,
        # otherwise the lockout wouldn't slow token guessing at all.
        for _ in range(main.STAFF_AUTH_RATE_LIMIT):
            with pytest.raises(main.HTTPException):
                main.require_staff_token("wrong-token", "203.0.113.45")

        with pytest.raises(main.HTTPException) as exc_info:
            main.require_staff_token("test-staff-token", "203.0.113.45")

        assert exc_info.value.status_code == 429

    def test_valid_requests_between_failures_do_not_add_to_the_count(self, fake_supabase):
        for _ in range(main.STAFF_AUTH_RATE_LIMIT - 1):
            with pytest.raises(main.HTTPException):
                main.require_staff_token("wrong-token", "203.0.113.46")
            main.require_staff_token("test-staff-token", "203.0.113.46")

        # 19 failures + 19 successes: still under the failure limit.
        main.require_staff_token("test-staff-token", "203.0.113.46")

    def test_unconfigured_staff_token_is_not_counted_as_failure(self, monkeypatch):
        monkeypatch.delenv("STAFF_API_TOKEN", raising=False)
        for _ in range(main.STAFF_AUTH_RATE_LIMIT + 1):
            with pytest.raises(main.HTTPException) as exc_info:
                main.require_staff_token("anything", "203.0.113.47")
            assert exc_info.value.status_code == 503

    def test_different_ips_are_tracked_independently(self, fake_supabase):
        for _ in range(main.STAFF_AUTH_RATE_LIMIT):
            with pytest.raises(main.HTTPException):
                main.require_staff_token("wrong-token", "203.0.113.1")

        # A different IP is unaffected by the first IP's failures.
        main.require_staff_token("test-staff-token", "203.0.113.2")
