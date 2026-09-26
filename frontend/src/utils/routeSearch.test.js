import { describe, expect, it } from "vitest";
import {
  NOW_RESULT_MAX_AGE_MS,
  buildSearchKey,
  isNowResultOutdated,
  resultBookingState,
  sanitizeRestoredRouteState,
} from "./routeSearch";

const NOW = Date.parse("2026-09-27T09:00:00+09:00");

const tokyoToGero = {
  useCurrentOrigin: false,
  origin: "東京",
  destination: "下呂",
  departureMode: "custom",
  departureAt: "2026-09-27T10:00",
};

describe("入力条件を変えたら古い検索結果では予約できない (P2-6)", () => {
  const searchedKey = buildSearchKey(tokyoToGero);

  it("検索したときの条件のままなら予約できる", () => {
    expect(
      resultBookingState({ currentKey: buildSearchKey(tokyoToGero), searchedKey, searchedDepartureMode: "custom" }, NOW),
    ).toEqual({ ok: true, reason: null });
  });

  it.each([
    ["目的地を大阪に変更", { destination: "大阪" }],
    ["出発地を名古屋に変更", { origin: "名古屋" }],
    ["出発日時を変更", { departureAt: "2026-09-27T11:00" }],
    ["「今すぐ」に切り替え", { departureMode: "now" }],
    ["現在地に切り替え", { useCurrentOrigin: true }],
  ])("%s → 再検索するまで予約できない", (_, change) => {
    const currentKey = buildSearchKey({ ...tokyoToGero, ...change });
    expect(resultBookingState({ currentKey, searchedKey, searchedDepartureMode: "custom" }, NOW)).toEqual({
      ok: false,
      reason: "changed",
    });
  });

  it("前後の空白だけの違いは変更とみなさない", () => {
    const currentKey = buildSearchKey({ ...tokyoToGero, destination: " 下呂 " });
    expect(resultBookingState({ currentKey, searchedKey, searchedDepartureMode: "custom" }, NOW).ok).toBe(true);
  });

  it("「今すぐ」では日時欄の値は条件に含めない", () => {
    const a = buildSearchKey({ ...tokyoToGero, departureMode: "now", departureAt: "2026-09-27T10:00" });
    const b = buildSearchKey({ ...tokyoToGero, departureMode: "now", departureAt: "" });
    expect(a).toBe(b);
  });

  it("検索結果の条件が記録されていなければ(旧データ)予約させない", () => {
    expect(resultBookingState({ currentKey: buildSearchKey(tokyoToGero), searchedKey: null }, NOW).ok).toBe(false);
  });
});

describe("「今すぐ」の古い検索結果では予約できない (P2-7)", () => {
  const key = buildSearchKey({ ...tokyoToGero, departureMode: "now" });

  it("検索から10分以内なら予約できる", () => {
    const state = { currentKey: key, searchedKey: key, searchedDepartureMode: "now", searchedAtMs: NOW };
    expect(resultBookingState(state, NOW + NOW_RESULT_MAX_AGE_MS).ok).toBe(true);
  });

  it("10分を過ぎたら再検索を求める", () => {
    const state = { currentKey: key, searchedKey: key, searchedDepartureMode: "now", searchedAtMs: NOW };
    expect(resultBookingState(state, NOW + NOW_RESULT_MAX_AGE_MS + 1)).toEqual({ ok: false, reason: "outdated" });
  });

  it("日時を指定した検索は時間が経っても古くならない", () => {
    expect(isNowResultOutdated({ searchedDepartureMode: "custom", searchedAtMs: NOW }, NOW + 60 * 60 * 1000)).toBe(false);
  });

  it("復元時、古い「今すぐ」の結果は捨てて入力内容だけ戻す", () => {
    const restored = sanitizeRestoredRouteState(
      {
        origin: "名古屋駅",
        destination: "下呂温泉",
        departureMode: "now",
        searchedDepartureMode: "now",
        searchedAtMs: NOW,
        searchedKey: "k",
        result: { pass_point: "道の駅 ロック・ガーデンひちそう" },
        windowOffsetMinutes: 60,
      },
      NOW + NOW_RESULT_MAX_AGE_MS + 1,
    );
    expect(restored.result).toBeNull();
    expect(restored.searchedKey).toBeNull();
    expect(restored.windowOffsetMinutes).toBe(0);
    expect(restored.destination).toBe("下呂温泉");
    expect(restored.resultExpiredOnRestore).toBe(true);
  });
});

describe("「現在地」の復元で出発地の表示が矛盾しない (P2-4)", () => {
  it("現在地で検索した状態を復元すると、過去に手入力した出発地は表示しない", () => {
    const restored = sanitizeRestoredRouteState(
      { origin: "名古屋駅", useCurrentOrigin: true, departureMode: "custom", result: { origin: "現在地" } },
      NOW,
    );
    expect(restored.useCurrentOrigin).toBe(true);
    expect(restored.origin).toBe("");
    expect(restored.result.origin).toBe("現在地");
  });
});
