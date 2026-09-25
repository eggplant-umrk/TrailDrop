// 受取時間帯(RouteTestで選択したpickup window)が終了しているかの判定。
// Backend(models.py ReservationCreateのmodel_validator)と同じ基準で、
// end <= now なら終了とみなす。startが過去でもendが未来なら受取枠の途中で
// あり、まだ予約できる(PMレビューBLOCKER B1の仕様)。
// endが無い(ItemListから直接来た等)・解釈できない値は「終了していない」
// として扱い、判定はBackendに委ねる。
export function isPickupWindowEnded(pickupWindowEnd, nowMs = Date.now()) {
  if (!pickupWindowEnd) return false;
  const endMs = new Date(pickupWindowEnd).getTime();
  if (Number.isNaN(endMs)) return false;
  return endMs <= nowMs;
}

// 受取時間帯の終了までの残りミリ秒。終了済み・endが無い・解釈できない場合はnull。
export function msUntilPickupWindowEnds(pickupWindowEnd, nowMs = Date.now()) {
  if (!pickupWindowEnd) return null;
  const endMs = new Date(pickupWindowEnd).getTime();
  if (Number.isNaN(endMs) || endMs <= nowMs) return null;
  return endMs - nowMs;
}
