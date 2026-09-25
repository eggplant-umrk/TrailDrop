import { describe, expect, it } from "vitest";
import { buildGoogleMapsUrl } from "./googleMaps";

function paramsOf(url) {
  const parsed = new URL(url);
  expect(`${parsed.origin}${parsed.pathname}`).toBe("https://www.google.com/maps/dir/");
  return Object.fromEntries(parsed.searchParams.entries());
}

describe("buildGoogleMapsUrl", () => {
  it("uses the pickup location's coordinates as the waypoint when available", () => {
    const params = paramsOf(
      buildGoogleMapsUrl({
        destination: "下呂温泉",
        passPoint: "道の駅A",
        passPointLat: 35.5123,
        passPointLng: 137.1456,
      }),
    );
    expect(params).toEqual({
      api: "1",
      destination: "下呂温泉",
      waypoints: "35.5123,137.1456",
      travelmode: "driving",
    });
  });

  it("falls back to the pickup location name without coordinates (fixed mode / old data)", () => {
    const params = paramsOf(
      buildGoogleMapsUrl({ destination: "下呂温泉", passPoint: "道の駅 ロック・ガーデンひちそう" }),
    );
    expect(params.waypoints).toBe("道の駅 ロック・ガーデンひちそう");
  });

  it.each([
    [35.5, undefined],
    [null, 137.1],
    [Number.NaN, 137.1],
    ["35.5", "137.1"],
  ])("ignores incomplete or invalid coordinates (%s, %s)", (lat, lng) => {
    const params = paramsOf(
      buildGoogleMapsUrl({ destination: "下呂温泉", passPoint: "道の駅A", passPointLat: lat, passPointLng: lng }),
    );
    expect(params.waypoints).toBe("道の駅A");
  });

  it("never includes an origin, so Google Maps starts from the device's current location", () => {
    const params = paramsOf(buildGoogleMapsUrl({ destination: "下呂温泉", passPoint: "道の駅A" }));
    expect(params).not.toHaveProperty("origin");
  });
});
