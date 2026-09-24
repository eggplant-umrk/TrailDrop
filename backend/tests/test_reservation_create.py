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
            "pickup_window_start": params.get("p_pickup_window_start"),
            "pickup_window_end": params.get("p_pickup_window_end"),
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


class TestCreateReservationPickupWindow:
    """PR #19: RouteTestで選択した受取時間帯(pickup_window_start/end)を
    予約作成時に受け取り、保存・返却できることを確認する。requested_at
    (experience種別専用の単一時刻)とは独立した別フィールドであること、
    未指定でも既存の予約作成フローを壊さないこと(後方互換)の両方を検証する。
    """

    def test_pickup_window_is_saved_and_returned(self, client, fake_supabase):
        start = future_iso(days=1)
        end = future_iso(days=1)  # window自体の妥当性(start<end)はFrontend側の関心事

        response = create(
            client,
            payment_method="paypay",
            pickup_window_start=start,
            pickup_window_end=end,
        )

        assert response.status_code == 201
        body = response.json()
        assert body["pickup_window_start"] is not None
        assert body["pickup_window_end"] is not None

    def test_pickup_window_defaults_to_null_when_not_provided(self, client, fake_supabase):
        # 後方互換: RouteTestを経由しない既存の予約作成フローは、pickup
        # windowを一切送らない。この場合でも従来どおり201で成功し、両方
        # nullで返る(既存予約と同じ扱い)。
        response = create(client, payment_method="paypay")

        assert response.status_code == 201
        body = response.json()
        assert body["pickup_window_start"] is None
        assert body["pickup_window_end"] is None

    def test_pickup_window_available_for_experience_type_too(self, client, fake_supabase):
        # pickup_window_start/endはrequested_atと独立した概念であり、
        # experience種別(requested_at必須)でも同時に保持できる。
        fake_supabase.items["22222222-2222-4222-8222-222222222222"] = make_item(
            type="experience"
        )

        response = create(
            client,
            item_id="22222222-2222-4222-8222-222222222222",
            payment_method="paypay",
            requested_at=future_iso(),
            pickup_window_start=future_iso(days=1),
            pickup_window_end=future_iso(days=1),
        )

        assert response.status_code == 201
        body = response.json()
        assert body["requested_at"] is not None
        assert body["pickup_window_start"] is not None
        assert body["pickup_window_end"] is not None


class TestCreateReservationPickupWindowOrdering:
    """PR #19フォローアップ(PMレビュー): pickup_window_start/endの整合性を
    Backend(models.py)で検証する。両方null(既存互換)・両方指定でstart<end
    のみを受理し、片方だけの指定やstart>=endは422で拒否する。RPCへ到達する
    前にPydanticのmodel_validatorで弾くため、これらのケースではFakeSupabase
    のrpc()が一切呼ばれない(rpc_call_count == 0)ことも合わせて確認する。
    """

    def test_start_before_end_succeeds(self, client, fake_supabase):
        start = future_iso(days=1)
        end = (datetime.now(timezone.utc) + timedelta(days=1, hours=2)).isoformat()

        response = create(
            client,
            payment_method="paypay",
            pickup_window_start=start,
            pickup_window_end=end,
        )

        assert response.status_code == 201
        body = response.json()
        assert body["pickup_window_start"] is not None
        assert body["pickup_window_end"] is not None

    def test_start_equal_to_end_is_rejected(self, client, fake_supabase):
        same = future_iso(days=1)

        response = create(
            client,
            payment_method="paypay",
            pickup_window_start=same,
            pickup_window_end=same,
        )

        assert response.status_code == 422
        assert fake_supabase.rpc_call_count == 0

    def test_start_after_end_is_rejected(self, client, fake_supabase):
        start = (datetime.now(timezone.utc) + timedelta(days=1, hours=2)).isoformat()
        end = future_iso(days=1)  # 1日後(startより前)

        response = create(
            client,
            payment_method="paypay",
            pickup_window_start=start,
            pickup_window_end=end,
        )

        assert response.status_code == 422
        assert fake_supabase.rpc_call_count == 0

    def test_start_only_is_rejected(self, client, fake_supabase):
        response = create(
            client,
            payment_method="paypay",
            pickup_window_start=future_iso(days=1),
        )

        assert response.status_code == 422
        assert fake_supabase.rpc_call_count == 0

    def test_end_only_is_rejected(self, client, fake_supabase):
        response = create(
            client,
            payment_method="paypay",
            pickup_window_end=future_iso(days=1),
        )

        assert response.status_code == 422
        assert fake_supabase.rpc_call_count == 0

    def test_both_null_succeeds_for_backward_compatibility(self, client, fake_supabase):
        # 既存予約作成フロー(RouteTestを経由しない)は両方省略する。
        response = create(client, payment_method="paypay")

        assert response.status_code == 201
        body = response.json()
        assert body["pickup_window_start"] is None
        assert body["pickup_window_end"] is None


