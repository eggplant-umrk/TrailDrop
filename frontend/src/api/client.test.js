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
      pickup_available_from: "07:00:00",
      pickup_available_to: "21:00:00",
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
    expect(items.every((item) => item.pickup_available_from === "07:00:00")).toBe(true);
    expect(items.every((item) => item.pickup_available_to === "21:00:00")).toBe(true);
    expect(items.map((item) => item.title)).toEqual([
      "鮎の甘露煮の燻製 100gパック",
      "若鶏の皮肝けいちゃん 200g×2袋",
      "東濃ひのき薪 20kg×1箱 皮つき",
      "出来立てくんたま（3個入×5袋）通常パック",
      "菊泉本舗 特選 お茶せんべい 26枚入り",
    ]);
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
