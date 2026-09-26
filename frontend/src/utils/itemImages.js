// 商品ID → 商品画像(frontend/public/items/ に置くファイル)の対応表。
// 商品データ(API・DB)には画像URLを持たせず、フロント側だけで対応付ける。
//
// - 置く画像は、チームで撮影したもの・使用許諾を確認したものだけにする。
// - 新規追加時はwebp、400×400px程度・1枚30KB程度を目安にする。今回の
//   正式提供画像は内容を加工せず、そのままのPNGで配置している。
// - 実DBの商品は、Supabaseのitems.id(UUID)を確認してから追加する
//   (推測でUUIDを登録しない)。
// - 対応表に無い商品・読み込めなかった画像は、ItemThumbnailがplaceholderを
//   表示する。
//
const ITEM_IMAGES = {
  "a1111111-1111-4111-8111-111111111111": "/items/ayu-kunsei.png",
  "a2222222-2222-4222-8222-222222222222": "/items/keichan.png",
  "a3333333-3333-4333-8333-333333333333": "/items/hinoki-maki.png",
  "a4444444-4444-4444-8444-444444444444": "/items/kuntama.png",
  "a5555555-5555-4555-8555-555555555555": "/items/ocha-senbei.png",
};

export function getItemImage(itemId) {
  if (itemId === null || itemId === undefined) return null;
  return ITEM_IMAGES[String(itemId)] ?? null;
}
