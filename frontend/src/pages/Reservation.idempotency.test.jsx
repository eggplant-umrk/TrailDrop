import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isUuid } from "../utils/uuid";

// 予約確定の再送(タイムアウト後など)で同じidempotency keyを送ること、
// 429を「確実に作成されていない」失敗として扱うことを確認する。
const getItems = vi.fn();
const createReservation = vi.fn();
vi.mock("../api/client", () => ({ default: { getItems, createReservation } }));

const { default: Reservation } = await import("./Reservation.jsx");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ITEM = { id: "i1", title: "薪", price: 2800, stock: 2, type: "pickup", location_name: "道の駅" };
const CREATED = {
  id: "r1",
  item_id: "i1",
  user_name: "テスト太郎",
  status: "pending",
  access_token: "55555555-5555-4555-8555-555555555555",
};

let container;
let root;

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttonByText(text) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent.includes(text));
}

async function renderAt(path) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <BrowserRouter>
        <Routes>
          <Route path="/reserve/:id" element={<Reservation />} />
          <Route path="/reserve/:id/confirm" element={<Reservation />} />
          <Route path="/complete/:id" element={<p>complete-page</p>} />
        </Routes>
      </BrowserRouter>,
    );
  });
  await settle();
}

async function fillAndProceed(name) {
  await act(async () => setInputValue(container.querySelector('input[autocomplete="name"]'), name));
  await act(async () => container.querySelector('input[value="paypay"]').click());
  await act(async () => {
    container
      .querySelector("#reservation-form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function confirmPayment() {
  await act(async () => buttonByText("予約を確定する").click());
  await settle();
}

function sentKeys() {
  return createReservation.mock.calls.map(([args]) => args.idempotency_key);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  getItems.mockReset().mockResolvedValue([ITEM]);
  createReservation.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("reservation idempotency key", () => {
  it("resends the same key after an ambiguous failure, so the retry can't create a second reservation", async () => {
    const timeout = new Error("通信がタイムアウトしました。");
    createReservation.mockRejectedValueOnce(timeout).mockResolvedValueOnce(CREATED);
    await renderAt("/reserve/i1");
    await fillAndProceed("テスト太郎");

    await confirmPayment();
    expect(container.textContent).toContain("予約が完了したかどうか、この画面では確認できません");
    expect(container.textContent).toContain("二重に予約・お支払いされることはありません");
    expect(container.textContent).not.toContain("受取窓口");

    await confirmPayment();

    const [first, second] = sentKeys();
    expect(isUuid(first)).toBe(true);
    expect(second).toBe(first);
    expect(window.location.pathname).toBe("/complete/r1");
  });

  it("keeps the key when returning to the input step without changes, and uses a new key after a change", async () => {
    createReservation.mockRejectedValue(new Error("network"));
    await renderAt("/reserve/i1");
    await fillAndProceed("テスト太郎");
    await confirmPayment();

    await act(async () => buttonByText("入力内容を修正する").click());
    await settle();
    await fillAndProceed("テスト太郎");
    await confirmPayment();

    await act(async () => buttonByText("入力内容を修正する").click());
    await settle();
    await fillAndProceed("別の名前");
    await confirmPayment();

    const [first, unchanged, changed] = sentKeys();
    expect(unchanged).toBe(first);
    expect(changed).not.toBe(first);
    expect(isUuid(changed)).toBe(true);
  });

  it("treats 429 as definitely not created and shows a wait-and-retry message", async () => {
    const limited = new Error("Too many reservation requests. Please try again later.");
    limited.status = 429;
    createReservation.mockRejectedValueOnce(limited);
    await renderAt("/reserve/i1");
    await fillAndProceed("テスト太郎");

    await confirmPayment();

    expect(container.textContent).toContain("予約の操作が集中しています");
    expect(container.textContent).not.toContain("予約が完了したかどうか、この画面では確認できません");
  });
});
