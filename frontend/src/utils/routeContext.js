// RouteTest経由の予約完了画面(ReservationComplete.jsx)でGoogle Mapsボタンを
// 表示するための経路情報(origin/destination/passPoint)の保存。
// - 以前はsessionStorage(タブ単位)だけだったため、別タブ・新規タブで
//   完了画面を開くとボタンが出なかった(一括修正U6)。
// - localStorageで端末単位に保持しつつ、古い経路情報を無期限に保持しない
//   ようTTLを設ける(一括修正U6)。
// - qr_token/access_tokenなどの秘密情報は一切扱わない。

const KEY_PREFIX = "traildrop_route_";
const TTL_MS = 24 * 60 * 60 * 1000; // 24時間

function storageKey(reservationId) {
  return `${KEY_PREFIX}${reservationId}`;
}

export function saveRouteContext(reservationId, { origin, destination, passPoint }) {
  if (!reservationId || !origin || !destination || !passPoint) return;
  try {
    localStorage.setItem(
      storageKey(reservationId),
      JSON.stringify({ origin, destination, passPoint, savedAt: Date.now() }),
    );
  } catch {
    // 保存できなくてもGoogle Mapsボタンが出ないだけで、予約自体には影響しない。
  }
}

export function loadRouteContext(reservationId) {
  try {
    const raw = localStorage.getItem(storageKey(reservationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > TTL_MS) {
      localStorage.removeItem(storageKey(reservationId));
      return null;
    }
    if (!parsed.origin || !parsed.destination || !parsed.passPoint) return null;
    return { origin: parsed.origin, destination: parsed.destination, passPoint: parsed.passPoint };
  } catch {
    return null;
  }
}
