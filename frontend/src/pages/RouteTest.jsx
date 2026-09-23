import { useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";

function formatJapanDateTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatJapanTime(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

// dateが指すJST上の「その日の0時からの経過分」。深夜またぎ(前日/翌日をまたぐ受取枠)
// は今回のスコープ外のため、日付をまたいだ比較は正しく扱わない前提でよい。
function jstMinutesSinceMidnight(date) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

// "HH:MM:SS" / "HH:MM" (Supabaseのtime型がJSONで返す形式) を0時からの経過分へ。
function parseTimeStringToMinutes(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// 商品の受取可能時間(pickup_available_from/to)とユーザーの受取枠が重なるか判定する。
// 受取可能時間が未設定(null)の商品は「常に受け取れる」とは解釈せず、対象外とする。
// 境界が接する場合(例: 受取枠が18:00開始で、商品の受取終了が18:00)も重なりとして扱う。
function isItemAvailableInWindow(item, windowStartMinutes, windowEndMinutes) {
  const itemStart = parseTimeStringToMinutes(item.pickup_available_from);
  const itemEnd = parseTimeStringToMinutes(item.pickup_available_to);
  if (itemStart === null || itemEnd === null) {
    return false;
  }
  return windowStartMinutes <= itemEnd && itemStart <= windowEndMinutes;
}

const WINDOW_DURATION_MINUTES = 120;
const WINDOW_HALF_DURATION_MINUTES = WINDOW_DURATION_MINUTES / 2;
const WINDOW_OFFSET_STEP_MINUTES = 30;
const WINDOW_OFFSET_MAX_MINUTES = 180;

export default function RouteTest() {
  const [origin, setOrigin] = useState("名古屋駅");
  const [destination, setDestination] = useState("下呂温泉");
  const [departureAt, setDepartureAt] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // 通過地点で受け取れる商品の一覧は、ルート分析結果とは別のライフサイクルを持つ
  // (ルート分析は成功しているのに商品取得だけ失敗する、といったケースを区別するため)。
  const [matchedItems, setMatchedItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState(null);

  // 受取枠(2時間固定)の中心を、既定の通過予定時刻からどれだけずらしたか(分)。
  // 枠の計算・重なり判定は取得済みのmatchedItemsに対する派生値として毎レンダー
  // 計算するだけなので、この値を変えてもAPI通信は一切発生しない。
  const [windowOffsetMinutes, setWindowOffsetMinutes] = useState(0);

  async function loadMatchingItems(passPoint) {
    setItemsLoading(true);
    setItemsError(null);
    setMatchedItems([]);

    try {
      const items = await api.getItems();
      const matched = Array.isArray(items)
        ? items.filter((item) => item.location_name === passPoint)
        : [];
      setMatchedItems(matched);
    } catch (itemsRequestError) {
      setItemsError(itemsRequestError.message || "商品情報の取得に失敗しました。");
    } finally {
      setItemsLoading(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    setItemsError(null);
    setMatchedItems([]);
    setWindowOffsetMinutes(0);

    try {
      const data = await api.analyzeRoute({
        origin: origin.trim(),
        destination: destination.trim(),
        departure_at: `${departureAt}:00+09:00`,
      });
      setResult(data);
      await loadMatchingItems(data.pass_point);
    } catch (requestError) {
      setError(requestError.message || "ルート分析に失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  // 受取枠(2時間固定)は、通過予定時刻を中心にwindowOffsetMinutesだけずらした
  // ものとして毎レンダー計算する派生値。専用のstateは持たない。
  const passAtDate = result ? new Date(result.pass_at) : null;
  const windowStartDate = passAtDate
    ? new Date(
        passAtDate.getTime() +
          (windowOffsetMinutes - WINDOW_HALF_DURATION_MINUTES) * 60000,
      )
    : null;
  const windowEndDate = passAtDate
    ? new Date(
        passAtDate.getTime() +
          (windowOffsetMinutes + WINDOW_HALF_DURATION_MINUTES) * 60000,
      )
    : null;

  const timeFilteredItems =
    windowStartDate && windowEndDate
      ? matchedItems.filter((item) =>
          isItemAvailableInWindow(
            item,
            jstMinutesSinceMidnight(windowStartDate),
            jstMinutesSinceMidnight(windowEndDate),
          ),
        )
      : [];

  return (
    <main className="min-h-screen bg-[#f7fbf6] px-4 py-8 text-[#16381b]">
      <div className="mx-auto max-w-xl">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold">ルート分析</h1>
          <p className="mt-1 text-sm text-gray-600">七宗の通過予定時刻を確認</p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-4 bg-white p-4 shadow-sm rounded-md">
          <label className="block">
            <span className="text-sm font-medium">出発地</span>
            <input
              type="text"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              required
              className="mt-1 w-full rounded border border-gray-300 p-2"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium">目的地</span>
            <input
              type="text"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              required
              className="mt-1 w-full rounded border border-gray-300 p-2"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium">出発日時</span>
            <input
              type="datetime-local"
              value={departureAt}
              onChange={(event) => setDepartureAt(event.target.value)}
              required
              className="mt-1 w-full rounded border border-gray-300 p-2"
            />
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className={`w-full rounded px-4 py-2 font-medium text-white ${
              loading ? "bg-gray-400" : "bg-[#2f6f3e]"
            }`}
          >
            {loading ? "分析中…" : "ルート分析"}
          </button>
        </form>

        {result && (
          <>
            <section className="mt-5 bg-white p-4 shadow-sm rounded-md" aria-live="polite">
              <h2 className="text-lg font-semibold">分析結果</h2>
              <dl className="mt-3 space-y-3">
                <div>
                  <dt className="text-sm text-gray-600">七宗通過予定時刻</dt>
                  <dd className="font-medium">{formatJapanDateTime(result.pass_at)}</dd>
                </div>
                <div>
                  <dt className="text-sm text-gray-600">通過地点</dt>
                  <dd className="font-medium">{result.pass_point}</dd>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <dt className="text-sm text-gray-600">総移動時間</dt>
                    <dd className="font-medium">{result.total_duration_minutes}分</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-gray-600">総距離</dt>
                    <dd className="font-medium">
                      {(result.total_distance_meters / 1000).toFixed(1)}km
                    </dd>
                  </div>
                </div>
              </dl>
            </section>

            <section className="mt-5 bg-white p-4 shadow-sm rounded-md">
              <h2 className="text-lg font-semibold">受取時間を設定</h2>
              <p className="mt-1 text-xs text-gray-500">通過予定時刻の前後で調整できます</p>
              <p className="mt-1 text-sm text-gray-600">
                受取時間: {formatJapanTime(windowStartDate)}〜{formatJapanTime(windowEndDate)}
              </p>
              <input
                type="range"
                min={-WINDOW_OFFSET_MAX_MINUTES}
                max={WINDOW_OFFSET_MAX_MINUTES}
                step={WINDOW_OFFSET_STEP_MINUTES}
                value={windowOffsetMinutes}
                onChange={(event) => setWindowOffsetMinutes(Number(event.target.value))}
                className="mt-3 w-full"
                aria-label="受取時間の枠をずらす"
              />
              {windowOffsetMinutes !== 0 && (
                <button
                  type="button"
                  onClick={() => setWindowOffsetMinutes(0)}
                  className="mt-2 text-sm text-[#2f6f3e] underline"
                >
                  通過予定時刻を中心に戻す
                </button>
              )}
            </section>

            <section className="mt-5 bg-white p-4 shadow-sm rounded-md" aria-live="polite">
              <h2 className="text-lg font-semibold">このルートで受け取れるもの</h2>

              {itemsLoading && (
                <p className="mt-3 text-sm text-gray-600">受け取れる商品を確認中…</p>
              )}

              {!itemsLoading && itemsError && (
                <p className="mt-3 text-sm text-red-600">{itemsError}</p>
              )}

              {!itemsLoading && !itemsError && matchedItems.length === 0 && (
                <p className="mt-3 text-sm text-gray-600">
                  現在このルートで受け取れる商品はありません。
                </p>
              )}

              {!itemsLoading &&
                !itemsError &&
                matchedItems.length > 0 &&
                timeFilteredItems.length === 0 && (
                  <p className="mt-3 text-sm text-gray-600">
                    この受取時間に受け取れる商品はありません。受取時間をずらすと見つかる場合があります。
                  </p>
                )}

              {!itemsLoading && !itemsError && timeFilteredItems.length > 0 && (
                <ul className="mt-3 space-y-3">
                  {timeFilteredItems.map((item) => (
                    <li
                      key={item.id}
                      className="rounded border border-gray-200 p-3 flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="font-medium">
                          {item.title}
                          {item.type === "experience" && (
                            <span className="ml-2 text-xs text-gray-500">体験</span>
                          )}
                        </div>
                        <div className="text-sm text-gray-600">{item.location_name}</div>
                        <div className="text-sm mt-1">¥{item.price}（残り{item.stock}）</div>
                      </div>
                      <Link
                        to={`/reserve/${item.id}`}
                        className="shrink-0 rounded px-3 py-2 text-sm font-medium text-white bg-[#2f6f3e]"
                      >
                        予約へ進む
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
