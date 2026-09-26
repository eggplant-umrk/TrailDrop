import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// RouteTestを実際に描画し、検索結果と入力条件・時刻の食い違いで
// 「予約する」リンクが出なくなることを確認する(APIはモック)。
const analyzeRoute = vi.fn();
const getItems = vi.fn();
vi.mock("../api/client", () => ({ default: { analyzeRoute, getItems } }));

const { default: RouteTest } = await import("./RouteTest.jsx");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-09-27T09:00:00+09:00");
const PASS_AT = "2026-09-27T10:30:00+09:00"; // 受取枠 09:30〜11:30

function routeResult({ origin = "名古屋駅", destination = "下呂温泉" } = {}) {
  return {
    origin,
    destination,
    total_duration_minutes: 130,
    pickup_candidates: [
      { name: "道の駅 ロック・ガーデンひちそう", lat: 35.5, lng: 137.1, pass_at: PASS_AT, distance_from_route_meters: 20 },
    ],
  };
}

const ITEMS = [
  { id: "i1", title: "薪", price: 2800, stock: 2, shop_id: null, location_name: "道の駅 ロック・ガーデンひちそう" },
  { id: "i2", title: "お茶せんべい", price: 700, stock: 0, shop_id: null, location_name: "道の駅 ロック・ガーデンひちそう" },
];

let container;
let root;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <RouteTest />
      </MemoryRouter>,
    );
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function search() {
  await act(async () => {
    container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

const reserveLinks = () => [...container.querySelectorAll('a[href^="/reserve/"]')];

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(NOW);
  analyzeRoute.mockReset().mockImplementation(async (body) => routeResult({ destination: body.destination }));
  getItems.mockReset().mockResolvedValue(ITEMS);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
});

describe("RouteTest booking guard", () => {
  it("only in-stock items get a reservation link, sold-out items stay visible", async () => {
    await render();
    await search();

    expect(reserveLinks().map((a) => a.getAttribute("href"))).toEqual(["/reserve/i1"]);
    expect(container.textContent).toContain("お茶せんべい");
    expect(container.textContent).not.toContain("時間を変えると受け取れる商品");
  });

  it("changing the destination after searching blocks booking until re-searched (P2-6)", async () => {
    await render();
    await search();
    expect(reserveLinks()).toHaveLength(1);

    const destinationInput = [...container.querySelectorAll("input[type=text]")].find(
      (input) => input.value === "下呂温泉",
    );
    await act(async () => setInputValue(destinationInput, "大阪"));

    expect(reserveLinks()).toHaveLength(0);
    expect(container.textContent).toContain("検索条件が変更されています");

    await search();
    expect(analyzeRoute).toHaveBeenLastCalledWith(expect.objectContaining({ destination: "大阪" }));
    expect(reserveLinks()).toHaveLength(1);
  });

  it("the reservation link disappears once the pickup window ends while the page is open (P2-8)", async () => {
    await render();
    // 「日時を指定」で検索(「今すぐ」の10分制限と切り分けるため)。
    await act(async () => {
      container.querySelector('input[value="custom"]').click();
    });
    const departure = container.querySelector('input[type="datetime-local"]');
    await act(async () => setInputValue(departure, "2026-09-27T09:10"));
    await search();
    expect(reserveLinks()).toHaveLength(1);

    // 受取枠の終了(11:30)を過ぎるまで画面を開いたままにする。
    await act(async () => {
      vi.setSystemTime(Date.parse("2026-09-27T11:30:01+09:00"));
      await vi.advanceTimersByTimeAsync(16000);
    });

    expect(reserveLinks()).toHaveLength(0);
    expect(container.textContent).toContain("受取時間帯が終了しています");
    // 在庫のある商品だけが「時間を変えると受け取れる商品」に出る(在庫切れは出さない)。
    const laterSection = [...container.querySelectorAll("h3")].find((h) =>
      h.textContent.includes("時間を変えると受け取れる商品"),
    ).parentElement;
    expect(laterSection.textContent).toContain("薪");
    expect(laterSection.textContent).not.toContain("お茶せんべい");
  });

  it("a 'now' result older than 10 minutes cannot be booked (P2-7)", async () => {
    await render();
    await search();
    expect(reserveLinks()).toHaveLength(1);

    await act(async () => {
      vi.setSystemTime(NOW + 11 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(16000);
    });

    expect(reserveLinks()).toHaveLength(0);
    expect(container.textContent).toContain("「今すぐ」で検索してから時間が経った");
  });

  it("a departure time that became past is rejected with a specific message (P2-12)", async () => {
    await render();
    await act(async () => {
      container.querySelector('input[value="custom"]').click();
    });
    const departure = container.querySelector('input[type="datetime-local"]');
    await act(async () => setInputValue(departure, "2026-09-27T08:59"));
    await search();

    expect(analyzeRoute).not.toHaveBeenCalled();
    expect(container.textContent).toContain("出発日時が現在より前になっています");
  });
});
