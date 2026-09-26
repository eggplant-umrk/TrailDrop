import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// /staff/verify の手入力による受取確認(カメラを使わない管理画面の経路)が
// 従来どおり動くこと。
const apiMocks = vi.hoisted(() => ({
  verifyQr: vi.fn(),
  getItems: vi.fn(),
}));
vi.mock("../api/client", () => ({ default: apiMocks }));

const { default: StaffVerify } = await import("./StaffVerify.jsx");

const QR_TOKEN = "11111111-1111-4111-8111-111111111111";

let container;
let root;

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function inputByLabel(text) {
  const label = [...container.querySelectorAll("label")].find((l) => l.textContent.includes(text));
  return label.querySelector("input");
}

async function submitManualVerify() {
  await act(async () => setInputValue(inputByLabel("スタッフトークン"), "staff-secret"));
  await act(async () => setInputValue(inputByLabel("QRトークン（手入力）"), ` ${QR_TOKEN} `));
  await act(async () => {
    inputByLabel("QRトークン（手入力）")
      .closest("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  apiMocks.verifyQr.mockReset();
  apiMocks.getItems.mockReset().mockResolvedValue([{ id: "item-1", title: "薪" }]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <StaffVerify />
      </MemoryRouter>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe("StaffVerify manual entry", () => {
  it("keeps the manual QR token field and verifies with the trimmed token", async () => {
    apiMocks.verifyQr.mockResolvedValue({ id: "r1", item_id: "item-1", user_name: "テスト太郎", status: "completed" });

    await submitManualVerify();

    expect(apiMocks.verifyQr).toHaveBeenCalledWith(QR_TOKEN, "staff-secret");
    expect(container.textContent).toContain("受取完了");
    expect(container.textContent).toContain("テスト太郎");
    expect(container.textContent).toContain("薪");
    expect(inputByLabel("QRトークン（手入力）").value).toBe("");
  });

  it("shows the already-completed message for a used QR token", async () => {
    const used = new Error("Reservation is already completed");
    used.status = 409;
    apiMocks.verifyQr.mockRejectedValue(used);

    await submitManualVerify();

    expect(container.textContent).toContain("この予約はすでに受取済みです。");
  });
});
