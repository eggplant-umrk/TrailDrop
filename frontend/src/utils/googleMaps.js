// 「現在地を使う」を選んだ場合に出発地(origin)として保存・表示されるラベル。
// 座標は保存しないため、Google Mapsへはこの文字列を渡さず現在地に任せる。
export const CURRENT_LOCATION_LABEL = "現在地";

// 手入力の出発地(「東京」「名古屋」等)ならGoogle Mapsのoriginにする。
// 「現在地」・空の場合はoriginを付けず、Google Maps側で端末の現在地から開始させる。
export function isManualOrigin(origin) {
  return typeof origin === "string" && origin.trim() !== "" && origin.trim() !== CURRENT_LOCATION_LABEL;
}

// 予約完了画面の「Google Mapsでルートを開く」用のURL(出発地 → 受取地点 →
// 目的地)。受取地点の座標が分かっている(route modeの候補)場合は、名前の
// 検索より正確な座標を経由地にする。
export function buildGoogleMapsUrl({ origin, destination, passPoint, passPointLat, passPointLng }) {
  const hasCoordinates = Number.isFinite(passPointLat) && Number.isFinite(passPointLng);
  const params = new URLSearchParams({
    api: "1",
    ...(isManualOrigin(origin) ? { origin: origin.trim() } : {}),
    destination,
    waypoints: hasCoordinates ? `${passPointLat},${passPointLng}` : passPoint,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

// ルート情報が無い予約(商品一覧から直接予約した場合など)向け。目的地を推測で
// 補わず、受取地点そのものをGoogle Mapsで開く。
export function buildGoogleMapsPlaceUrl(placeName) {
  const params = new URLSearchParams({ api: "1", query: placeName });
  return `https://www.google.com/maps/search/?${params.toString()}`;
}
