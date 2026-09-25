import { describe, expect, it } from "vitest";
import {
  formatPickupHours,
  isItemAvailableAt,
  jstMinutesSinceMidnight,
  parseTimeStringToMinutes,
} from "./RouteTest.jsx";

describe("parseTimeStringToMinutes", () => {
  it("parses HH:MM:SS", () => {
    expect(parseTimeStringToMinutes("09:30:00")).toBe(9 * 60 + 30);
  });

  it("parses HH:MM", () => {
    expect(parseTimeStringToMinutes("18:00")).toBe(18 * 60);
  });

  it("returns null for non-string / malformed input", () => {
    expect(parseTimeStringToMinutes(null)).toBeNull();
    expect(parseTimeStringToMinutes(undefined)).toBeNull();
    expect(parseTimeStringToMinutes("not-a-time")).toBeNull();
  });
});

describe("formatPickupHours", () => {
  it("extracts HH:MM from HH:MM:SS", () => {
    expect(formatPickupHours("09:00:00")).toBe("09:00");
  });

  it("returns null for non-string input", () => {
    expect(formatPickupHours(null)).toBeNull();
  });
});

describe("jstMinutesSinceMidnight", () => {
  it("converts a UTC instant to JST minutes-since-midnight", () => {
    // 2026-01-01T09:00:00Z = 2026-01-01 18:00 JST
    const date = new Date("2026-01-01T09:00:00Z");
    expect(jstMinutesSinceMidnight(date)).toBe(18 * 60);
  });
});

describe("isItemAvailableAt (PR #20: point-in-time availability judgment)", () => {
  const item0918 = { pickup_available_from: "09:00:00", pickup_available_to: "18:00:00" };
  const itemNoHours = { pickup_available_from: null, pickup_available_to: null };

  it("is available when the effective time is inside business hours", () => {
    expect(isItemAvailableAt(item0918, 9 * 60 + 30)).toBe(true);
  });

  it("is not available when the effective time is after closing", () => {
    // Regression case from PR #20's bug report: pass_at 18:40 vs 09:00-18:00.
    expect(isItemAvailableAt(item0918, 18 * 60 + 40)).toBe(false);
  });

  it("is not available when the effective time is before opening", () => {
    expect(isItemAvailableAt(item0918, 8 * 60)).toBe(false);
  });

  it("treats the opening boundary as available", () => {
    expect(isItemAvailableAt(item0918, 9 * 60)).toBe(true);
  });

  it("treats the closing boundary as available", () => {
    expect(isItemAvailableAt(item0918, 18 * 60)).toBe(true);
  });

  it("is never available when pickup hours are not set", () => {
    expect(isItemAvailableAt(itemNoHours, 12 * 60)).toBe(false);
  });
});
