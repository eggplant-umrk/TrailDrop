"""Active-product filtering for GET /items."""

import pathlib
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import main  # noqa: E402


class FakeResult:
    data = []


class FakeItemsQuery:
    def __init__(self):
        self.filters = []

    def select(self, _columns):
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def execute(self):
        return FakeResult()


class FakeSupabase:
    def __init__(self):
        self.query = FakeItemsQuery()

    def table(self, name):
        assert name == "items"
        return self.query


def test_list_items_requests_active_products_only(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(main, "get_supabase", lambda: fake)

    response = TestClient(main.app).get("/items")

    assert response.status_code == 200
    assert fake.query.filters == [("is_active", True)]
