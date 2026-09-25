// 商品ID → 商品画像(frontend/public/items/ に置くファイル)の対応表。
// 商品データ(API・DB)には画像URLを持たせず、フロント側だけで対応付ける。
//
// - 置く画像は、チームで撮影したもの・使用許諾を確認したものだけにする。
// - 形式はwebp、400×400px程度・1枚30KB程度を目安にする。
// - 実DBの商品は、Supabaseのitems.id(UUID)を確認してから追加する
//   (推測でUUIDを登録しない)。
// - 対応表に無い商品・読み込めなかった画像は、ItemThumbnailがplaceholderを
//   表示する。
//
// 追加例:
//   "wood-001": "/items/firewood.webp",               // DEMO_MODE
//   "00000000-0000-4000-8000-000000000000": "/items/firewood.webp", // 実DB
const ITEM_IMAGES = {};

export function getItemImage(itemId) {
  if (itemId === null || itemId === undefined) return null;
  return ITEM_IMAGES[String(itemId)] ?? null;
}
