import { describe, expect, it } from "vitest";
import { isPickupWindowEnded, msUntilPickupWindowEnds } from "./pickupWindow";

const NOW = Date.parse("2026-09-25T03:00:00.000Z");

describe("isPickupWindowEnded", () => {
  it("is false while the window end is in the future (even if start is past)", () => {
    expect(isPickupWindowEnded("2026-09-25T03:00:01.000Z", NOW)).toBe(false);
  });

  it("is true when end is exactly now (same boundary as the backend: end <= now)", () => {
    expect(isPickupWindowEnded("2026-09-25T03:00:00.000Z", NOW)).toBe(true);
  });

  it("is true when end is in the past", () => {
    expect(isPickupWindowEnded("2026-09-25T02:59:59.000Z", NOW)).toBe(true);
  });

  it("uses the current time when no now is passed", () => {
    expect(isPickupWindowEnded(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isPickupWindowEnded(new Date(Date.now() + 60000).toISOString())).toBe(false);
  });

  it("treats a missing or unparseable end as not ended", () => {
    expect(isPickupWindowEnded(undefined, NOW)).toBe(false);
    expect(isPickupWindowEnded(null, NOW)).toBe(false);
    expect(isPickupWindowEnded("not-a-date", NOW)).toBe(false);
  });
});

describe("msUntilPickupWindowEnds", () => {
  it("returns the remaining milliseconds until the end", () => {
    expect(msUntilPickupWindowEnds("2026-09-25T03:05:00.000Z", NOW)).toBe(5 * 60 * 1000);
  });

  it("returns null once ended, or when end is missing/invalid", () => {
    expect(msUntilPickupWindowEnds("2026-09-25T03:00:00.000Z", NOW)).toBeNull();
    expect(msUntilPickupWindowEnds(undefined, NOW)).toBeNull();
    expect(msUntilPickupWindowEnds("not-a-date", NOW)).toBeNull();
  });
});
