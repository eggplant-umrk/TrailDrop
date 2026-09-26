import { describe, expect, it } from "vitest";
import { isUuid, randomUuid } from "./uuid";

describe("randomUuid", () => {
  it("returns a v4 UUID accepted by the Backend", () => {
    expect(isUuid(randomUuid())).toBe(true);
    expect(randomUuid()).not.toBe(randomUuid());
  });

  it("builds a v4 UUID with getRandomValues when randomUUID is unavailable (non-HTTPS)", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const value = randomUuid();
      expect(isUuid(value)).toBe(true);
      expect(value[14]).toBe("4");
      expect(["8", "9", "a", "b"]).toContain(value[19]);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});
