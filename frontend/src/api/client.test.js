import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toUserMessage } from "../utils/errorMessages";

// client.jsはDEMO_MODE/VITE_API_BASE_URLをmodule読み込み時に確定するため、
// 環境変数をstubしてからその都度importし直す。
async function loadClient(env) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return (await import("./client.js")).default;
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getReservation error contract (DEMO_MODE matches the real API)", () => {
  async function createDemoReservation(api) {
    return api.createReservation({
      item_id: "a1111111-1111-4111-8111-111111111111",
      user_name: "テスト太郎",
      payment_method: "paypay",
    });
  }

  it("returns the reservation without access_token for the correct token", async () => {
    const api = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });
    const created = await createDemoReservation(api);

    const fetched = await api.getReservation(created.id, created.access_token);

    expect(fetched.id).toBe(created.id);
    expect(fetched).not.toHaveProperty("access_token");
    expect(fetched.item).toEqual({
      id: "a1111111-1111-4111-8111-111111111111",
      title: "鮎の甘露煮の燻製 100gパック",
      location_name: "道の駅 ロック・ガーデンひちそう",
      pickup_available_from: null,
      pickup_available_to: null,
    });
  });

  it.each([
    ["a mismatched token", (created) => [created.id, "wrong-token"]],
    ["a missing token", (created) => [created.id, null]],
    ["an unknown id", (created) => ["unknown-id", created.access_token]],
  ])("DEMO_MODE returns 404 'Reservation not found' for %s", async (_label, args) => {
    const api = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });
    const created = await createDemoReservation(api);

    const error = await rejectionOf(api.getReservation(...args(created)));

    expect(error.status).toBe(404);
    expect(error.message).toBe("Reservation not found");
  });

  it("the real API path surfaces the backend's 404 with the same status and detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { detail: "Reservation not found" })),
    );
    const api = await loadClient({ VITE_DEMO_MODE: "false", VITE_API_BASE_URL: "http://api.test" });

    const error = await rejectionOf(api.getReservation("some-id", "wrong-token"));

    expect(error.status).toBe(404);
    expect(error.message).toBe("Reservation not found");
  });

  it("DEMO_MODE cancel uses the same 404 contract for a mismatched token", async () => {
    const api = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });
    const created = await createDemoReservation(api);

    const error = await rejectionOf(api.cancelReservation(created.id, "wrong-token"));

    expect(error.status).toBe(404);
    expect(error.message).toBe("Reservation not found");
  });
});

describe("DEMO_MODE product master", () => {
  it("returns only the five DB-aligned active pickup products", async () => {
    const api = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });

    const items = await api.getItems();

    expect(items).toHaveLength(5);
    expect(items.map((item) => item.id)).toEqual([
      "a1111111-1111-4111-8111-111111111111",
      "a2222222-2222-4222-8222-222222222222",
      "a3333333-3333-4333-8333-333333333333",
      "a4444444-4444-4444-8444-444444444444",
      "a5555555-5555-4555-8555-555555555555",
    ]);
    expect(items.every((item) => item.type === "pickup")).toBe(true);
    expect(items.every((item) => item.is_active === true)).toBe(true);
    // 無人ロッカーのため24時間受取。営業時間は持たない。
    expect(items.every((item) => item.pickup_available_from === null)).toBe(true);
    expect(items.every((item) => item.pickup_available_to === null)).toBe(true);
    expect(items.map((item) => item.title)).toEqual([
      "鮎の甘露煮の燻製 100gパック",
      "若鶏の皮肝けいちゃん 200g×2袋",
      "東濃ひのき薪 20kg×1箱 皮つき",
      "出来立てくんたま（3個入×5袋）通常パック",
      "菊泉本舗 特選 お茶せんべい 26枚入り",
    ]);
  });
});

