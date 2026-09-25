import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import { toUserMessage } from "../utils/errorMessages";

// POST /routes/analyzeの失敗を日本語で案内する(Backend/route_analysis.pyの
// detailは英語の内部向け文言のため、そのまま表示しない)。422のうち
// バリデーションエラー(detailが配列)はclient.jsで既に日本語化済み。
const ROUTE_ANALYSIS_ERROR_BY_STATUS = {
  401: "ルート分析を利用できませんでした。時間をおいて、もう一度お試しください。",
  422: "出発地・目的地・出発日時からルートを計算できませんでした。入力内容を確認してください。",
  429: "ルート分析の利用が集中しています。1分ほど待ってから、もう一度お試しください。",
  502: "ルート情報を取得できませんでした。時間をおいて、もう一度お試しください。",
  503: "現在ルート分析を利用できません。時間をおいて、もう一度お試しください。",
};
const ROUTE_ANALYSIS_ERROR_FALLBACK = "ルート分析に失敗しました。";
const ITEMS_LOAD_ERROR_FALLBACK = "商品情報の取得に失敗しました。";

// RouteTestの入力・分析結果をlocalStorageに保存し、Reservationからの戻る
// 操作・リロード・別タブでも再実行(Google Routes APIの再呼び出し)無しで
// 復元できるようにする(一括修正m7・U6)。TTLを設け、古い分析結果を無期限に
// 使い続けないようにする。
const ROUTE_TEST_STATE_KEY = "traildrop_route_test_state";
const ROUTE_TEST_STATE_TTL_MS = 20 * 60 * 1000; // 20分

