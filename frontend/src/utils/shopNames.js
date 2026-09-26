// GET /itemsは提供元をshop_idで返す。商品カードでは店舗名が必要だが、
// DB/API契約に無い独自フィールドを商品データへ足さず、既知の店舗UUIDだけを
// Frontendの表示名へ対応付ける。未知のUUIDは推測せずnullを返す。
const SHOP_NAMES = {
  "b1111111-1111-4111-8111-111111111111": "七宗食品「こぶしの里」",
  "b2222222-2222-4222-8222-222222222222": "炭火焼肉たつみや",
  "b3333333-3333-4333-8333-333333333333": "福薪",
  "b4444444-4444-4444-8444-444444444444": "株式会社菊泉本舗",
};

export function getShopName(shopId) {
  if (shopId === null || shopId === undefined) return null;
  return SHOP_NAMES[String(shopId)] ?? null;
}