describe("DEMO_MODE reservations are shared across tabs of the same browser (P1-3)", () => {
  const ITEM = "a1111111-1111-4111-8111-111111111111";

  // 別タブ = sessionStorageは空、モジュールも読み込み直し、localStorageだけ共有。
  async function openAnotherTab() {
    sessionStorage.clear();
    return loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });
  }

  it("a reservation made in one tab can be re-displayed in another tab", async () => {
    const tab1 = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });
    const created = await tab1.createReservation({ item_id: ITEM, user_name: "テスト太郎", payment_method: "paypay" });

    const tab2 = await openAnotherTab();
    const fetched = await tab2.getReservation(created.id, created.access_token);

    expect(fetched.id).toBe(created.id);
    expect(fetched.qr_token).toBe(created.qr_token);
  });

  it("/staff/verify in another tab can look up and complete the same reservation", async () => {
    const tab1 = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });
    const created = await tab1.createReservation({ item_id: ITEM, user_name: "テスト太郎", payment_method: "paypay" });

    const staffTab = await openAnotherTab();
    const staffView = await staffTab.getStaffReservation(created.id, "staff");
    expect(staffView.status).toBe("pending");
    const verified = await staffTab.verifyQr(created.qr_token, "staff");
    expect(verified.status).toBe("completed");

    const customerTab = await openAnotherTab();
    const after = await customerTab.getReservation(created.id, created.access_token);
    expect(after.status).toBe("completed");
  });
});

describe("DEMO_MODE stock decreases when reserving (P2-10)", () => {
  const FIREWOOD = "a3333333-3333-4333-8333-333333333333"; // 初期在庫2

  async function stockOf(api, id) {
    return (await api.getItems()).find((item) => item.id === id).stock;
  }

  it("each reservation uses one unit, and the last one is rejected as out of stock", async () => {
    const api = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });
    const reserve = () => api.createReservation({ item_id: FIREWOOD, user_name: "テスト", payment_method: "paypay" });

    expect(await stockOf(api, FIREWOOD)).toBe(2);
    await reserve();
    expect(await stockOf(api, FIREWOOD)).toBe(1);
    const second = await reserve();
    expect(await stockOf(api, FIREWOOD)).toBe(0);

    const error = await rejectionOf(reserve());
    expect(error.status).toBe(409);
    expect(error.message).toBe("Item is out of stock");

    // キャンセルすると在庫が戻る(本番のRPCと同じ)。
    await api.cancelReservation(second.id, second.access_token);
    expect(await stockOf(api, FIREWOOD)).toBe(1);
  });

  it("rejects a reservation whose pickup window has already ended", async () => {
    const api = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });
    const error = await rejectionOf(
      api.createReservation({
        item_id: FIREWOOD,
        user_name: "テスト",
        payment_method: "paypay",
        pickup_window_start: new Date(Date.now() - 3 * 3600000).toISOString(),
        pickup_window_end: new Date(Date.now() - 3600000).toISOString(),
      }),
    );
    expect(error.status).toBe(422);
    expect(await stockOf(api, FIREWOOD)).toBe(2);
  });
});

