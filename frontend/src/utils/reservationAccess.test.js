import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAccessToken,
  isAccessTokenPersisted,
  loadAccessToken,
  saveAccessToken,
} from "./reservationAccess";

describe("reservationAccess", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("saves to both sessionStorage and localStorage", () => {
    saveAccessToken("res-1", "token-1");

    expect(sessionStorage.getItem("traildrop_access_token_res-1")).toBe("token-1");
    expect(localStorage.getItem("traildrop_access_token_res-1")).toBe("token-1");
  });

  it("loadAccessToken prefers sessionStorage over localStorage", () => {
    sessionStorage.setItem("traildrop_access_token_res-1", "session-token");
    localStorage.setItem("traildrop_access_token_res-1", "local-token");

    expect(loadAccessToken("res-1")).toBe("session-token");
  });

  it("loadAccessToken falls back to localStorage when sessionStorage is empty", () => {
    localStorage.setItem("traildrop_access_token_res-1", "local-token");

    expect(loadAccessToken("res-1")).toBe("local-token");
  });

  it("isAccessTokenPersisted reflects localStorage only", () => {
    expect(isAccessTokenPersisted("res-1")).toBe(false);
    saveAccessToken("res-1", "token-1");
    expect(isAccessTokenPersisted("res-1")).toBe(true);
  });

  it("clearAccessToken removes from both storages", () => {
    saveAccessToken("res-1", "token-1");

    clearAccessToken("res-1");

    expect(sessionStorage.getItem("traildrop_access_token_res-1")).toBeNull();
    expect(localStorage.getItem("traildrop_access_token_res-1")).toBeNull();
    expect(isAccessTokenPersisted("res-1")).toBe(false);
  });

  it("saveAccessToken does nothing (returns false) without a reservationId or token", () => {
    expect(saveAccessToken(null, "token-1")).toBe(false);
    expect(saveAccessToken("res-1", null)).toBe(false);
  });
});
