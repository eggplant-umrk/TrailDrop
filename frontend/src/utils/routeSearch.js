// RouteTestの「入力中の検索条件」と「表示中の検索結果」を突き合わせるための
// 純粋関数。入力条件と結果が食い違ったまま予約へ進ませないために使う。

// 「今すぐ」で検索した結果を、そのまま予約に使ってよい時間。時間が進むと
// 到着予定・受取時間帯が実際の出発とずれていくため、これを過ぎたら
// 再検索してもらう(受取枠は2時間なので、10分のずれは実用上問題にならない)。
export const NOW_RESULT_MAX_AGE_MS = 10 * 60 * 1000;

// 検索条件を1つの文字列にする。「今すぐ」は日時の入力値を条件に含めない
// (検索のたびにその時点の現在時刻を使うため)。
export function buildSearchKey({ useCurrentOrigin, origin, destination, departureMode, departureAt }) {
  return JSON.stringify([
    useCurrentOrigin ? "current-location" : (origin ?? "").trim(),
    (destination ?? "").trim(),
    departureMode === "custom" ? "custom" : "now",
    departureMode === "custom" ? departureAt ?? "" : "",
  ]);
}

// 「今すぐ」で検索した結果が古くなったか。
export function isNowResultOutdated({ searchedDepartureMode, searchedAtMs }, nowMs = Date.now()) {
  if (searchedDepartureMode !== "now") return false;
  if (!Number.isFinite(searchedAtMs)) return true;
  return nowMs - searchedAtMs > NOW_RESULT_MAX_AGE_MS;
}

// 表示中の検索結果で予約へ進めるか。進めない場合はreasonで理由を返す。
//   - "changed":  検索後に出発地・目的地・出発日時が変更された
//   - "outdated": 「今すぐ」の検索から時間が経ち、到着予定がずれている
export function resultBookingState(
  { currentKey, searchedKey, searchedDepartureMode, searchedAtMs },
  nowMs = Date.now(),
) {
  if (!searchedKey || currentKey !== searchedKey) return { ok: false, reason: "changed" };
  if (isNowResultOutdated({ searchedDepartureMode, searchedAtMs }, nowMs)) {
    return { ok: false, reason: "outdated" };
  }
  return { ok: true, reason: null };
}

// 復元した保存状態を、入力欄と検索結果が矛盾しない形に整える。
// - 「現在地」で検索した結果: 現在地の座標は保存しないため、出発地は
//   「現在地から出発」のまま復元し、過去に手入力した出発地は表示しない。
// - 「今すぐ」で検索した古い結果: 到着予定・受取時間帯がずれているため
//   結果を捨て、入力内容だけを戻す(もう一度「探す」で最新の結果になる)。
export function sanitizeRestoredRouteState(state, nowMs = Date.now()) {
  if (!state) return state;
  const next = { ...state };
  if (next.useCurrentOrigin) {
    next.origin = "";
  }
  if (next.result && isNowResultOutdated(next, nowMs)) {
    next.result = null;
    next.searchedKey = null;
    next.searchedDepartureAt = null;
    next.selectedPickupName = null;
    next.windowOffsetMinutes = 0;
    next.resultExpiredOnRestore = true;
  }
  return next;
}
