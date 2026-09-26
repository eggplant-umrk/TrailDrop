import { describe, expect, it } from "vitest";
import { getShopName } from "./shopNames";

describe("getShopName", () => {
  it("resolves the product-master shop UUIDs", () => {
    expect(getShopName("b1111111-1111-4111-8111-111111111111")).toBe(
      "七宗食品「こぶしの里」",
    );
    expect(getShopName("b2222222-2222-4222-8222-222222222222")).toBe(
      "炭火焼肉たつみや",
    );
    expect(getShopName("b3333333-3333-4333-8333-333333333333")).toBe("福薪");
    expect(getShopName("b4444444-4444-4444-8444-444444444444")).toBe(
      "株式会社菊泉本舗",
    );
  });

  it("does not guess an unknown provider", () => {
    expect(getShopName("unknown")).toBeNull();
    expect(getShopName(null)).toBeNull();
  });
});