describe("analyzeRoute pickup candidates", () => {
  const departure = "2999-01-01T09:00:00+09:00";

  it("DEMO_MODE uses the real route analysis API instead of fixed durations", async () => {
    const apiResult = {
      origin: "東京",
      destination: "下呂温泉",
      pass_point: "道の駅 ロック・ガーデンひちそう",
      pass_at: "2999-01-01T13:12:00+09:00",
      pickup_candidates: [],
      total_duration_minutes: 312,
      total_distance_meters: 371000,
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, apiResult));
    vi.stubGlobal("fetch", fetchMock);
    const api = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "http://api.test" });

    const result = await api.analyzeRoute({ origin: "東京", destination: "下呂温泉", departure_at: departure });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/routes/analyze");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      origin: "東京",
      destination: "下呂温泉",
      departure_at: departure,
    });
    expect(result).toEqual(apiResult);
  });

  it("DEMO_MODE surfaces route analysis errors instead of falling back to fixed values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(503, { detail: "Route analysis is not available" })),
    );
    const api = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "http://api.test" });

    const error = await rejectionOf(
      api.analyzeRoute({ origin: "東京", destination: "下呂温泉", departure_at: departure }),
    );

    expect(error.status).toBe(503);
  });

  it("DEMO_MODE shows a configuration message (not a network error) when VITE_API_BASE_URL is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = await loadClient({ VITE_DEMO_MODE: "true", VITE_API_BASE_URL: "" });

    const error = await rejectionOf(
      api.analyzeRoute({ origin: "東京", destination: "下呂温泉", departure_at: departure }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toUserMessage(error, { fallback: "ルートの検索に失敗しました。" })).toBe(
      "APIの接続先が設定されていません。管理者に確認してください。",
    );
  });

  async function sentBody(args) {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { pass_point: null, pass_at: null, pickup_candidates: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = await loadClient({ VITE_DEMO_MODE: "false", VITE_API_BASE_URL: "http://api.test" });
    await api.analyzeRoute(args);
    return JSON.parse(fetchMock.mock.calls[0][1].body);
  }

  it("sends origin_location only when the current location is used", async () => {
    const withLocation = await sentBody({
      origin: "現在地",
      destination: "下呂温泉",
      departure_at: departure,
      origin_location: { lat: 35.17, lng: 136.88 },
    });
    expect(withLocation).toEqual({
      origin: "現在地",
      destination: "下呂温泉",
      departure_at: departure,
      origin_location: { lat: 35.17, lng: 136.88 },
    });

    const withoutLocation = await sentBody({
      origin: "名古屋駅",
      destination: "下呂温泉",
      departure_at: departure,
    });
    expect(withoutLocation).toEqual({ origin: "名古屋駅", destination: "下呂温泉", departure_at: departure });
  });

  it("passes a no-candidate response through as a normal result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { pass_point: null, pass_at: null, pickup_candidates: [], total_duration_minutes: 30 }),
      ),
    );
    const api = await loadClient({ VITE_DEMO_MODE: "false", VITE_API_BASE_URL: "http://api.test" });

    const result = await api.analyzeRoute({ origin: "a", destination: "b", departure_at: departure });

    expect(result.pass_point).toBeNull();
    expect(result.pickup_candidates).toEqual([]);
  });
});

describe("request() error objects", () => {
  it("explains a past departure_at instead of a generic input error (P2-12)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(422, {
          detail: [{ loc: ["body", "departure_at"], msg: "Value error, departure_at must be in the future" }],
        }),
      ),
    );
    const api = await loadClient({ VITE_DEMO_MODE: "false", VITE_API_BASE_URL: "http://api.test" });

    const error = await rejectionOf(
      api.analyzeRoute({ origin: "名古屋駅", destination: "下呂温泉", departure_at: "2020-01-01T09:00:00+09:00" }),
    );

    expect(error.status).toBe(422);
    expect(toUserMessage(error)).toBe(
      "出発日時が現在より前になっています。現在より後の日時を指定してください。",
    );
  });

  it("marks FastAPI validation errors (array detail) as already-localized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(422, { detail: [{ loc: ["body", "user_name"], msg: "too long" }] }),
      ),
    );
    const api = await loadClient({ VITE_DEMO_MODE: "false", VITE_API_BASE_URL: "http://api.test" });

    const error = await rejectionOf(
      api.createReservation({ item_id: "x", user_name: "y", payment_method: "paypay" }),
    );

    expect(error.status).toBe(422);
    expect(error.userMessage).toBe("入力内容が正しくありません。");
    expect(toUserMessage(error, { fallback: "x" })).toBe("入力内容が正しくありません。");
  });

  it("keeps the English detail on the error but never as a userMessage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, { detail: "Too many route analysis requests. Please try again later." })),
    );
    const api = await loadClient({ VITE_DEMO_MODE: "false", VITE_API_BASE_URL: "http://api.test" });

    const error = await rejectionOf(
      api.analyzeRoute({ origin: "a", destination: "b", departure_at: "2999-01-01T00:00:00+09:00" }),
    );

    expect(error.status).toBe(429);
    expect(error.userMessage).toBeUndefined();
    expect(toUserMessage(error, { fallback: "x" })).not.toMatch(/Too many/);
  });

  it("marks a timeout as an already-localized message without a status", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url, { signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              );
            }),
        ),
      );
      const api = await loadClient({ VITE_DEMO_MODE: "false", VITE_API_BASE_URL: "http://api.test" });

      const pending = rejectionOf(api.getItems());
      await vi.advanceTimersByTimeAsync(20000);
      const error = await pending;

      expect(error.status).toBeUndefined();
      expect(error.userMessage).toMatch(/タイムアウト/);
    } finally {
      vi.useRealTimers();
    }
  });
});