def naive_iso(days=1):
    # timezone情報を持たないISO文字列(offsetサフィックスなし)。
    return (datetime.now() + timedelta(days=days)).isoformat()


class TestCreateReservationPickupWindowTimezone:
    """PMレビューM1: requested_atと同じくpickup_window_start/endにも
    timezone offset必須のバリデーションを課す。naive/aware混在時に
    ordering check(start>=end比較)でTypeError→500にならないことも
    このテストクラスで担保する(混在ケースが422で先に弾かれることを
    確認することで検証する)。
    """

    def test_naive_pickup_window_is_rejected(self, client, fake_supabase):
        start = naive_iso(days=1)
        end = naive_iso(days=1)

        response = create(
            client,
            payment_method="paypay",
            pickup_window_start=start,
            pickup_window_end=end,
        )

        assert response.status_code == 422
        assert fake_supabase.rpc_call_count == 0

    def test_mixed_timezone_pickup_window_is_rejected(self, client, fake_supabase):
        # startはtimezone-aware、endはnaive。500にならず422で拒否されること
        # (ordering checkのstart>=end比較に両者が渡らないことの確認)。
        response = create(
            client,
            payment_method="paypay",
            pickup_window_start=future_iso(days=1),
            pickup_window_end=naive_iso(days=1),
        )

        assert response.status_code == 422
        assert fake_supabase.rpc_call_count == 0

    def test_mixed_timezone_pickup_window_is_rejected_other_order(self, client, fake_supabase):
        # startがnaive、endがtimezone-awareの逆パターンも同様に422。
        response = create(
            client,
            payment_method="paypay",
            pickup_window_start=naive_iso(days=1),
            pickup_window_end=future_iso(days=1),
        )

        assert response.status_code == 422
        assert fake_supabase.rpc_call_count == 0

    def test_timezone_aware_pickup_window_succeeds(self, client, fake_supabase):
        start = future_iso(days=1)
        end = (datetime.now(timezone.utc) + timedelta(days=1, hours=2)).isoformat()

        response = create(
            client,
            payment_method="paypay",
            pickup_window_start=start,
            pickup_window_end=end,
        )

        assert response.status_code == 201
        body = response.json()
        assert body["pickup_window_start"] is not None
        assert body["pickup_window_end"] is not None


class TestReservationErrorPickupWindowCheckViolation:
    """PMレビューM3: DBのreservations_pickup_window_consistent制約
    (check_violation, PostgreSQL error code 23514)を、main.reservation_error
    が422へ正しくマッピングすることを確認する。models.pyのバリデーションで
    通常はここに到達しないため(defense in depth)、RPCを直接叩いた場合を
    想定してreservation_error()を直接呼ぶユニットテストとする。502(曖昧な
    失敗)のままだとFrontend(Reservation.jsx)のDEFINITELY_NOT_CREATED_
    STATUSESに含まれず、「予約されたか分からない」曖昧エラー扱いになって
    しまう回帰を防ぐ。
    """

    def test_check_violation_is_mapped_to_422(self):
        exc = FakePostgrestError(
            "new row for relation \"reservations\" violates check constraint "
            '"reservations_pickup_window_consistent"',
            "23514",
        )

        http_exc = main.reservation_error(exc)

        assert http_exc.status_code == 422

    def test_check_violation_does_not_fall_through_to_502(self):
        # 23514はどの既存メッセージパターン(EXPERIENCE_DATE_REQUIRED等)にも
        # 一致しないため、この分岐を追加する前は最後のfallback(502)に
        # 落ちていた。422の方が優先されることを明示的に確認する。
        exc = FakePostgrestError("check constraint violation", "23514")

        http_exc = main.reservation_error(exc)

        assert http_exc.status_code != 502
