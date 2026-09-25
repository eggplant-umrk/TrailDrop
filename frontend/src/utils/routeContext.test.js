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
});
