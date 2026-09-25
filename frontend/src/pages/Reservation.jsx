import React, { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import api from "../api/client";
import { saveAccessToken } from "../utils/reservationAccess";
import { saveRouteContext } from "../utils/routeContext";
import { isPickupWindowEnded, msUntilPickupWindowEnds } from "../utils/pickupWindow";
import { toUserMessage } from "../utils/errorMessages";
import { formatPickupHours } from "../utils/pickupHours";
import {
  AppLayout,
  formatYen,
  primaryButtonClass,
  secondaryButtonClass,
} from "../components/ui";

const ITEM_LOAD_ERROR_MESSAGE = "商品情報を取得できませんでした。時間をおいて、もう一度お試しください。";

// 予約作成が「確実に失敗した」(DEFINITELY_NOT_CREATED_STATUSES)場合に表示する
// 文言。Backend(main.pyのreservation_error等)・DEMO_MODEが返すdetailの英文を
// 画面に出さず、理由が伝わる日本語にする。
const CREATE_ERROR_BY_DETAIL = {
  "Item is out of stock": "申し訳ありません。この商品は在庫切れになりました。",
  "Item not found": "この商品は見つかりませんでした。一覧から選び直してください。",
  "Experience date is required": "希望日時を入力してください。",
  "Requested date must be in the future": "希望日時は現在より後の日時を指定してください。",
  "Invalid payment method": "支払い方法を選び直してください。",
  "Pickup window is invalid":
    "受取時間帯が正しくありません。お手数ですが、もう一度検索からやり直してください。",
};
const CREATE_ERROR_BY_STATUS = {
  400: "入力内容が正しくありません。",
  404: "この商品は見つかりませんでした。一覧から選び直してください。",
  409: "申し訳ありません。この商品は在庫切れになりました。",
  422: "入力内容が正しくありません。",
};
const CREATE_ERROR_FALLBACK = "予約に失敗しました。";

const PICKUP_WINDOW_ENDED_MESSAGE =
  "受取時間帯が終了しています。お手数ですが、もう一度検索からやり直してください。";
// setTimeoutの遅延上限(約24.8日)。これを超える先の終了時刻は、上限で一度
// 起きてから再計算する。
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// datetime-local入力値("YYYY-MM-DDTHH:MM"、timezoneを持たないJST壁時計時刻
// として扱う。handleConfirmPaymentの`${date}:00+09:00`と同じ解釈)を、
// 生の値のまま表示せず日本語の日時表示に変換する(一括修正U5)。
function formatRequestedDateTime(value) {
  if (!value) return "";
  const parsed = new Date(`${value}:00+09:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(parsed);
}

function minimumJapanDateTime() {
  const oneMinuteFromNowInJapan = Date.now() + 9 * 60 * 60 * 1000 + 60 * 1000;
  return new Date(oneMinuteFromNowInJapan).toISOString().slice(0, 16);
}

// RouteTestで選択した受取時間帯の表示用(「9月26日(土) 10:00〜12:00」)。
function formatPickupWindow(startValue, endValue) {
  const dayFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const start = new Date(startValue);
  return `${dayFormatter.format(start)} ${timeFormatter.format(start)}〜${timeFormatter.format(new Date(endValue))}`;
}

// main.pyのVALID_PAYMENT_METHODSと合わせる。実決済は行わないモック決済。
const PAYMENT_METHODS = [
  { value: "paypay", label: "PayPay" },
  { value: "credit_card", label: "クレジットカード" },
];

// POST /reservationsがこれらのstatusで失敗した場合、main.pyのcreate_
// reservation_with_stock RPCは例外を送出しており(=そのRPC呼び出し内で
// 行った全ての書き込みがPostgresのトランザクションとしてロールバック
// される)、予約が作成されていないと確実に言える。それ以外の失敗
// (ネットワーク断、5xx、応答のJSON解析失敗などでerr.statusが無い/
// 想定外の値)は、リクエストがサーバーに届いた後で応答だけが失われた
// 可能性を否定できないため、専用の警告文言にする(Idempotency-Keyは
// 今回実装しないため、Frontend側で「確実に失敗した」と言い切れない)。
const DEFINITELY_NOT_CREATED_STATUSES = new Set([400, 404, 409, 422]);

// 曖昧な失敗時(=DEFINITELY_NOT_CREATED_STATUSESに該当しない失敗)は、
// 「予約状況を確認してください」という、実際にはFrontendから行えない操作を
// 単独で案内しない。何が分かっていて何ができないかを具体的に示す
// AmbiguousFailureNotice(下のJSX内)で案内する。

// 支払い確認画面(/reserve/:id/confirm)は別ルートとして扱うが、入力内容の
// state自体はページ遷移(unmount)で失われるため、ブラウザの戻る操作で
// 予約フォームに戻った際に入力内容を復元できるようsessionStorageにも
// 一時保存する(予約作成成功時にclearDraftで消す)。
const DRAFT_KEY_PREFIX = "traildrop_reserve_draft_";

function loadDraft(id) {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY_PREFIX + id);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    // 保存された希望日時が既に過去になっている場合は復元しない(そのまま
    // 送信すると422になるため)。氏名・支払い方法はそのまま復元する。
    if (draft?.date) {
      const draftDateTime = new Date(`${draft.date}:00+09:00`);
      if (Number.isNaN(draftDateTime.getTime()) || draftDateTime.getTime() < Date.now()) {
        return { ...draft, date: "" };
      }
    }
    return draft;
  } catch {
    return null;
  }
}

function saveDraft(id, draft) {
  try {
    sessionStorage.setItem(DRAFT_KEY_PREFIX + id, JSON.stringify(draft));
  } catch {
    // 保存できなくても致命的ではない(戻った際に入力内容が復元されないだけ)。
  }
}

function clearDraft(id) {
  try {
    sessionStorage.removeItem(DRAFT_KEY_PREFIX + id);
  } catch {
    // ignore
  }
}

export default function Reservation() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // RouteTestから遷移してきた場合のみ、Google Maps引き継ぎに使う経路情報を
  // 受け取る。ItemListから直接来た場合はundefinedのままで、以降も一切
  // 補完しない(推測でdestinationを作らない)。
  const {
    origin: routeOrigin,
    destination: routeDestination,
    passPoint: routePassPoint,
    // 受取地点の座標(route modeの候補のみ。無ければundefined)。Google Mapsの
    // 経由地を正確にするためだけに完了画面へ引き継ぐ。
    passPointLat: routePassPointLat,
    passPointLng: routePassPointLng,
    // RouteTestで選択した受取時間帯(ISO文字列)。ItemListから直接来た場合は
    // undefinedのままで、origin等と同じく推測で補わない。
    pickupWindowStart,
    pickupWindowEnd,
  } = location.state || {};
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  // 商品自体の読み込み失敗(致命的、フォームごと表示できない)専用。
  // フォームの入力チェックや予約API呼び出しの失敗はformErrorを使う
  // (誤ってこちらを使うと、下のearly returnで画面全体がエラー文言だけに
  // なってしまう)。
  const [error, setError] = useState(null);
  // 「予約情報入力」の後に「支払い確認」を挟む。/reserve/:id/confirmという
  // 別ルートとして扱うことで、ブラウザの戻る操作でも正しく/reserve/:idへ
  // 戻れるようにする(以前はコンポーネント内stateだけで切り替えており、
  // 戻る操作がこのステップを経由せず一覧まで戻ってしまっていた)。
  const isConfirmStep = location.pathname.endsWith("/confirm");
  // 確認画面への遷移時はlocation.stateに入力内容を積むが、入力画面へ
  // 戻った時に表示する値はsessionStorageのdraftから復元する(location.state
  // はページ遷移のたびに変わり、戻る操作用の値としては使えないため)。
  const [name, setName] = useState(() => location.state?.name ?? loadDraft(id)?.name ?? "");
  const [date, setDate] = useState(() => location.state?.date ?? loadDraft(id)?.date ?? "");
  const [paymentMethod, setPaymentMethod] = useState(
    () => location.state?.paymentMethod ?? loadDraft(id)?.paymentMethod ?? "",
  );
  const [formError, setFormError] = useState(null);
  // 予約作成が成功したか判断できない「曖昧な失敗」の場合だけ専用の警告を
  // 表示する(「再試行すれば安全」と誤解させる表示にしないため)。
  const [ambiguousFailure, setAmbiguousFailure] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function loadItem() {
      setLoading(true);
      try {
        const items = await api.getItems();
        const found = (items || []).find((it) => String(it.id) === String(id));
        if (!found) {
          setError("指定された商品が見つかりません。");
        } else {
          setItem({
            id: found.id,
            name: found.title,
            price: found.price,
            location: found.location_name,
            requiresDate: found.type === "experience",
            stock: found.stock,
            pickupAvailableFrom: found.pickup_available_from,
            pickupAvailableTo: found.pickup_available_to,
          });
        }
      } catch (e) {
        setError(toUserMessage(e, { fallback: ITEM_LOAD_ERROR_MESSAGE }));
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadItem();
    return () => (mounted = false);
  }, [id]);

  // /reserve/:id/confirmへ直接アクセス・リロードした場合など、確認に必要な
  // 入力内容(location.state・draftのどちらにも無い)が無ければ、確認画面を
  // 空のまま表示せず入力画面へ戻す。
  useEffect(() => {
    if (!item || !isConfirmStep) return;
    const missingRequired = !name.trim() || !paymentMethod || (item.requiresDate && !date);
    if (missingRequired) {
      navigate(`/reserve/${id}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, isConfirmStep]);

  // 確認画面⇔入力画面を行き来した際、前のステップで出ていたエラー表示を
  // 持ち越さない(入力内容・draftの復元とは無関係にリセットする)。
  useEffect(() => {
    setFormError(null);
    setAmbiguousFailure(false);
  }, [isConfirmStep]);

  // PMレビューm-a: 受取時間帯の終了判定をrender時のDate.now()だけに頼ると、
  // 画面を開いたまま終了時刻を過ぎても再renderが起きず、ボタンが押せる
  // ままになる。終了時刻ちょうどにタイマーで再判定し、端末スリープ等で
  // タイマーが遅れた場合に備えて画面復帰時にも再判定する。送信時には
  // さらに押下時点の現在時刻で判定し直す(handleConfirmPayment)。
  const [pickupWindowEnded, setPickupWindowEnded] = useState(() =>
    isPickupWindowEnded(pickupWindowEnd),
  );
  const [pickupWindowCheckTick, setPickupWindowCheckTick] = useState(0);

  useEffect(() => {
    setPickupWindowEnded(isPickupWindowEnded(pickupWindowEnd));
    const remainingMs = msUntilPickupWindowEnds(pickupWindowEnd);
    if (remainingMs === null) return undefined;
    // +50msは、タイマーが境界ちょうどで発火してend <= nowをまだ満たさない
    // ケースを避けるための余裕(満たさなければ再度タイマーを張るだけ)。
    const timeoutId = setTimeout(
      () => setPickupWindowCheckTick((tick) => tick + 1),
      Math.min(remainingMs + 50, MAX_TIMEOUT_MS),
    );
    return () => clearTimeout(timeoutId);
  }, [pickupWindowEnd, pickupWindowCheckTick]);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        setPickupWindowCheckTick((tick) => tick + 1);
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  if (loading)
    return (
      <AppLayout step={3}>
        <p className="p-4">読み込み中…</p>
      </AppLayout>
    );
  if (error)
    return (
      <AppLayout step={3}>
        <p className="p-4 text-red-600">{error}</p>
      </AppLayout>
    );
  if (!item)
    return (
      <AppLayout step={3}>
        <p className="p-4">指定された商品が見つかりません。</p>
      </AppLayout>
    );

  function handleProceedToConfirm(e) {
    e.preventDefault();
    if (!name.trim()) {
      setFormError("氏名を入力してください。");
      return;
    }
    if (item.requiresDate && !date) {
      setFormError("希望日時を入力してください。");
      return;
    }
    if (!paymentMethod) {
      setFormError("支払い方法を選択してください。");
      return;
    }
    if (isPickupWindowEnded(pickupWindowEnd, Date.now())) {
      setPickupWindowEnded(true);
      setFormError(PICKUP_WINDOW_ENDED_MESSAGE);
      return;
    }
    setFormError(null);
    saveDraft(id, { name, date, paymentMethod });
    navigate(`/reserve/${id}/confirm`, {
      state: {
        name,
        date,
        paymentMethod,
        origin: routeOrigin,
        destination: routeDestination,
        passPoint: routePassPoint,
        passPointLat: routePassPointLat,
        passPointLng: routePassPointLng,
        pickupWindowStart,
        pickupWindowEnd,
      },
    });
  }

  async function handleConfirmPayment() {
    // 二重送信防止: submitting中はボタン自体をdisabledにする(下のJSX)ため、
    // ここでも念のため既に送信中なら何もしない。
    if (submitting) return;

    // 古い/不正なRouteTest状態(戻る/進む操作、別タブの古い結果からの直接
    // 遷移、確認画面を開いたままの時間経過など)から送信されるケースを防ぐ。
    // render時の値ではなく、押下時点の現在時刻で必ず判定し直す(PMレビュー
    // m-a)。Backend側でも同じ基準(end <= now)で422になるが、ここで先に
    // 弾いて不要な通信・分かりにくい失敗表示を避ける。
    if (isPickupWindowEnded(pickupWindowEnd, Date.now())) {
      setPickupWindowEnded(true);
      setFormError(PICKUP_WINDOW_ENDED_MESSAGE);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setAmbiguousFailure(false);
    try {
      const requestedAt = item.requiresDate ? `${date}:00+09:00` : null;
      // 実際の外部決済は一切行わない。ここでの成功=モック決済成功として
      // 扱い、予約作成と同じAPI呼び出しで完結させる(Backend側もpayment_
      // statusを同じRPC内でpaidにする)。
      const res = await api.createReservation({
        item_id: item.id,
        user_name: name.trim(),
        requested_at: requestedAt,
        payment_method: paymentMethod,
        pickup_window_start: pickupWindowStart || null,
        pickup_window_end: pickupWindowEnd || null,
      });
      clearDraft(id);
      // access_tokenはタブ単位(sessionStorage)に加え、タブを閉じた後でも同じ
      // 端末で予約を再表示できるようlocalStorageにも保存する。保存に失敗しても
      // 例外は投げない(予約は成功しているため、完了画面へはlocation.stateの
      // access_tokenで必ず遷移させる)。
      if (res?.access_token) {
        saveAccessToken(res.id, res.access_token);
      }

      const hasRouteContext = Boolean(routeOrigin && routeDestination && routePassPoint);
      if (hasRouteContext) {
        // route情報は補助データ(Google Mapsボタン表示用)であり、これの保存に
        // 失敗しても予約自体は成立させる。外側のtry/catchに巻き込むと、予約は
        // 成功しているのに完了画面へ遷移できなくなってしまうため個別に囲む。
        // localStorage保存(saveRouteContext内)により、別タブで完了画面を
        // 開いた場合でもGoogle Mapsボタンを表示できる(一括修正U6)。
        saveRouteContext(res.id, {
          origin: routeOrigin,
          destination: routeDestination,
          passPoint: routePassPoint,
          passPointLat: routePassPointLat,
          passPointLng: routePassPointLng,
        });
      }

      navigate(`/complete/${res.id}`, {
        replace: true,
        state: {
          access_token: res?.access_token || null,
          ...(hasRouteContext
            ? {
                origin: routeOrigin,
                destination: routeDestination,
                passPoint: routePassPoint,
                passPointLat: routePassPointLat,
                passPointLng: routePassPointLng,
              }
            : {}),
        },
      });
    } catch (e) {
      // エラー時も確認画面(/reserve/:id/confirm)は維持し、name/date/
      // paymentMethodのstateも一切触らない。入力し直さずそのまま
      // 「支払いを確定する」を再度押せば再試行できる(ただし曖昧な失敗時は
      // 二重予約の恐れを警告表示し、安易な再試行を促さない)。
      const definitelyNotCreated = DEFINITELY_NOT_CREATED_STATUSES.has(e?.status);
      setAmbiguousFailure(!definitelyNotCreated);
      setFormError(
        definitelyNotCreated
          ? toUserMessage(e, {
              byDetail: CREATE_ERROR_BY_DETAIL,
              byStatus: CREATE_ERROR_BY_STATUS,
              fallback: CREATE_ERROR_FALLBACK,
            })
          : null,
      );
    } finally {
      setSubmitting(false);
    }
  }

  const selectedPaymentLabel = PAYMENT_METHODS.find((m) => m.value === paymentMethod)?.label || "";
  // PMレビューBLOCKER B1: RouteTest.jsx側でも「受取時間帯終了」なら予約導線を
  // 塞いでいるが、ブラウザの戻る/進む操作や、別タブで古いRouteTest結果から
  // 直接この画面のURLを開いた場合など、古いlocation.stateのままここへ
  // 到達するケースがあり得る。Backend(models.py)の判定基準(end <= now なら
  // 無効)と揃え、確認画面での送信自体も多重に防ぐ。値は上のタイマーで
  // 現在時刻に追従する(PMレビューm-a)。
  const isPickupWindowExpired = pickupWindowEnded;

  // 受取地点はRouteTestで選んだ地点を優先し、無ければ商品の受取場所。
  const pickupPlace = routePassPoint || item.location;
  const itemHoursLabel =
    item.pickupAvailableFrom && item.pickupAvailableTo
      ? `${formatPickupHours(item.pickupAvailableFrom)}〜${formatPickupHours(item.pickupAvailableTo)}`
      : null;
  // RouteTestで受取時間帯を選択してきた場合のみ時間帯を表示する。選択して
  // いない場合(商品一覧から直接来た等)は「時間指定なし」とし、推測で補わない。
  const pickupWindowLabel =
    pickupWindowStart && pickupWindowEnd
      ? formatPickupWindow(pickupWindowStart, pickupWindowEnd)
      : `時間指定なし${itemHoursLabel ? `（営業時間 ${itemHoursLabel}）` : ""}`;

  const summaryRows = [
    { label: "受取地点", value: pickupPlace },
    // 体験は受取時間帯ではなく希望日時で予約する。
    ...(item.requiresDate ? [] : [{ label: "受取時間帯", value: pickupWindowLabel }]),
    { label: "金額", value: formatYen(item.price) },
  ];

  const formErrorNode = formError && (
    <p className="mb-2 text-sm text-red-600" role="alert">
      {formError}
    </p>
  );

  if (!isConfirmStep) {
    return (
      <AppLayout
        step={3}
        bottomBar={
          <>
            {formErrorNode}
            <button type="submit" form="reservation-form" className={primaryButtonClass}>
              確認へ進む
            </button>
          </>
        }
      >
        <h1 className="pt-2 text-xl font-bold">予約内容の入力</h1>

        <section className="mt-3 rounded-xl bg-white p-4 shadow-sm">
          <p className="text-lg font-semibold">{item.name}</p>
          <dl className="mt-2 space-y-2 text-sm">
            {summaryRows.map((row) => (
              <div key={row.label} className="flex justify-between gap-3">
                <dt className="shrink-0 text-gray-500">{row.label}</dt>
                <dd className="text-right font-medium">{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <form
          id="reservation-form"
          onSubmit={handleProceedToConfirm}
          className="mt-4 space-y-4 rounded-xl bg-white p-4 shadow-sm"
        >
          {item.requiresDate && (
            <label className="block">
              <span className="text-sm font-medium">希望日時</span>
              <input
                type="datetime-local"
                value={date}
                min={minimumJapanDateTime()}
                onChange={(e) => setDate(e.target.value)}
                required
                className="mt-1 block min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 text-base"
              />
            </label>
          )}

          <label className="block">
            <span className="text-sm font-medium">氏名</span>
            <span className="block text-xs text-gray-500">
              受取時の照合に使用します（100文字まで）
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              autoComplete="name"
              className="mt-1 block min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 text-base"
            />
          </label>

          <fieldset>
            <legend className="text-sm font-medium">支払い方法</legend>
            <div className="mt-1 space-y-2">
              {PAYMENT_METHODS.map((method) => (
                <label
                  key={method.value}
                  className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border px-3 ${
                    paymentMethod === method.value
                      ? "border-[#2f6f3e] bg-[#eef6ec]"
                      : "border-gray-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="payment_method"
                    value={method.value}
                    checked={paymentMethod === method.value}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                  />
                  <span>{method.label}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              ※これはデモ用のモック決済です。実際の支払いは発生しません。
            </p>
          </fieldset>
        </form>
      </AppLayout>
    );
  }

  return (
    <AppLayout
      step={3}
      bottomBar={
        <>
          {formErrorNode}
          <button
            type="button"
            onClick={handleConfirmPayment}
            disabled={submitting || isPickupWindowExpired}
            aria-busy={submitting}
            className={primaryButtonClass}
          >
            {submitting ? "予約中…" : `${formatYen(item.price)} で予約を確定する`}
          </button>
        </>
      }
    >
      <h1 className="pt-2 text-xl font-bold">予約内容の確認</h1>

      <section className="mt-3 rounded-xl bg-white p-4 shadow-sm">
        <dl className="divide-y divide-gray-100 text-sm">
          {[
            { label: "商品", value: item.name },
            ...summaryRows,
            { label: "氏名", value: name },
            ...(item.requiresDate
              ? [{ label: "希望日時", value: formatRequestedDateTime(date) }]
              : []),
            { label: "支払い方法", value: selectedPaymentLabel },
          ].map((row) => (
            <div key={row.label} className="flex justify-between gap-3 py-2">
              <dt className="shrink-0 text-gray-500">{row.label}</dt>
              <dd className="text-right font-medium">{row.value}</dd>
            </div>
          ))}
        </dl>
        {/* 「…発生しませ/ん。」のような改行を避けるため、文単位で折り返す。 */}
        <p className="mt-2 text-xs text-gray-500">
          <span className="inline-block">これはデモ用のモック決済です。</span>
          <span className="inline-block">実際の支払いは発生しません。</span>
        </p>
      </section>

      {ambiguousFailure && (
        <div
          className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          role="alert"
        >
          <p className="font-semibold">予約が完了したかどうか、この画面では確認できません</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>通信状況により、予約が作成されたかどうかをこの画面では判断できませんでした。</li>
            <li>
              同じ内容でお支払いをすぐに再試行すると、二重に予約されるおそれがあります。むやみに再試行しないでください。
            </li>
            <li>現時点では、この画面から予約状況をご自身で確認する機能はありません。</li>
            <li>ご不安な場合は、受取窓口（{item.location}）で予約状況をご確認ください。</li>
          </ul>
        </div>
      )}
      {/* 押下時の再判定でformErrorに同じ文言を出した場合は二重に表示しない。 */}
      {isPickupWindowExpired && formError !== PICKUP_WINDOW_ENDED_MESSAGE && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {PICKUP_WINDOW_ENDED_MESSAGE}
        </div>
      )}

      <button
        type="button"
        // 確認画面の履歴を入力画面で置き換える(replace)。pushすると
        // 入力内容を持った確認画面の履歴が残り、予約完了後にブラウザの
        // 戻る操作でその確認画面へ戻って二重予約できてしまうため。
        onClick={() =>
          navigate(`/reserve/${id}`, {
            replace: true,
            state: {
              origin: routeOrigin,
              destination: routeDestination,
              passPoint: routePassPoint,
              passPointLat: routePassPointLat,
              passPointLng: routePassPointLng,
              pickupWindowStart,
              pickupWindowEnd,
            },
          })
        }
        disabled={submitting}
        className={`${secondaryButtonClass} mt-4`}
      >
        入力内容を修正する
      </button>
    </AppLayout>
  );
}
