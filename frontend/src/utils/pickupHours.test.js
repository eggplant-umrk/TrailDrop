import { describe, expect, it } from "vitest";
import {
  WINDOW_OFFSET_MIN_MINUTES,
  clampWindowOffset,
  classifyItemsForWindow,
  findWindowOffsetForItem,
  isDepartureInputInFuture,
  isPickupWindowUsable,
  nowDepartureInputValue,
  pickupWindowAt,
  toJstDateTimeInputValue,
} from "./pickupHours";

const MIN = 60 * 1000;
// 七宗到着 23:30 JST (監査で見つかったケース)。
const PASS_AT = Date.parse("2026-09-27T23:30:00+09:00");
const BEFORE_DEPARTURE = Date.parse("2026-09-27T20:00:00+09:00");

const inStock = { id: "a", stock: 3 };
const soldOut = { id: "b", stock: 0 };

describe("受取時間帯は到着後に受け取れるものだけ (P1-1)", () => {
  it("到着予定を中心にした2時間の受取枠を作る", () => {
    const { startMs, endMs } = pickupWindowAt(PASS_AT, 0);
    expect(new Date(startMs).toISOString()).toBe("2026-09-27T13:30:00.000Z"); // 22:30 JST
    expect(new Date(endMs).toISOString()).toBe("2026-09-27T15:30:00.000Z"); // 24:30 JST
  });

  it("到着より前に終わる枠(19:59〜21:59のようなもの)は使えない", () => {
    expect(isPickupWindowUsable({ passAtMs: PASS_AT, offsetMinutes: -150, nowMs: BEFORE_DEPARTURE })).toBe(false);
    expect(isPickupWindowUsable({ passAtMs: PASS_AT, offsetMinutes: -90, nowMs: BEFORE_DEPARTURE })).toBe(false);
  });

  it("終了が到着予定ちょうどの枠は使える(境界: 終了 >= 到着)", () => {
    expect(isPickupWindowUsable({ passAtMs: PASS_AT, offsetMinutes: -60, nowMs: BEFORE_DEPARTURE })).toBe(true);
  });

  it("スライダーは到着前に終わる位置へ動かせない", () => {
    expect(WINDOW_OFFSET_MIN_MINUTES).toBe(-60);
    expect(clampWindowOffset(-180)).toBe(-60);
    expect(clampWindowOffset(-90)).toBe(-60);
    expect(clampWindowOffset(240)).toBe(180);
    expect(clampWindowOffset(Number.NaN)).toBe(0);
  });

  it("「受取時間をずらす」提案も到着前に終わる枠を候補にしない", () => {
    // 到着から2時間半後: 既定の枠(〜到着+60分)は終了済み。後ろへずらす提案だけが出る。
    const now = PASS_AT + 150 * MIN;
    const offset = findWindowOffsetForItem(inStock, PASS_AT, { nowMs: now });
    expect(offset).toBe(120);
    const { endMs } = pickupWindowAt(PASS_AT, offset);
    expect(endMs).toBeGreaterThanOrEqual(PASS_AT);
    expect(endMs).toBeGreaterThan(now);
  });

  it("出発前の検索では、ずらさずにそのまま使える(offset 0)", () => {
    expect(findWindowOffsetForItem(inStock, PASS_AT, { nowMs: BEFORE_DEPARTURE })).toBe(0);
  });

  it("スライダーの範囲では届かなければnull", () => {
    const now = PASS_AT + 5 * 60 * MIN;
    expect(findWindowOffsetForItem(inStock, PASS_AT, { nowMs: now })).toBeNull();
  });
});

describe("24時間受取(無人ロッカー) (P1-2)", () => {
  const items = [
    { id: "x", stock: 5, pickup_available_from: "07:00:00", pickup_available_to: "21:00:00" },
    { id: "y", stock: 5, pickup_available_from: null, pickup_available_to: null },
  ];

  it.each([
    ["深夜 02:30", "2026-09-28T02:30:00+09:00"],
    ["早朝 05:00", "2026-09-28T05:00:00+09:00"],
    ["夜 23:30", "2026-09-27T23:30:00+09:00"],
  ])("%s に到着する受取枠でも、全商品を予約できる(旧営業時間は無視)", (_, passAt) => {
    const passAtMs = Date.parse(passAt);
    const result = classifyItemsForWindow({
      items,
      passAtMs,
      offsetMinutes: 0,
      nowMs: passAtMs - 3 * 60 * MIN,
    });
    expect(result.windowUsable).toBe(true);
    expect(result.bookableItems.map((item) => item.id)).toEqual(["x", "y"]);
    expect(result.laterItems).toEqual([]);
  });
});

describe("受取枠終了後は予約できない (P2-8)", () => {
  it("枠の終了時刻を過ぎたら予約可能な商品が無くなり、時間変更の候補になる", () => {
    const { endMs } = pickupWindowAt(PASS_AT, 0);
    const before = classifyItemsForWindow({ items: [inStock], passAtMs: PASS_AT, offsetMinutes: 0, nowMs: endMs - 1 });
    const after = classifyItemsForWindow({ items: [inStock], passAtMs: PASS_AT, offsetMinutes: 0, nowMs: endMs });
    expect(before.bookableItems).toEqual([inStock]);
    expect(after.windowUsable).toBe(false);
    expect(after.bookableItems).toEqual([]);
    expect(after.laterItems).toEqual([inStock]);
    expect(after.laterOffset).toBe(30);
  });
});

describe("在庫切れは時間変更の候補にしない (P2-9)", () => {
  it("findWindowOffsetForItemは在庫0の商品にnullを返す", () => {
    expect(findWindowOffsetForItem(soldOut, PASS_AT, { nowMs: BEFORE_DEPARTURE })).toBeNull();
  });

  it("枠が終了していても、在庫切れの商品はlaterItemsに入らず在庫切れとして一覧に残る", () => {
    const result = classifyItemsForWindow({
      items: [inStock, soldOut],
      passAtMs: PASS_AT,
      offsetMinutes: 0,
      nowMs: PASS_AT + 90 * MIN,
    });
    expect(result.laterItems).toEqual([inStock]);
    expect(result.listedItems).toEqual([soldOut]);
  });

  it("使える枠なら、在庫切れは予約不可として一覧に出る(空白にしない)", () => {
    const result = classifyItemsForWindow({
      items: [soldOut],
      passAtMs: PASS_AT,
      offsetMinutes: 0,
      nowMs: BEFORE_DEPARTURE,
    });
    expect(result.listedItems).toEqual([soldOut]);
    expect(result.bookableItems).toEqual([]);
    expect(result.laterItems).toEqual([]);
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

describe("出発日時は検索時点の現在時刻で判定する (P2-12)", () => {
  const now = Date.parse("2026-01-01T00:30:00Z"); // 09:30 JST

  it("現在時刻より前(画面を開いたまま過ぎた値)は通さない", () => {
    expect(isDepartureInputInFuture("2026-01-01T09:20", now)).toBe(false);
    expect(isDepartureInputInFuture("2026-01-01T09:30", now)).toBe(false);
  });

  it("1分以上先なら通す", () => {
    expect(isDepartureInputInFuture("2026-01-01T09:31", now)).toBe(true);
  });

  it("空・不正な値は通さない", () => {
    expect(isDepartureInputInFuture("", now)).toBe(false);
    expect(isDepartureInputInFuture("not-a-date", now)).toBe(false);
  });
});
