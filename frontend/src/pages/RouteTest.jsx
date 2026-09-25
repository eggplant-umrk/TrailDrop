import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import {
  AppLayout,
  formatYen,
  primaryButtonClass,
  secondaryButtonClass,
} from "../components/ui";
import ItemThumbnail from "../components/ItemThumbnail";
import { toUserMessage } from "../utils/errorMessages";
import { getCurrentLocation } from "../utils/geolocation";
import {
  formatDistanceFromRoute,
  normalizePickupCandidates,
  selectPickupCandidate,
} from "../utils/pickupCandidates";
import {
  findWindowOffsetForItem,
  formatPickupHours,
  hasPickupHours,
  isItemAvailableAt,
  jstMinutesSinceMidnight,
  nowDepartureInputValue,
  suggestDepartureForItem,
} from "../utils/pickupHours";

// 受取可能時間まわりの判定はutils/pickupHours.jsへ移した。既存のテスト・
// 呼び出し元のためにここからも公開する。
export {
  formatPickupHours,
  isItemAvailableAt,
  jstMinutesSinceMidnight,
  parseTimeStringToMinutes,
} from "../utils/pickupHours";

// 「現在地を使う」選択中に出発地として送る表示用ラベル。実際の出発地は
// origin_location(座標)としてBackendへ送る。座標自体は保存しない。
const CURRENT_LOCATION_LABEL = "現在地";

// POST /routes/analyzeの失敗を日本語で案内する(Backend/route_analysis.pyの
// detailは英語の内部向け文言のため、そのまま表示しない)。422のうち
// バリデーションエラー(detailが配列)はclient.jsで既に日本語化済み。
const ROUTE_ANALYSIS_ERROR_BY_STATUS = {
  401: "ルートを検索できませんでした。時間をおいて、もう一度お試しください。",
  422: "出発地・目的地・出発日時からルートを計算できませんでした。入力内容を確認してください。",
  429: "ルート検索の利用が集中しています。1分ほど待ってから、もう一度お試しください。",
  502: "ルート情報を取得できませんでした。時間をおいて、もう一度お試しください。",
  503: "現在ルート検索を利用できません。時間をおいて、もう一度お試しください。",
};
const ROUTE_ANALYSIS_ERROR_FALLBACK = "ルートの検索に失敗しました。";
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

