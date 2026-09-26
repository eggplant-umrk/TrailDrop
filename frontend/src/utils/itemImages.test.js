import { describe, expect, it } from "vitest";
import { getItemImage } from "./itemImages";

describe("getItemImage", () => {
  it("maps every product-master UUID to its provided image", () => {
    expect(getItemImage("a1111111-1111-4111-8111-111111111111")).toBe(
      "/items/ayu-kunsei.png",
    );
    expect(getItemImage("a2222222-2222-4222-8222-222222222222")).toBe(
      "/items/keichan.png",
    );
    expect(getItemImage("a3333333-3333-4333-8333-333333333333")).toBe(
      "/items/hinoki-maki.png",
    );
    expect(getItemImage("a4444444-4444-4444-8444-444444444444")).toBe(
      "/items/kuntama.png",
    );
    expect(getItemImage("a5555555-5555-4555-8555-555555555555")).toBe(
      "/items/ocha-senbei.png",
    );
  });

  it("keeps the fallback path for unknown or missing product IDs", () => {
    expect(getItemImage("unknown")).toBeNull();
    expect(getItemImage(null)).toBeNull();
  });
});
