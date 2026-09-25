import { describe, expect, it } from "vitest";
import {
  formatDistanceFromRoute,
  normalizePickupCandidates,
  selectPickupCandidate,
} from "./pickupCandidates";

const routeModeResult = {
  origin: "現在地",
  destination: "下呂温泉",
  pass_point: "道の駅A",
  pass_at: "2999-01-01T10:00:00+09:00",
  pass_point_lat: 35.5,
  pass_point_lng: 137.1,
  pickup_candidates: [
    { name: "道の駅A", lat: 35.5, lng: 137.1, pass_at: "2999-01-01T10:00:00+09:00", distance_from_route_meters: 800 },
    { name: "道の駅B", lat: 35.7, lng: 137.2, pass_at: "2999-01-01T10:40:00+09:00", distance_from_route_meters: 20 },
  ],
  total_duration_minutes: 120,
  total_distance_meters: 60000,
};

describe("normalizePickupCandidates", () => {
  it("uses route-mode candidates in the order the backend returned (route order)", () => {
    const candidates = normalizePickupCandidates(routeModeResult);
    expect(candidates.map((c) => c.name)).toEqual(["道の駅A", "道の駅B"]);
    expect(candidates[1]).toEqual({
      name: "道の駅B",
      lat: 35.7,
      lng: 137.2,
      pass_at: "2999-01-01T10:40:00+09:00",
      distance_from_route_meters: 20,
    });
  });

  it("treats a fixed-mode response (no candidates, pass_point only) as one candidate without coordinates", () => {
    const fixed = {
      pass_point: "道の駅 ロック・ガーデンひちそう",
      pass_at: "2999-01-01T10:00:00+09:00",
      pass_point_lat: null,
      pass_point_lng: null,
      pickup_candidates: [],
    };
    expect(normalizePickupCandidates(fixed)).toEqual([
      {
        name: "道の駅 ロック・ガーデンひちそう",
        lat: null,
        lng: null,
        pass_at: "2999-01-01T10:00:00+09:00",
        distance_from_route_meters: null,
      },
    ]);
  });

  it("stays compatible with an old saved RouteTest result that predates pickup_candidates", () => {
    const oldSavedResult = {
      origin: "名古屋駅",
      destination: "下呂温泉",
      pass_point: "道の駅 ロック・ガーデンひちそう",
      pass_at: "2999-01-01T10:00:00+09:00",
      total_duration_minutes: 120,
      total_distance_meters: 60000,
    };
    const candidates = normalizePickupCandidates(oldSavedResult);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("道の駅 ロック・ガーデンひちそう");
    expect(candidates[0].pass_at).toBe("2999-01-01T10:00:00+09:00");
  });

  it("returns no candidates when the route has no pickup location nearby (pass_point null)", () => {
    expect(
      normalizePickupCandidates({ pass_point: null, pass_at: null, pickup_candidates: [] }),
    ).toEqual([]);
  });

  it("returns no candidates for a missing result", () => {
    expect(normalizePickupCandidates(null)).toEqual([]);
    expect(normalizePickupCandidates(undefined)).toEqual([]);
  });

  it("drops malformed candidate entries and non-finite numbers", () => {
    const candidates = normalizePickupCandidates({
      pickup_candidates: [
        null,
        { name: "", pass_at: "2999-01-01T10:00:00+09:00" },
        { name: "no-time" },
        { name: "ok", lat: "35", lng: Number.NaN, pass_at: "2999-01-01T10:00:00+09:00", distance_from_route_meters: "5" },
      ],
    });
    expect(candidates).toEqual([
      { name: "ok", lat: null, lng: null, pass_at: "2999-01-01T10:00:00+09:00", distance_from_route_meters: null },
    ]);
  });
});

describe("selectPickupCandidate", () => {
  const candidates = normalizePickupCandidates(routeModeResult);

  it("defaults to the first candidate along the route", () => {
    expect(selectPickupCandidate(candidates, null).name).toBe("道の駅A");
  });

  it("switches to the chosen candidate using only the already-fetched data", () => {
    const selected = selectPickupCandidate(candidates, "道の駅B");
    expect(selected.name).toBe("道の駅B");
    expect(selected.pass_at).toBe("2999-01-01T10:40:00+09:00");
    expect([selected.lat, selected.lng]).toEqual([35.7, 137.2]);
  });

  it("falls back to the first candidate when a saved name is no longer offered", () => {
    expect(selectPickupCandidate(candidates, "閉鎖した地点").name).toBe("道の駅A");
  });

  it("returns null when there are no candidates", () => {
    expect(selectPickupCandidate([], "道の駅A")).toBeNull();
    expect(selectPickupCandidate(undefined, null)).toBeNull();
  });
});

describe("formatDistanceFromRoute", () => {
  it.each([
    [0, "ルート沿い"],
    [49, "ルート沿い"],
    [50, "ルートから約50m"],
    [804, "ルートから約800m"],
    [1000, "ルートから約1.0km"],
    [2950, "ルートから約3.0km"],
  ])("formats %s m as %s", (meters, expected) => {
    expect(formatDistanceFromRoute(meters)).toBe(expected);
  });

  it.each([null, undefined, Number.NaN, -1, "800"])("returns null for %s", (value) => {
    expect(formatDistanceFromRoute(value)).toBeNull();
  });
});
