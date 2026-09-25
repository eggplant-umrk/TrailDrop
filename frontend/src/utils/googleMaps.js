// 予約完了画面の「Google Mapsでルートを開く」用のURL。originは付けず、
// Google Maps側で端末の現在地から開始させる。受取地点の座標が分かっている
// (route modeの候補)場合は、名前の検索より正確な座標を経由地にする。
export function buildGoogleMapsUrl({ destination, passPoint, passPointLat, passPointLng }) {
  const hasCoordinates = Number.isFinite(passPointLat) && Number.isFinite(passPointLng);
  const params = new URLSearchParams({
    api: "1",
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
