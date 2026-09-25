import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRouteContext, saveRouteContext } from "./routeContext";

describe("routeContext", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a saved context", () => {
    saveRouteContext("res-1", {
      origin: "名古屋駅",
      destination: "下呂温泉",
      passPoint: "道の駅 ロック・ガーデンひちそう",
    });

    expect(loadRouteContext("res-1")).toEqual({
      origin: "名古屋駅",
      destination: "下呂温泉",
      passPoint: "道の駅 ロック・ガーデンひちそう",
    });
  });

  it("does not save when any field is missing", () => {
    saveRouteContext("res-1", { origin: "名古屋駅", destination: "", passPoint: "" });

    expect(loadRouteContext("res-1")).toBeNull();
  });

  it("returns null once the TTL has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    saveRouteContext("res-1", {
      origin: "名古屋駅",
      destination: "下呂温泉",
      passPoint: "道の駅 ロック・ガーデンひちそう",
    });

    // TTLは24時間。25時間進める。
    vi.setSystemTime(new Date("2026-01-02T01:00:00Z"));

    expect(loadRouteContext("res-1")).toBeNull();
  });

  it("returns null for an unknown reservation id", () => {
    expect(loadRouteContext("does-not-exist")).toBeNull();
  });

  it("round-trips the pickup location coordinates when present (route mode)", () => {
    saveRouteContext("r-coords", {
      origin: "現在地",
      destination: "下呂温泉",
      passPoint: "道の駅A",
      passPointLat: 35.5,
      passPointLng: 137.1,
    });
    expect(loadRouteContext("r-coords")).toEqual({
      origin: "現在地",
      destination: "下呂温泉",
      passPoint: "道の駅A",
      passPointLat: 35.5,
      passPointLng: 137.1,
    });
  });

  it("omits coordinates that are missing or invalid (fixed mode) and keeps the old shape", () => {
    saveRouteContext("r-fixed", {
      origin: "名古屋駅",
      destination: "下呂温泉",
      passPoint: "道の駅 ロック・ガーデンひちそう",
      passPointLat: null,
      passPointLng: undefined,
    });
    expect(loadRouteContext("r-fixed")).toEqual({
      origin: "名古屋駅",
      destination: "下呂温泉",
      passPoint: "道の駅 ロック・ガーデンひちそう",
    });
  });

  it("still reads a context saved before coordinates existed", () => {
    localStorage.setItem(
      "traildrop_route_r-old",
      JSON.stringify({ origin: "名古屋駅", destination: "下呂温泉", passPoint: "道の駅X", savedAt: Date.now() }),
    );
    expect(loadRouteContext("r-old")).toEqual({
      origin: "名古屋駅",
      destination: "下呂温泉",
      passPoint: "道の駅X",
    });
  });

  it("never stores the user's own location, only the pickup location's", () => {
    saveRouteContext("r-privacy", {
      origin: "現在地",
      destination: "下呂温泉",
      passPoint: "道の駅A",
      passPointLat: 35.5,
      passPointLng: 137.1,
      originLocation: { lat: 35.17, lng: 136.88 },
    });
    const raw = localStorage.getItem("traildrop_route_r-privacy");
    expect(raw).not.toContain("35.17");
    expect(raw).not.toContain("136.88");
  });
});