function formatJapanTime(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatJapanDay(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

// datetime-localの値(JST)を「9月27日(日) 09:00」の形で表示する。
function formatDepartureInputValue(value) {
  const date = new Date(`${value}:00+09:00`);
  return `${formatJapanDay(date)} ${formatJapanTime(date)}`;
}

const WINDOW_DURATION_MINUTES = 120;
const WINDOW_HALF_DURATION_MINUTES = WINDOW_DURATION_MINUTES / 2;
const WINDOW_OFFSET_STEP_MINUTES = 30;
const WINDOW_OFFSET_MAX_MINUTES = 180;
const WINDOW_OFFSET_RANGE = {
  stepMinutes: WINDOW_OFFSET_STEP_MINUTES,
  maxMinutes: WINDOW_OFFSET_MAX_MINUTES,
};

const HOW_TO_STEPS = ["行き先を入力", "途中の道の駅で商品を予約", "QRを見せて受け取る"];

const inputClass =
  "mt-1 block min-h-[44px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base";

export default function RouteTest() {
  // 起動時に1度だけ復元を試みる(TTL切れ・壊れたデータはnullになる)。
  const initialRouteState = loadRouteTestState();
  // 現在地の座標は保存しないため、「現在地」ラベルだけが復元された場合は
  // 出発地を空に戻して手入力(または再取得)してもらう。
  const [origin, setOrigin] = useState(
    initialRouteState?.origin === CURRENT_LOCATION_LABEL
      ? ""
      : initialRouteState?.origin ?? "名古屋駅",
  );
  // 「現在地を使う」で取得した座標({lat, lng})。nullなら出発地は手入力の文字列。
  const [originLocation, setOriginLocation] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState(null);
  const [destination, setDestination] = useState(initialRouteState?.destination ?? "下呂温泉");
  // 出発日時は既定で「今すぐ」。"custom"の時だけdepartureAtの入力値を使う。
  const [departureMode, setDepartureMode] = useState(initialRouteState?.departureMode ?? "now");
  const [departureAt, setDepartureAt] = useState(initialRouteState?.departureAt ?? "");
  // 実際に検索に使った出発日時(「出発をずらす」目安の計算用)。
  const [searchedDepartureAt, setSearchedDepartureAt] = useState(
    initialRouteState?.searchedDepartureAt ?? null,
  );
  const [result, setResult] = useState(initialRouteState?.result ?? null);
  // 選択中の受取地点(候補のname)。候補の切り替えはAPIを呼ばず、取得済みの
  // 候補(pass_at等)から画面を計算し直すだけ。
  const [selectedPickupName, setSelectedPickupName] = useState(
    initialRouteState?.selectedPickupName ?? null,
  );
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scrollToResults, setScrollToResults] = useState(false);
  const resultsRef = useRef(null);
  const formRef = useRef(null);

  // 商品一覧は、ルート分析結果とは別のライフサイクルを持つ(ルート分析は成功して
  // いるのに商品取得だけ失敗する、といったケースを区別するため)。受取地点の
  // 切り替えでAPIを呼ばないよう、全商品を1回だけ取得して地点名で絞り込む。
  const [allItems, setAllItems] = useState([]);
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
    if (normalizePickupCandidates(initialRouteState?.result).length > 0) {
      loadItems();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 入力・分析結果・受取枠offsetが変わるたびに保存し直す(戻る操作・
  // リロード・別タブでの復元用)。
  useEffect(() => {
    saveRouteTestState({
      origin,
      destination,
      departureMode,
      departureAt,
      searchedDepartureAt,
      result,
      windowOffsetMinutes,
      selectedPickupName,
    });
  }, [
    origin,
    destination,
    departureMode,
    departureAt,
    searchedDepartureAt,
    result,
    windowOffsetMinutes,
    selectedPickupName,
  ]);

  // 検索に成功したら、結果(受取地点・商品)まで自動でスクロールする。商品の
  // 読み込み中はページが短く目的の位置まで届かないため、読み込み後に行う。
  useEffect(() => {
    if (!scrollToResults || loading || itemsLoading) return;
    setScrollToResults(false);
    resultsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [scrollToResults, loading, itemsLoading]);

  async function loadItems() {
    setItemsLoading(true);
    setItemsError(null);
    setAllItems([]);

    try {
      const items = await api.getItems();
      setAllItems(Array.isArray(items) ? items : []);
    } catch (itemsRequestError) {
      setItemsError(toUserMessage(itemsRequestError, { fallback: ITEMS_LOAD_ERROR_FALLBACK }));
    } finally {
      setItemsLoading(false);
    }
  }

  async function runSearch(departureValue) {
    setLoading(true);
    setError(null);
    setResult(null);
    setItemsError(null);
    setAllItems([]);
    setWindowOffsetMinutes(0);

    try {
      const data = await api.analyzeRoute({
        origin: originLocation ? CURRENT_LOCATION_LABEL : origin.trim(),
        destination: destination.trim(),
        departure_at: `${departureValue}:00+09:00`,
        origin_location: originLocation,
      });
      setResult(data);
      setSearchedDepartureAt(departureValue);
      // 初期選択はルート上で最初に出会う受取地点(候補はルート順)。
      const candidates = normalizePickupCandidates(data);
      setSelectedPickupName(candidates[0]?.name ?? null);
      setScrollToResults(true);
      if (candidates.length > 0) {
        await loadItems();
      }
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

  function handleSubmit(event) {
    event.preventDefault();
    runSearch(departureMode === "now" ? nowDepartureInputValue() : departureAt);
  }

  // 受取時間のスライダーでは届かない商品向け。出発日時を目安の値に変えて
  // 検索し直す(ユーザーが押した時だけ再検索する)。
  function handleSearchWithDeparture(value) {
    setDepartureMode("custom");
    setDepartureAt(value);
    formRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    runSearch(value);
  }

  async function handleUseCurrentLocation() {
    setLocating(true);
    setLocationMessage(null);
    try {
      const location = await getCurrentLocation();
      setOriginLocation(location);
    } catch (locationError) {
      // 拒否・未対応・取得失敗のいずれも、従来の出発地テキスト入力へ戻す。
      setOriginLocation(null);
      setLocationMessage(locationError.userMessage || locationError.message);
    } finally {
      setLocating(false);
    }
  }

  function handleClearCurrentLocation() {
    setOriginLocation(null);
    setLocationMessage(null);
  }

  function handleSelectPickup(name) {
    setSelectedPickupName(name);
    // 到着目安が変わるため、受取枠は選んだ地点の到着目安を中心に戻す。
    setWindowOffsetMinutes(0);
  }

  function shiftWindow(deltaMinutes) {
    setWindowOffsetMinutes((current) =>
      Math.max(
        -WINDOW_OFFSET_MAX_MINUTES,
        Math.min(WINDOW_OFFSET_MAX_MINUTES, current + deltaMinutes),
      ),
    );
  }

  const pickupCandidates = normalizePickupCandidates(result);
  const selectedPickup = selectPickupCandidate(pickupCandidates, selectedPickupName);
  const matchedItems = selectedPickup
    ? allItems.filter((item) => item.location_name === selectedPickup.name)
    : [];

  // 受取枠(2時間固定)は、選択中の受取地点の到着目安を中心にwindowOffsetMinutes
  // だけずらしたものとして毎レンダー計算する派生値。専用のstateは持たない。
  const passAtDate = selectedPickup ? new Date(selectedPickup.pass_at) : null;
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
  // 受取枠の中心となる瞬間)。商品の営業時間内判定だけはこの一点で行う。
  // 内部判定用の値のため、画面には表示しない。
  const effectiveDate = passAtDate
    ? new Date(passAtDate.getTime() + windowOffsetMinutes * 60000)
    : null;

  const timeFilteredItems = effectiveDate
    ? matchedItems.filter((item) =>
        isItemAvailableAt(item, jstMinutesSinceMidnight(effectiveDate)),
      )
    : [];
  // 受取可能時間は設定されているが、今の受取時間帯では受け取れない商品。
  // 「受け取れる商品はありません」で止めず、ずらし方を案内する。
  const laterItems = effectiveDate
    ? matchedItems.filter(
        (item) => hasPickupHours(item) && !timeFilteredItems.includes(item),
      )
    : [];

  const pickupDayLabel =
    windowStartDate && formatJapanDay(windowStartDate) !== formatJapanDay(new Date())
      ? formatJapanDay(windowStartDate)
      : null;
  const pickupWindowLabel = windowStartDate
    ? `${formatJapanTime(windowStartDate)}〜${formatJapanTime(windowEndDate)}`
    : "";

  function laterItemAction(item) {
    const offset = findWindowOffsetForItem(item, passAtDate.getTime(), WINDOW_OFFSET_RANGE);
    if (offset !== null) {
      const start = new Date(
        passAtDate.getTime() + (offset - WINDOW_HALF_DURATION_MINUTES) * 60000,
      );
      const end = new Date(passAtDate.getTime() + (offset + WINDOW_HALF_DURATION_MINUTES) * 60000);
      return (
        <button
          type="button"
          onClick={() => setWindowOffsetMinutes(offset)}
          className={secondaryButtonClass}
        >
          受取時間を {formatJapanTime(start)}〜{formatJapanTime(end)} にずらす
        </button>
      );
    }
    const suggested =
      searchedDepartureAt &&
      suggestDepartureForItem(item, {
        passAtMs: passAtDate.getTime(),
        departureMs: new Date(`${searchedDepartureAt}:00+09:00`).getTime(),
      });
    if (!suggested) return null;
    return (
      <button
        type="button"
        onClick={() => handleSearchWithDeparture(suggested)}
        disabled={loading}
        className={secondaryButtonClass}
      >
        出発を {formatDepartureInputValue(suggested)} にして探し直す
      </button>
    );
  }

  return (
    <AppLayout step={result ? 2 : 1}>
      <section className="pt-2">
        <h1 className="text-2xl font-bold leading-snug">
          移動のついでに、
          <br />
          道の駅で地元の品を受け取る
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          行き先を入れると、途中で立ち寄れる受取地点と、そこで受け取れる商品がわかります。
        </p>
      </section>

      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="mt-4 scroll-mt-16 space-y-4 rounded-xl bg-white p-4 shadow-sm"
      >
        <div>
          <span className="text-sm font-medium">出発地</span>
          {originLocation ? (
            <div className="mt-1 flex min-h-[44px] items-center justify-between gap-2 rounded-lg border border-[#2f6f3e] bg-[#f7fbf6] px-3">
              <span className="text-base">現在地から出発</span>
              <button
                type="button"
                onClick={handleClearCurrentLocation}
                className="min-h-[44px] px-2 text-sm text-[#2f6f3e] underline"
              >
                入力に戻す
              </button>
            </div>
          ) : (
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                required
                aria-label="出発地"
                className={`${inputClass} mt-0 min-w-0 flex-1`}
              />
              <button
                type="button"
                onClick={handleUseCurrentLocation}
                disabled={locating}
                className="min-h-[44px] shrink-0 rounded-lg border border-[#2f6f3e] px-3 text-sm font-medium text-[#2f6f3e] disabled:border-gray-300 disabled:text-gray-400"
              >
                {locating ? "取得中…" : "現在地"}
              </button>
            </div>
          )}
          {locationMessage && (
            <p className="mt-1 text-sm text-red-600" role="alert">
              {locationMessage}
            </p>
          )}
        </div>

        <label className="block">
          <span className="text-sm font-medium">目的地</span>
          <input
            type="text"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            required
            className={inputClass}
          />
        </label>

        <fieldset>
          <legend className="text-sm font-medium">出発日時</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {[
              { value: "now", label: "今すぐ" },
              { value: "custom", label: "日時を指定" },
            ].map((option) => (
              <label
                key={option.value}
                className={`flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg border text-sm font-medium ${
                  departureMode === option.value
                    ? "border-[#2f6f3e] bg-[#eef6ec] text-[#2f6f3e]"
                    : "border-gray-300 bg-white text-gray-700"
                }`}
              >
                <input
                  type="radio"
                  name="departure-mode"
                  value={option.value}
                  checked={departureMode === option.value}
                  onChange={() => setDepartureMode(option.value)}
                  className="sr-only"
                />
                {option.label}
              </label>
            ))}
          </div>
          {departureMode === "custom" && (
            <input
              type="datetime-local"
              value={departureAt}
              min={nowDepartureInputValue(Date.now(), 1)}
              onChange={(event) => setDepartureAt(event.target.value)}
              required
              aria-label="出発日時"
              className={`${inputClass} mt-2`}
            />
          )}
        </fieldset>

        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={loading} className={primaryButtonClass}>
          {loading ? "探しています…" : "受け取れる商品を探す"}
        </button>
      </form>

      {/* 検索前だけ表示する、サービスの流れの静的な説明。 */}
      {!result && (
        <section className="mt-4 rounded-xl bg-white p-4 shadow-sm" aria-labelledby="how-to-title">
          <h2 id="how-to-title" className="text-sm font-semibold">
            TrailDropの使い方
          </h2>
          <ol className="mt-3 space-y-2">
            {HOW_TO_STEPS.map((step, index) => (
              <li key={step} className="flex items-center gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#2f6f3e] text-sm font-bold text-white">
                  {index + 1}
                </span>
                <span className="text-sm font-medium">{step}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {result && (
        <section ref={resultsRef} className="mt-6 scroll-mt-16 space-y-4" aria-live="polite">
          {pickupCandidates.length === 0 ? (
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <h2 className="text-lg font-semibold">受取地点が見つかりませんでした</h2>
              <p className="mt-1 text-sm text-gray-600">
                このルートの近くには受取地点がありません。出発地・目的地を変えてお試しください。
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-xl bg-white p-4 shadow-sm">
                <h2 className="text-xs font-medium text-gray-500">受取地点</h2>
                {pickupCandidates.length === 1 ? (
                  <p className="mt-1 text-lg font-semibold">{selectedPickup.name}</p>
                ) : (
                  <fieldset className="mt-1">
                    <legend className="text-xs text-gray-500">
                      ルート上に{pickupCandidates.length}か所あります（通る順）
                    </legend>
                    <div className="mt-2 space-y-2">
                      {pickupCandidates.map((candidate) => (
                        <label
                          key={candidate.name}
                          className={`flex min-h-[44px] cursor-pointer items-start gap-2 rounded-lg border p-3 ${
                            candidate.name === selectedPickup.name
                              ? "border-[#2f6f3e] bg-[#f7fbf6]"
                              : "border-gray-200"
                          }`}
                        >
                          <input
                            type="radio"
                            name="pickup-location"
                            value={candidate.name}
                            checked={candidate.name === selectedPickup.name}
                            onChange={() => handleSelectPickup(candidate.name)}
                            className="mt-1"
                          />
                          <span>
                            <span className="block font-medium">{candidate.name}</span>
                            <span className="block text-xs text-gray-600">
                              到着目安 {formatJapanTime(new Date(candidate.pass_at))}
                              {formatDistanceFromRoute(candidate.distance_from_route_meters) &&
                                `・${formatDistanceFromRoute(candidate.distance_from_route_meters)}`}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                <dl className="mt-3 grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-[#f7fbf6] p-3">
                    <dt className="text-xs text-gray-500">到着目安</dt>
                    <dd className="text-xl font-bold">{formatJapanTime(passAtDate)}</dd>
                  </div>
                  <div className="rounded-lg bg-[#f7fbf6] p-3">
                    <dt className="text-xs text-gray-500">受取時間帯</dt>
                    <dd className="text-xl font-bold">{pickupWindowLabel}</dd>
                  </div>
                </dl>
                {pickupDayLabel && (
                  <p className="mt-2 text-sm font-medium">{pickupDayLabel}の受取です</p>
                )}
                <p className="mt-2 text-xs text-gray-500">
                  到着目安は寄り道時間を含みません
                  {/* 括弧内の「い）」だけが改行されないよう、括弧ごと折り返す。 */}
                  {formatDistanceFromRoute(selectedPickup.distance_from_route_meters) && (
                    <span className="inline-block">
                      （受取地点は{formatDistanceFromRoute(selectedPickup.distance_from_route_meters)}）
                    </span>
                  )}
                </p>
                {isPickupWindowExpired && (
                  <p className="mt-2 text-sm text-red-600" role="alert">
                    受取時間帯が終了しています。受取時間をずらすか、もう一度検索してください。
                  </p>
                )}
              </div>

              <div className="rounded-xl bg-white p-4 shadow-sm">
                <h2 className="text-lg font-semibold">受け取れる商品</h2>

                {itemsLoading && (
                  <p className="mt-3 text-sm text-gray-600">受け取れる商品を確認中…</p>
                )}

                {!itemsLoading && itemsError && (
                  <div className="mt-3">
                    <p className="text-sm text-red-600">{itemsError}</p>
                    <button
                      type="button"
                      onClick={loadItems}
                      className={`${secondaryButtonClass} mt-2`}
                    >
                      もう一度読み込む
                    </button>
                  </div>
                )}

                {!itemsLoading && !itemsError && matchedItems.length === 0 && (
                  <p className="mt-3 text-sm text-gray-600">
                    この受取地点で扱っている商品は、現在ありません。
                  </p>
                )}

                {!itemsLoading &&
                  !itemsError &&
                  timeFilteredItems.length === 0 &&
                  laterItems.length > 0 && (
                    <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                      受取時間帯 {pickupWindowLabel} に受け取れる商品はありません。下の商品は、時間を変えると予約できます。
                    </p>
                  )}

                {!itemsLoading && !itemsError && timeFilteredItems.length > 0 && (
                  <ul className="mt-3 space-y-3">
                    {timeFilteredItems.map((item) => (
                      <li key={item.id} className="rounded-lg border border-gray-200 p-3">
                        <div className="flex items-start gap-3">
                          <ItemThumbnail itemId={item.id} title={item.title} />
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold">
                              {item.title}
                              {item.type === "experience" && (
                                <span className="ml-2 text-xs font-normal text-gray-500">体験</span>
                              )}
                            </p>
                            <p className="mt-0.5 flex items-baseline gap-2">
                              <span className="text-lg font-bold">{formatYen(item.price)}</span>
                              <span
                                className={`text-xs ${item.stock > 0 ? "text-gray-600" : "font-medium text-red-600"}`}
                              >
                                {item.stock > 0 ? `残り${item.stock}` : "在庫切れ"}
                              </span>
                            </p>
                            <p className="text-xs text-gray-600">
                              営業時間{" "}
                              <span className="whitespace-nowrap">
                                {formatPickupHours(item.pickup_available_from)}〜
                                {formatPickupHours(item.pickup_available_to)}
                              </span>
                            </p>
                          </div>
                        </div>
                        {item.stock > 0 && !isPickupWindowExpired ? (
                          <Link
                            to={`/reserve/${item.id}`}
                            state={{
                              origin: result.origin,
                              destination: result.destination,
                              passPoint: selectedPickup.name,
                              passPointLat: selectedPickup.lat ?? undefined,
                              passPointLng: selectedPickup.lng ?? undefined,
                              pickupWindowStart: windowStartDate.toISOString(),
                              pickupWindowEnd: windowEndDate.toISOString(),
                            }}
                            className={`${primaryButtonClass} mt-3`}
                          >
                            予約する
                          </Link>
                        ) : (
                          <span
                            aria-disabled="true"
                            className="mt-3 flex min-h-[44px] w-full cursor-not-allowed items-center justify-center rounded-lg bg-gray-200 text-sm font-medium text-gray-500"
                          >
                            {item.stock > 0 ? "受取時間帯が終了しています" : "在庫切れ"}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {!itemsLoading && !itemsError && laterItems.length > 0 && (
                  <div className="mt-4">
                    <h3 className="text-sm font-semibold text-gray-700">
                      時間を変えると受け取れる商品
                    </h3>
                    <ul className="mt-2 space-y-3">
                      {laterItems.map((item) => (
                        <li
                          key={item.id}
                          className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3"
                        >
                          <div className="flex items-start gap-3">
                            <ItemThumbnail itemId={item.id} title={item.title} />
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-gray-700">{item.title}</p>
                              <p className="mt-0.5 flex items-baseline gap-2">
                                <span className="text-lg font-bold text-gray-700">
                                  {formatYen(item.price)}
                                </span>
                                <span
                                  className={`text-xs ${item.stock > 0 ? "text-gray-600" : "font-medium text-red-600"}`}
                                >
                                  {item.stock > 0 ? `残り${item.stock}` : "在庫切れ"}
                                </span>
                              </p>
                              <p className="text-xs text-gray-600">
                                営業時間{" "}
                                <span className="whitespace-nowrap">
                                  {formatPickupHours(item.pickup_available_from)}〜
                                  {formatPickupHours(item.pickup_available_to)}
                                </span>
                              </p>
                              <span className="mt-1 inline-block rounded bg-gray-200 px-2 py-0.5 text-[11px] text-gray-600">
                                この時間は受取不可
                              </span>
                            </div>
                          </div>
                          <div className="mt-3">{laterItemAction(item)}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="rounded-xl bg-white p-4 shadow-sm">
                <h2 className="text-base font-semibold">受取時間を変更</h2>
                <p className="mt-1 text-xs text-gray-500">
                  到着目安の前後3時間まで、30分単位でずらせます
                </p>
                <p className="mt-2 text-sm">
                  受取時間帯 <span className="font-semibold">{pickupWindowLabel}</span>
                </p>
                <input
                  type="range"
                  min={-WINDOW_OFFSET_MAX_MINUTES}
                  max={WINDOW_OFFSET_MAX_MINUTES}
                  step={WINDOW_OFFSET_STEP_MINUTES}
                  value={windowOffsetMinutes}
                  onChange={(event) => setWindowOffsetMinutes(Number(event.target.value))}
                  className="mt-2 h-11 w-full accent-[#2f6f3e]"
                  aria-label="受取時間帯をずらす"
                />
                <div className="mt-1 grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => shiftWindow(-WINDOW_OFFSET_STEP_MINUTES)}
                    disabled={windowOffsetMinutes <= -WINDOW_OFFSET_MAX_MINUTES}
                    className={secondaryButtonClass}
                  >
                    −30分
                  </button>
                  <button
                    type="button"
                    onClick={() => setWindowOffsetMinutes(0)}
                    disabled={windowOffsetMinutes === 0}
                    className={secondaryButtonClass}
                  >
                    元に戻す
                  </button>
                  <button
                    type="button"
                    onClick={() => shiftWindow(WINDOW_OFFSET_STEP_MINUTES)}
                    disabled={windowOffsetMinutes >= WINDOW_OFFSET_MAX_MINUTES}
                    className={secondaryButtonClass}
                  >
                    ＋30分
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      <p className="mt-6 text-center">
        <Link
          to="/items"
          className="inline-flex min-h-[44px] items-center text-sm text-[#2f6f3e] underline"
        >
          ルートを使わずに、すべての商品を見る
        </Link>
      </p>
    </AppLayout>
  );
}
