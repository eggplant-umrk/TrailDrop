// ルート分析結果(POST /routes/analyze)から、受取地点の候補を画面用に整える。
//
// - route mode: pickup_candidates(ルート上の順)をそのまま使う。
// - fixed mode / 旧形式の保存済み結果: pickup_candidatesが無い(または空の)まま
//   pass_pointだけがあるため、それを座標なしの1候補として扱う。
// - 候補なし(pass_point = null): 空配列。
// 候補の切り替えはこの取得済みの情報だけで行い、APIは呼ばない。

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePickupCandidates(result) {
  if (!result) return [];
  const listed = Array.isArray(result.pickup_candidates) ? result.pickup_candidates : [];
  const candidates = listed
    .filter((c) => c && typeof c.name === "string" && c.name && c.pass_at)
    .map((c) => ({
      name: c.name,
      lat: finiteOrNull(c.lat),
      lng: finiteOrNull(c.lng),
      pass_at: c.pass_at,
      distance_from_route_meters: finiteOrNull(c.distance_from_route_meters),
    }));
  if (candidates.length > 0) return candidates;

  if (typeof result.pass_point === "string" && result.pass_point && result.pass_at) {
    return [
      {
        name: result.pass_point,
        lat: finiteOrNull(result.pass_point_lat),
        lng: finiteOrNull(result.pass_point_lng),
        pass_at: result.pass_at,
        distance_from_route_meters: null,
      },
    ];
  }
  return [];
}

// 選択中の候補。保存済みの名前が今の候補に無ければ、ルート上で最初の候補。
export function selectPickupCandidate(candidates, selectedName) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return candidates.find((c) => c.name === selectedName) || candidates[0];
}

// 「ルートから約1.2km」等の表示用。距離が無い(fixed mode)場合はnull。
export function formatDistanceFromRoute(meters) {
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) return null;
  if (meters < 50) return "ルート沿い";
  if (meters < 1000) return `ルートから約${Math.round(meters / 10) * 10}m`;
  return `ルートから約${(meters / 1000).toFixed(1)}km`;
}
