import { describe, expect, it } from "vitest";
import {
  NETWORK_ERROR_MESSAGE,
  RATE_LIMIT_ERROR_MESSAGE,
  SERVER_ERROR_MESSAGE,
  toUserMessage,
} from "./errorMessages";

function apiError(status, detail) {
  const err = new Error(typeof detail === "string" ? detail : `HTTP ${status}`);
  err.status = status;
  err.body = detail === undefined ? null : { detail };
  return err;
}

describe("toUserMessage", () => {
  it("prefers a userMessage already localized by the API client", () => {
    const err = new Error("通信がタイムアウトしました。");
    err.userMessage = "通信がタイムアウトしました。";
    expect(toUserMessage(err, { fallback: "x" })).toBe("通信がタイムアウトしました。");
  });

  it("maps a backend English detail via byDetail", () => {
    const err = apiError(409, "Item is out of stock");
    expect(
      toUserMessage(err, { byDetail: { "Item is out of stock": "在庫切れです。" }, fallback: "x" }),
    ).toBe("在庫切れです。");
  });

  it("maps DEMO_MODE errors (detail in message, no body) via byDetail", () => {
    const err = new Error("Invalid payment method");
    err.status = 400;
    expect(
      toUserMessage(err, { byDetail: { "Invalid payment method": "支払い方法を選び直してください。" } }),
    ).toBe("支払い方法を選び直してください。");
  });

  it("uses byStatus before the common status messages", () => {
    expect(toUserMessage(apiError(404, "Reservation not found"), { byStatus: { 404: "見つかりません。" } })).toBe(
      "見つかりません。",
    );
  });

  it("maps 429 and 5xx to Japanese without exposing the English detail", () => {
    const tooMany = toUserMessage(apiError(429, "Too many route analysis requests. Please try again later."));
    expect(tooMany).toBe(RATE_LIMIT_ERROR_MESSAGE);
    expect(toUserMessage(apiError(502, "Google Routes API request failed"))).toBe(SERVER_ERROR_MESSAGE);
  });

  it("uses the fallback for an unmapped status and never returns the raw detail", () => {
    const message = toUserMessage(apiError(418, "I'm a teapot"), { fallback: "失敗しました。" });
    expect(message).toBe("失敗しました。");
  });

  it("treats errors without a status (network failure) as a connection problem", () => {
    expect(toUserMessage(new TypeError("Failed to fetch"), { fallback: "x" })).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("returns Japanese for every common English backend detail", () => {
    const english = [
      apiError(429, "Too many staff authentication attempts. Please try again later."),
      apiError(503, "Google Maps API key is not configured"),
      apiError(500, "Internal Server Error"),
      new Error("VITE_API_BASE_URL is not configured"),
      new Error("Invalid JSON response (502)"),
    ];
    for (const err of english) {
      expect(toUserMessage(err, { fallback: "失敗しました。" })).not.toMatch(/[A-Za-z]{4,}/);
    }
  });
});
