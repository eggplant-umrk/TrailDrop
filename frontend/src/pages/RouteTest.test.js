import { describe, expect, it } from "vitest";
import { DEPARTURE_IN_PAST_MESSAGE } from "./RouteTest.jsx";

// 受取時間帯・24時間受取の判定はutils/pickupHours.test.js、検索条件と結果の
// 整合はutils/routeSearch.test.js、保存状態の復元はRouteTestState.test.jsで確認する。
describe("RouteTest messages", () => {
  it("explains why a past departure time was rejected", () => {
    expect(DEPARTURE_IN_PAST_MESSAGE).toContain("出発日時が現在より前");
  });
});
