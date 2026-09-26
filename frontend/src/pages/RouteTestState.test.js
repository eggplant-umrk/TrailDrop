import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRouteTestState, saveRouteTestState } from "./RouteTest.jsx";

// 一括修正m7/U6: RouteTestの入力・分析結果をlocalStorageに保存し、
// Google Routes APIを再実行せずに復元できること、TTLを超えたら復元しない
// ことを確認する。
describe("RouteTest state persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips the saved state", () => {
    const state = {
      origin: "名古屋駅",
      destination: "下呂温泉",
      departureAt: "2026-01-01T10:00",
      result: { pass_point: "道の駅 ロック・ガーデンひちそう" },
      windowOffsetMinutes: 30,
    };

    saveRouteTestState(state);
    const restored = loadRouteTestState();

    expect(restored.origin).toBe(state.origin);
    expect(restored.destination).toBe(state.destination);
    expect(restored.departureAt).toBe(state.departureAt);
    expect(restored.result).toEqual(state.result);
    expect(restored.windowOffsetMinutes).toBe(30);
  });

  it("returns null once the TTL (20 minutes) has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    saveRouteTestState({ origin: "名古屋駅", destination: "下呂温泉" });

    vi.setSystemTime(new Date("2026-01-01T00:21:00Z"));

    expect(loadRouteTestState()).toBeNull();
  });

  it("returns null when nothing has been saved", () => {
    expect(loadRouteTestState()).toBeNull();
  });

  it("restores a current-location search without the previously typed origin (P2-4)", () => {
    saveRouteTestState({
      origin: "名古屋駅",
      useCurrentOrigin: true,
      destination: "下呂温泉",
      departureMode: "custom",
      result: { origin: "現在地", destination: "下呂温泉" },
    });

    const restored = loadRouteTestState();

    expect(restored.useCurrentOrigin).toBe(true);
    expect(restored.origin).toBe("");
    expect(restored.result.origin).toBe("現在地");
  });

  it("treats an old-format saved current-location result as a current-location search", () => {
    saveRouteTestState({
      origin: "名古屋駅",
      destination: "下呂温泉",
      departureMode: "custom",
      result: { origin: "現在地", destination: "下呂温泉" },
    });

    const restored = loadRouteTestState();

    expect(restored.useCurrentOrigin).toBe(true);
    expect(restored.origin).toBe("");
  });

  it("drops a 'now' result older than 10 minutes but keeps the inputs (P2-7)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    saveRouteTestState({
      origin: "名古屋駅",
      destination: "下呂温泉",
      departureMode: "now",
      searchedDepartureMode: "now",
      searchedAtMs: Date.now(),
      searchedKey: "k",
      result: { pass_point: "道の駅 ロック・ガーデンひちそう" },
    });

    vi.setSystemTime(new Date("2026-01-01T00:11:00Z"));
    const restored = loadRouteTestState();

    expect(restored.result).toBeNull();
    expect(restored.origin).toBe("名古屋駅");
    expect(restored.destination).toBe("下呂温泉");
  });
});
