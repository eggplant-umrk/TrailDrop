// RouteTest経由の予約完了画面(ReservationComplete.jsx)でGoogle Mapsボタンを
// 表示するための経路情報(origin/destination/passPoint)の保存。
// - 以前はsessionStorage(タブ単位)だけだったため、別タブ・新規タブで
//   完了画面を開くとボタンが出なかった(一括修正U6)。
// - localStorageで端末単位に保持しつつ、古い経路情報を無期限に保持しない
//   ようTTLを設ける(一括修正U6)。
// - qr_token/access_tokenなどの秘密情報は一切扱わない。
// - passPointLat/passPointLngは受取地点の座標(route modeの候補のみ)。任意で、
//   あればGoogle Mapsの経由地に使う。無い(fixed mode・旧データ)場合は地点名。
//   利用者の現在地の座標はここに保存しない。

const KEY_PREFIX = "traildrop_route_";
const TTL_MS = 24 * 60 * 60 * 1000; // 24時間

function storageKey(reservationId) {
  return `${KEY_PREFIX}${reservationId}`;
}

function coordinatesOf(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) ? { passPointLat: lat, passPointLng: lng } : {};
}

export function saveRouteContext(
  reservationId,
  { origin, destination, passPoint, passPointLat, passPointLng },
) {
  if (!reservationId || !origin || !destination || !passPoint) return;
  try {
    localStorage.setItem(
      storageKey(reservationId),
      JSON.stringify({
        origin,
        destination,
        passPoint,
        ...coordinatesOf(passPointLat, passPointLng),
        savedAt: Date.now(),
      }),
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
    return {
      origin: parsed.origin,
      destination: parsed.destination,
      passPoint: parsed.passPoint,
      ...coordinatesOf(parsed.passPointLat, parsed.passPointLng),
    };
  } catch {
    return null;
  }
}
