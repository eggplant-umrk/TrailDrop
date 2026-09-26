import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  verifyQr: vi.fn(),
  getStaffReservation: vi.fn(),
}));

vi.mock("../api/client", () => ({ default: apiMocks }));
vi.mock("../components/QrScanner", () => ({
  default: ({ onDetected }) => (
    <button
      type="button"
      data-testid="mock-scanner"
      onClick={() => onDetected("11111111-1111-4111-8111-111111111111")}
    >
      QRを検出
    </button>
  ),
}));

import StaffScan, { scanErrorMessage } from "./StaffScan";
import App from "../App";

let container;
let root;

function buttonByText(text) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === text);
}

async function enterStaffToken() {
  const input = container.querySelector('input[type="password"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "staff-secret");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    buttonByText("受取端末を開始").click();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  window.history.pushState({}, "", "/");
  apiMocks.verifyQr.mockReset();
  apiMocks.getStaffReservation.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe("StaffScan", () => {
  it("is available at /staff/scan without replacing /staff/verify", async () => {
    window.history.pushState({}, "", "/staff/scan");
    await act(async () => root.render(<App />));
    expect(container.textContent).toContain("受取端末の準備");

    await act(async () => root.unmount());
    root = createRoot(container);
    window.history.pushState({}, "", "/staff/verify");
    await act(async () => root.render(<App />));
    expect(container.textContent).toContain("スタッフ用画面");
  });

  it("shows setup first, then starts the scanner and keeps the token in sessionStorage", async () => {
    await act(async () => root.render(<StaffScan />));

    expect(container.textContent).toContain("受取端末の準備");
    expect(container.querySelector('[data-testid="mock-scanner"]')).toBeNull();

    await enterStaffToken();

    expect(sessionStorage.getItem("traildrop_staff_token")).toBe("staff-secret");
    expect(container.textContent).toContain("受取QRコードをかざしてください");
    expect(container.querySelector('[data-testid="mock-scanner"]')).not.toBeNull();
  });

  it("verifies a detected QR once and shows the reservation item and user", async () => {
    apiMocks.verifyQr.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      item_id: "a1111111-1111-4111-8111-111111111111",
      user_name: "展示テスト太郎",
      status: "completed",
    });
    apiMocks.getStaffReservation.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      item_title: "鮎の甘露煮の燻製 100gパック",
      user_name: "展示テスト太郎",
      status: "completed",
    });
    await act(async () => root.render(<StaffScan />));
    await enterStaffToken();

    const scanner = container.querySelector('[data-testid="mock-scanner"]');
    await act(async () => {
      scanner.click();
      scanner.click();
    });

    expect(apiMocks.verifyQr).toHaveBeenCalledTimes(1);
    expect(apiMocks.verifyQr).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "staff-secret",
    );
    expect(apiMocks.getStaffReservation).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "staff-secret",
    );
    expect(container.textContent).toContain("受取完了");
    expect(container.textContent).toContain("鮎の甘露煮の燻製 100gパック");
    expect(container.textContent).toContain("展示テスト太郎 さん");
  });

  it("uses an existing session token and opens directly in scan mode", async () => {
    sessionStorage.setItem("traildrop_staff_token", "saved-staff-secret");

    await act(async () => root.render(<StaffScan />));

    expect(container.textContent).toContain("受取QRコードをかざしてください");
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
});

describe("scanErrorMessage", () => {
  it("shows a completed-specific message", () => {
    expect(
      scanErrorMessage({ status: 409, message: "Reservation is already completed" }),
    ).toBe("このQRコードはすでに使用されています");
  });

  it("shows a cancelled-specific message", () => {
    expect(scanErrorMessage({ status: 409, message: "Reservation is cancelled" })).toBe(
      "この予約はキャンセルされています",
    );
  });

  it("uses a safe Japanese fallback for other failures", () => {
    expect(scanErrorMessage({ status: 502, message: "Failed to verify QR token" })).toBe(
      "受取確認に失敗しました",
    );
  });
});
