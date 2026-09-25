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
      item_id: "wood-001",
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
