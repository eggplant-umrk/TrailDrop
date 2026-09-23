from datetime import time
from uuid import uuid4

from models import Item


def make_item(**overrides):
    data = {
        "id": uuid4(),
        "title": "テスト商品",
        "type": "pickup",
        "price": 100,
        "stock": 1,
        "location_name": "テスト地点",
    }
    data.update(overrides)
    return Item(**data)


class TestItemPickupWindow:
    def test_defaults_to_no_pickup_window(self):
        item = make_item()
        assert item.pickup_available_from is None
        assert item.pickup_available_to is None

    def test_accepts_time_objects(self):
        item = make_item(
            pickup_available_from=time(9, 0), pickup_available_to=time(18, 0)
        )
        assert item.pickup_available_from == time(9, 0)
        assert item.pickup_available_to == time(18, 0)

    def test_accepts_hh_mm_ss_strings_as_returned_by_supabase(self):
        item = make_item(
            pickup_available_from="09:00:00", pickup_available_to="18:00:00"
        )
        assert item.pickup_available_from == time(9, 0)
        assert item.pickup_available_to == time(18, 0)

    def test_one_sided_window_is_still_representable_at_the_model_level(self):
        # DB制約(items_pickup_window_consistent)は両方null/両方設定を強制するが、
        # モデル自体は個々のフィールドがOptionalであることを確認する。
        item = make_item(pickup_available_from=time(9, 0), pickup_available_to=None)
        assert item.pickup_available_from == time(9, 0)
        assert item.pickup_available_to is None
