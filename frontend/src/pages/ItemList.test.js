import { describe, expect, it } from "vitest";
import { mapItem } from "./ItemList";

describe("mapItem", () => {
  it("keeps the product-master fields used by the discovery card", () => {
    const serverItem = {
      id: "a4444444-4444-4444-8444-444444444444",
      title: "出来立てくんたま（3個入×5袋）通常パック",
      type: "pickup",
      price: 1500,
      stock: 10,
      location_name: "道の駅 ロック・ガーデンひちそう",
      pickup_available_from: null,
      pickup_available_to: null,
      shop_id: "b1111111-1111-4111-8111-111111111111",
      description: "岐阜県産の鶏卵を鮎だしで味付けした、こぶしの里の燻製卵。",
      category: "燻製卵",
      content_amount: "3個入×5袋",
      price_note: "デモ用設定価格。提供者の販売価格ではありません。",
      storage_method: "表示しない",
      source_url: "https://example.test/not-shown",
    };

    expect(mapItem(serverItem)).toEqual({
      id: serverItem.id,
      title: serverItem.title,
      type: "pickup",
      price: 1500,
      stock: 10,
      location_name: serverItem.location_name,
      shop_id: serverItem.shop_id,
      description: serverItem.description,
      category: "燻製卵",
      content_amount: "3個入×5袋",
      price_note: serverItem.price_note,
    });
  });
});
