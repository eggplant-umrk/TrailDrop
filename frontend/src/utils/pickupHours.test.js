import { describe, expect, it } from "vitest";
import {
  findWindowOffsetForItem,
  nowDepartureInputValue,
  suggestDepartureForItem,
  toJstDateTimeInputValue,
} from "./pickupHours";

const item0918 = { pickup_available_from: "09:00:00", pickup_available_to: "18:00:00" };
const itemNoHours = { pickup_available_from: null, pickup_available_to: null };
const range = { stepMinutes: 30, maxMinutes: 180 };

describe("findWindowOffsetForItem", () => {
  it("returns 0 when the item is already available", () => {
    // 2026-01-01 12:00 JST
    expect(findWindowOffsetForItem(item0918, Date.parse("2026-01-01T03:00:00Z"), range)).toBe(0);
  });

  it("returns the smallest forward offset when pass_at is before opening", () => {
    // 07:40 JST -> +90 = 09:10
    expect(findWindowOffsetForItem(item0918, Date.parse("2025-12-31T22:40:00Z"), range)).toBe(90);
  });

  it("returns a backward offset when pass_at is after closing", () => {
    // 18:40 JST -> -60 = 17:40
    expect(findWindowOffsetForItem(item0918, Date.parse("2026-01-01T09:40:00Z"), range)).toBe(-60);
  });

  it("returns null when the slider range cannot reach the pickup hours", () => {
    // 01:00 JST: +180 = 04:00 is still before opening
    expect(findWindowOffsetForItem(item0918, Date.parse("2025-12-31T16:00:00Z"), range)).toBeNull();
  });

  it("returns null for items without pickup hours", () => {
    expect(findWindowOffsetForItem(itemNoHours, Date.parse("2026-01-01T03:00:00Z"), range)).toBeNull();
  });
});

describe("suggestDepartureForItem", () => {
  it("suggests a same-day departure that arrives shortly after opening", () => {
    // departure 00:00 JST, pass_at 01:00 JST -> target 10:00 JST -> depart 09:00 JST
    const departureMs = Date.parse("2025-12-31T15:00:00Z");
    const passAtMs = Date.parse("2025-12-31T16:00:00Z");
    expect(
      suggestDepartureForItem(item0918, { passAtMs, departureMs, nowMs: departureMs }),
    ).toBe("2026-01-01T09:00");
  });

  it("rolls over to the next day when the pickup hours have passed", () => {
    // departure 19:00 JST, pass_at 20:00 JST -> next day 10:00 JST -> depart 09:00 JST
    const departureMs = Date.parse("2026-01-01T10:00:00Z");
    const passAtMs = Date.parse("2026-01-01T11:00:00Z");
    expect(
      suggestDepartureForItem(item0918, { passAtMs, departureMs, nowMs: departureMs }),
    ).toBe("2026-01-02T09:00");
  });

  it("returns null for items without pickup hours", () => {
    expect(suggestDepartureForItem(itemNoHours, { passAtMs: 0, departureMs: 0 })).toBeNull();
  });
});

describe("departure input values", () => {
  it("formats an instant as a JST datetime-local value", () => {
    expect(toJstDateTimeInputValue(Date.parse("2026-01-01T00:30:00Z"))).toBe("2026-01-01T09:30");
  });

  it("puts 'now' slightly in the future, rounded up to the minute", () => {
    expect(nowDepartureInputValue(Date.parse("2026-01-01T00:30:10Z"))).toBe("2026-01-01T09:33");
  });
});
