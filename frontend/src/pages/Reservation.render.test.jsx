import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 確認画面 →「入力内容を修正する」→ 入力画面 →「‹ 商品に戻る」が、1回で
// 検索結果(RouteTest)へ戻ること(P2-5)。実際のブラウザ履歴(jsdom)で確認する。
const getItems = vi.fn();
vi.mock("../api/client", () => ({ default: { getItems } }));

const { default: Reservation } = await import("./Reservation.jsx");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ITEM = { id: "i1", title: "薪", price: 2800, stock: 2, type: "pickup", location_name: "道の駅" };

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

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  getItems.mockReset().mockResolvedValue([ITEM]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("Reservation back navigation", () => {
  it("returns to the search results with a single '‹ 商品に戻る' after editing from the confirm step", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <BrowserRouter>
          <Routes>
            <Route
              path="/"
              element={
                <Link to="/reserve/i1" state={{ origin: "名古屋駅", destination: "下呂温泉", passPoint: "道の駅" }}>
                  search-results
                </Link>
              }
            />
            <Route path="/reserve/:id" element={<Reservation />} />
            <Route path="/reserve/:id/confirm" element={<Reservation />} />
          </Routes>
        </BrowserRouter>,
      );
    });

    // 検索結果 → 入力画面
    await act(async () => container.querySelector("a").click());
    await settle();
    expect(window.location.pathname).toBe("/reserve/i1");

    // 入力 → 確認画面
    await act(async () => setInputValue(container.querySelector('input[autocomplete="name"]'), "テスト太郎"));
    await act(async () => container.querySelector('input[value="paypay"]').click());
    await act(async () => {
      container.querySelector("#reservation-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(window.location.pathname).toBe("/reserve/i1/confirm");

    // 確認 →「入力内容を修正する」→ 入力画面(入力内容は残る)
    await act(async () => buttonByText("入力内容を修正する").click());
    await settle();
    expect(window.location.pathname).toBe("/reserve/i1");
    expect(container.querySelector('input[autocomplete="name"]').value).toBe("テスト太郎");

    // 「‹ 商品に戻る」1回で検索結果へ
    await act(async () => buttonByText("商品に戻る").click());
    await settle();
    expect(window.location.pathname).toBe("/");
    expect(container.textContent).toContain("search-results");
  });
});