export function loadRouteTestState() {
  try {
    const raw = localStorage.getItem(ROUTE_TEST_STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state?.savedAt || Date.now() - state.savedAt > ROUTE_TEST_STATE_TTL_MS) {
      localStorage.removeItem(ROUTE_TEST_STATE_KEY);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

export function saveRouteTestState(state) {
  try {
    localStorage.setItem(
      ROUTE_TEST_STATE_KEY,
      JSON.stringify({ ...state, savedAt: Date.now() }),
    );
  } catch {
    // 保存できなくても致命的ではない(戻った際に復元されないだけ)。
  }
}

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
export function jstMinutesSinceMidnight(date) {
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
export function parseTimeStringToMinutes(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// "HH:MM:SS" / "HH:MM" から表示用の"HH:MM"を取り出す。time型には日付・
// timezoneの概念が無いため、Dateへの変換は行わず文字列のまま扱う
// (parseTimeStringToMinutesと同じ抽出方法)。
export function formatPickupHours(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

// 商品の受取可能時間(pickup_available_from/to)に、実効受取予定時刻
// (pass_at + windowOffsetMinutes、以前は2時間幅の受取枠全体との重なりで
// 判定していたが、枠の端だけが営業時間に触れていて実際の通過時刻は営業時間外、
// というケースを誤って「受け取れる」としてしまっていたため、一点判定に変更)
// が収まっているかどうかを判定する。受取可能時間が未設定(null)の商品は
// 「常に受け取れる」とは解釈せず、対象外とする。境界(ちょうど開店・閉店時刻)
// は利用可として扱う。
export function isItemAvailableAt(item, effectiveMinutes) {
  const itemStart = parseTimeStringToMinutes(item.pickup_available_from);
  const itemEnd = parseTimeStringToMinutes(item.pickup_available_to);
  if (itemStart === null || itemEnd === null) {
    return false;
  }
  return itemStart <= effectiveMinutes && effectiveMinutes <= itemEnd;
}

const WINDOW_DURATION_MINUTES = 120;
const WINDOW_HALF_DURATION_MINUTES = WINDOW_DURATION_MINUTES / 2;
const WINDOW_OFFSET_STEP_MINUTES = 30;
const WINDOW_OFFSET_MAX_MINUTES = 180;

export default function RouteTest() {
  // 起動時に1度だけ復元を試みる(TTL切れ・壊れたデータはnullになる)。
  const initialRouteState = loadRouteTestState();
  const [origin, setOrigin] = useState(initialRouteState?.origin ?? "名古屋駅");
  const [destination, setDestination] = useState(initialRouteState?.destination ?? "下呂温泉");
  const [departureAt, setDepartureAt] = useState(initialRouteState?.departureAt ?? "");
  const [result, setResult] = useState(initialRouteState?.result ?? null);
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
  const [windowOffsetMinutes, setWindowOffsetMinutes] = useState(
    initialRouteState?.windowOffsetMinutes ?? 0,
  );

  // 分析結果を復元できた場合、商品一覧はGET /items(無料・軽量)だけ再実行
  // して埋め直す。Google Routes APIを再度呼ぶことはない。
  useEffect(() => {
    if (initialRouteState?.result?.pass_point) {
      loadMatchingItems(initialRouteState.result.pass_point);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 入力・分析結果・受取枠offsetが変わるたびに保存し直す(戻る操作・
  // リロード・別タブでの復元用)。
  useEffect(() => {
    saveRouteTestState({ origin, destination, departureAt, result, windowOffsetMinutes });
  }, [origin, destination, departureAt, result, windowOffsetMinutes]);

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
      setItemsError(toUserMessage(itemsRequestError, { fallback: ITEMS_LOAD_ERROR_FALLBACK }));
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
      setError(
        toUserMessage(requestError, {
          byStatus: ROUTE_ANALYSIS_ERROR_BY_STATUS,
          fallback: ROUTE_ANALYSIS_ERROR_FALLBACK,
        }),
      );
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

  // 受取時間帯が完全に終了しているか(windowEnd <= 現在時刻)。startだけが
  // 過去でendが未来なら受取枠の途中であり、まだ予約できる(PMレビュー
  // BLOCKER B1: startが過去というだけでは拒否しない。Backend側の
  // model_validatorと同じ基準)。
  const isPickupWindowExpired = windowEndDate ? windowEndDate.getTime() <= Date.now() : false;

  // 実効受取予定時刻(windowOffsetMinutesだけ通過予定時刻をずらした、実際に
  // 受取枠の中心となる瞬間)。表示・予約への引き継ぎに使う2時間幅の受取枠
  // (windowStartDate/windowEndDate)とは別に、商品の営業時間内判定だけは
  // この一点で行う(枠の端だけが営業時間に触れていても、実際に受け取る
  // つもりの時刻が営業時間外なら不適切なため)。
  const effectiveDate = passAtDate
    ? new Date(passAtDate.getTime() + windowOffsetMinutes * 60000)
    : null;

  const timeFilteredItems = effectiveDate
    ? matchedItems.filter((item) =>
        isItemAvailableAt(item, jstMinutesSinceMidnight(effectiveDate)),
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
              {/* 商品の営業時間内判定はeffectiveDate(この時刻)の一点で行って
                  いるため、「受取時間(枠)」とは別に明示する(一括修正U3)。 */}
              <p className="mt-1 text-xs text-gray-500">
                受取予定: {formatJapanTime(effectiveDate)}（このルートで受け取れる商品は、この時刻を基準に判定しています）
              </p>
              {isPickupWindowExpired && (
                <p className="mt-1 text-sm text-red-600" role="alert">
                  受取時間帯が終了しています。受取時間をずらすか、もう一度ルート分析をやり直してください。
                </p>
              )}
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
                        <div className="text-sm mt-1">
                          ¥{item.price}
                          {item.stock > 0 ? `（残り${item.stock}）` : "（在庫切れ）"}
                        </div>
                        {/* ユーザーが選択した「受取時間」(上のセクション)とは別物と
                            分かるよう、商品自体の営業時間であることを明示するラベル
                            にする。片方でも未設定なら表示しない(既存のNULL扱いと
                            同じ)。 */}
                        {item.pickup_available_from && item.pickup_available_to && (
                          <div className="text-xs text-gray-500 mt-1">
                            商品受取可能時間: {formatPickupHours(item.pickup_available_from)}
                            〜{formatPickupHours(item.pickup_available_to)}
                          </div>
                        )}
                      </div>
                      {item.stock > 0 && !isPickupWindowExpired ? (
                        <Link
                          to={`/reserve/${item.id}`}
                          state={{
                            origin: result.origin,
                            destination: result.destination,
                            passPoint: result.pass_point,
                            pickupWindowStart: windowStartDate.toISOString(),
                            pickupWindowEnd: windowEndDate.toISOString(),
                          }}
                          className="shrink-0 rounded px-3 py-2 text-sm font-medium text-white bg-[#2f6f3e]"
                        >
                          予約へ進む
                        </Link>
                      ) : (
                        <span
                          aria-disabled="true"
                          className="shrink-0 rounded px-3 py-2 text-sm font-medium text-gray-500 bg-gray-200 cursor-not-allowed"
                        >
                          {item.stock > 0 ? "受取時間帯終了" : "在庫切れ"}
                        </span>
                      )}
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
