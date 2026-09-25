import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import {
  AppLayout,
  formatYen,
  primaryButtonClass,
  secondaryButtonClass,
  StockLabel,
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

// tagはヘッダーの手順表示(ルート・商品・予約・受取QR)と同じ用語にそろえる。
const HOW_TO_STEPS = [
  { tag: "ルート", text: "行き先を入力" },
  { tag: "商品・予約", text: "途中の道の駅で選んで予約" },
  { tag: "受取QR", text: "QRを見せて受け取る" },
];

const inputClass =
  "mt-1 block min-h-[44px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base";

// ルートタイムラインの1行(出発地・受取地点・目的地)。見た目だけの部品。
const TIMELINE_MARKER_CLASS = {
  endpoint: "h-3 w-3 border-2 border-gray-400 bg-white",
  candidate: "h-3.5 w-3.5 border-2 border-[#2f6f3e] bg-white",
  selected: "h-4 w-4 bg-[#2f6f3e] ring-4 ring-[#eef6ec]",
};

function TimelineRow({ marker, isLast = false, children }) {
  return (
    <li className={`relative flex gap-3 ${isLast ? "" : "pb-4"}`}>
      {!isLast && (
        <span aria-hidden="true" className="absolute bottom-0 left-[9px] top-5 w-0.5 bg-[#cfe3cb]" />
      )}
      <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center">
        <span className={`block rounded-full ${TIMELINE_MARKER_CLASS[marker]}`} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

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

  // 受取時間帯が終了したら「受取時間を変更」を開き、案内どおりすぐ操作できるように
  // する。開くだけで自動では閉じない(操作中にパネルが閉じて下の要素が詰まり、
  // 続けてのタップが別の要素に当たるのを防ぐため)。
  const timeAdjustRef = useRef(null);
  useEffect(() => {
    if (isPickupWindowExpired && timeAdjustRef.current) {
      timeAdjustRef.current.open = true;
    }
  }, [isPickupWindowExpired]);

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

  // ルートタイムライン用。出発時刻は検索に使った出発日時、目的地の到着目安は
  // それにルート全体の所要時間(分析結果のtotal_duration_minutes)を足しただけの
  // 表示用の値(新たなルート計算はしない)。値が無ければ時刻は出さない。
  const departureDate = searchedDepartureAt ? new Date(`${searchedDepartureAt}:00+09:00`) : null;
  const destinationArrivalDate =
    departureDate && Number.isFinite(result?.total_duration_minutes)
      ? new Date(departureDate.getTime() + result.total_duration_minutes * 60000)
      : null;

  // 「時間を変えると受け取れる商品」向けの操作は、商品ごとではなく一覧に1つだけ
  // 出す。スライダーの範囲で届くなら最小のずらし幅、届かなければ最も早い
  // 出発日時の目安(判定はどちらも既存の関数のまま)。
  const laterAction = (() => {
    if (!passAtDate || laterItems.length === 0) return null;
    const offsets = laterItems
      .map((item) => findWindowOffsetForItem(item, passAtDate.getTime(), WINDOW_OFFSET_RANGE))
      .filter((offset) => offset !== null);
    if (offsets.length > 0) {
      const offset = offsets.reduce((best, current) =>
        Math.abs(current) < Math.abs(best) ? current : best,
      );
      return { type: "shift", offset };
    }
    if (!departureDate) return null;
    const suggestions = laterItems
      .map((item) =>
        suggestDepartureForItem(item, {
          passAtMs: passAtDate.getTime(),
          departureMs: departureDate.getTime(),
        }),
      )
      .filter(Boolean)
      .sort();
    return suggestions.length > 0 ? { type: "depart", value: suggestions[0] } : null;
  })();

  function renderLaterAction() {
    if (!laterAction) return null;
    if (laterAction.type === "shift") {
      const start = new Date(
        passAtDate.getTime() + (laterAction.offset - WINDOW_HALF_DURATION_MINUTES) * 60000,
      );
      const end = new Date(
        passAtDate.getTime() + (laterAction.offset + WINDOW_HALF_DURATION_MINUTES) * 60000,
      );
      return (
        <button
          type="button"
          onClick={() => setWindowOffsetMinutes(laterAction.offset)}
          className={secondaryButtonClass}
        >
          受取時間を {formatJapanTime(start)}〜{formatJapanTime(end)} にずらす
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => handleSearchWithDeparture(laterAction.value)}
        disabled={loading}
        className={secondaryButtonClass}
      >
        出発を {formatDepartureInputValue(laterAction.value)} にして探し直す
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
              <li key={step.tag} className="flex items-center gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#eef6ec] text-sm font-bold text-[#2f6f3e]">
                  {index + 1}
                </span>
                <span className="min-w-0 text-sm">
                  <span className="mr-2 inline-block text-xs font-semibold text-[#2f6f3e]">
                    {step.tag}
                  </span>
                  <span className="inline-block font-medium">{step.text}</span>
                </span>
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
                <h2 className="text-base font-semibold">目的地へ向かう途中で受け取れます</h2>
                <ol className="mt-3" aria-label="ルート">
                  <TimelineRow marker="endpoint">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 font-medium text-gray-800">{result.origin}</p>
                      {departureDate && (
                        <p className="shrink-0 text-sm text-gray-600">
                          <span className="font-semibold text-gray-800">
                            {formatJapanTime(departureDate)}
                          </span>{" "}
                          出発
                        </p>
                      )}
                    </div>
                  </TimelineRow>

                  {pickupCandidates.map((candidate) => {
                    const isSelected = candidate.name === selectedPickup.name;
                    const distanceLabel = formatDistanceFromRoute(
                      candidate.distance_from_route_meters,
                    );
                    const content = (
                      <>
                        <p
                          className={`text-xs font-semibold ${
                            isSelected ? "text-[#2f6f3e]" : "text-gray-500"
                          }`}
                        >
                          {isSelected ? "ここで受け取る" : "受取地点"}
                        </p>
                        <p className={isSelected ? "font-semibold" : "font-medium text-gray-700"}>
                          {candidate.name}
                        </p>
                        <p className="text-sm text-gray-600">
                          到着目安{" "}
                          <span
                            className={
                              isSelected
                                ? "text-lg font-bold text-gray-900"
                                : "font-semibold text-gray-800"
                            }
                          >
                            {formatJapanTime(new Date(candidate.pass_at))}
                          </span>
                          {distanceLabel && (
                            <span className="ml-2 inline-block text-xs text-gray-500">
                              {distanceLabel}
                            </span>
                          )}
                        </p>
                        {isSelected && (
                          <p className="mt-1 inline-block rounded-lg bg-[#eef6ec] px-2 py-1 text-sm text-[#2f6f3e]">
                            受取時間帯{" "}
                            <span className="whitespace-nowrap text-base font-bold">
                              {pickupWindowLabel}
                            </span>
                          </p>
                        )}
                      </>
                    );
                    return (
                      <TimelineRow
                        key={candidate.name}
                        marker={isSelected ? "selected" : "candidate"}
                      >
                        {pickupCandidates.length === 1 ? (
                          content
                        ) : (
                          // 複数の受取地点は、タイムライン上の各地点をそのまま
                          // 選択肢にする(選択処理は従来のhandleSelectPickup)。
                          <label
                            className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 ${
                              isSelected ? "border-[#2f6f3e] bg-[#f7fbf6]" : "border-gray-200"
                            }`}
                          >
                            <input
                              type="radio"
                              name="pickup-location"
                              value={candidate.name}
                              checked={isSelected}
                              onChange={() => handleSelectPickup(candidate.name)}
                              className="mt-0.5 h-4 w-4 shrink-0 accent-[#2f6f3e]"
                            />
                            <span className="min-w-0 flex-1">{content}</span>
                          </label>
                        )}
                      </TimelineRow>
                    );
                  })}

                  <TimelineRow marker="endpoint" isLast>
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 font-medium text-gray-800">{result.destination}</p>
                      {destinationArrivalDate && (
                        <p className="shrink-0 text-sm text-gray-600">
                          <span className="font-semibold text-gray-800">
                            {formatJapanTime(destinationArrivalDate)}
                          </span>{" "}
                          到着目安
                        </p>
                      )}
                    </div>
                  </TimelineRow>
                </ol>
                {pickupCandidates.length > 1 && (
                  <p className="mt-2 text-xs text-gray-500">
                    受取地点は{pickupCandidates.length}か所あります。タップで選べます。
                  </p>
                )}
                {pickupDayLabel && (
                  <p className="mt-2 text-sm font-medium">{pickupDayLabel}の受取です</p>
                )}
                <p className="mt-2 text-xs text-gray-500">到着目安は寄り道時間を含みません</p>
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
                    <div className="mt-3 rounded-lg bg-amber-50 p-3">
                      <p className="text-sm text-amber-900">
                        受取時間帯{" "}
                        <span className="whitespace-nowrap">{pickupWindowLabel}</span>{" "}
                        <span className="inline-block">に受け取れる商品はありません。</span>
                      </p>
                      {laterAction && <div className="mt-2">{renderLaterAction()}</div>}
                    </div>
                  )}

                {!itemsLoading && !itemsError && timeFilteredItems.length > 0 && (
                  <ul className="mt-3 space-y-2">
                    {timeFilteredItems.map((item) => {
                      const bookable = item.stock > 0 && !isPickupWindowExpired;
                      const cardBody = (
                        <>
                          <ItemThumbnail itemId={item.id} title={item.title} />
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold">
                              {item.title}
                              {item.type === "experience" && (
                                <span className="ml-2 text-xs font-normal text-gray-500">体験</span>
                              )}
                            </p>
                            <div className="mt-1 flex items-center gap-2">
                              <span className="text-lg font-bold leading-none">
                                {formatYen(item.price)}
                              </span>
                              <StockLabel stock={item.stock} />
                              {bookable ? (
                                <span
                                  aria-hidden="true"
                                  className="ml-auto shrink-0 whitespace-nowrap text-sm font-semibold text-[#2f6f3e]"
                                >
                                  予約 ›
                                </span>
                              ) : (
                                item.stock > 0 && (
                                  <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-gray-500">
                                    受取時間帯が終了
                                  </span>
                                )
                              )}
                            </div>
                          </div>
                        </>
                      );
                      return (
                        <li key={item.id}>
                          {bookable ? (
                            // カード全体を予約画面へのリンクにする(遷移先・引き継ぐ
                            // stateは従来の「予約する」ボタンと同じ)。
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
                              aria-label={`${item.title}（${formatYen(item.price)}）を予約する`}
                              className="flex min-h-[88px] items-center gap-3 rounded-lg border border-gray-200 p-3 hover:border-[#2f6f3e] active:bg-[#f7fbf6]"
                            >
                              {cardBody}
                            </Link>
                          ) : (
                            <div
                              aria-disabled="true"
                              className="flex min-h-[88px] items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-gray-500"
                            >
                              {cardBody}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                {!itemsLoading && !itemsError && laterItems.length > 0 && (
                  <div className="mt-4">
                    <h3 className="text-sm font-semibold text-gray-700">
                      時間を変えると受け取れる商品
                    </h3>
                    {timeFilteredItems.length > 0 && laterAction && (
                      <div className="mt-2">{renderLaterAction()}</div>
                    )}
                    <ul className="mt-2 space-y-2">
                      {laterItems.map((item) => (
                        <li
                          key={item.id}
                          className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3"
                        >
                          <div className="flex items-start gap-3">
                            <ItemThumbnail itemId={item.id} title={item.title} />
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-gray-700">{item.title}</p>
                              <p className="mt-0.5 flex items-center gap-2">
                                <span className="text-lg font-bold text-gray-700">
                                  {formatYen(item.price)}
                                </span>
                                <StockLabel stock={item.stock} />
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
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <details ref={timeAdjustRef} className="group rounded-xl bg-white shadow-sm">
                <summary className="flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <span className="text-base font-semibold">受取時間を変更</span>
                  <span className="flex items-center gap-2 text-sm text-gray-600">
                    <span className="whitespace-nowrap">{pickupWindowLabel}</span>
                    <span
                      aria-hidden="true"
                      className="inline-block text-lg leading-none transition-transform group-open:rotate-90"
                    >
                      ›
                    </span>
                  </span>
                </summary>
                <div className="px-4 pb-4">
                  <p className="text-xs text-gray-500">
                    到着目安の前後3時間まで、30分単位でずらせます
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
              </details>
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
