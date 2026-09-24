import React, { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import api from "../api/client";
import { saveAccessToken } from "../utils/reservationAccess";

function minimumJapanDateTime() {
  const oneMinuteFromNowInJapan = Date.now() + 9 * 60 * 60 * 1000 + 60 * 1000;
  return new Date(oneMinuteFromNowInJapan).toISOString().slice(0, 16);
}

// RouteTestで選択した受取時間帯の表示用(ReservationComplete.jsx/
// StaffVerify.jsxの日時表示と同じAsia/Tokyo・h23形式に合わせる)。
function formatPickupWindow(startValue, endValue) {
  const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${dateFormatter.format(new Date(startValue))}〜${timeFormatter.format(new Date(endValue))}`;
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
          });
        }
      } catch (e) {
        setError(e.message || "Failed to load item");
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

  if (loading) return <div className="p-4">読み込み中…</div>;
  if (error) return <div className="p-4 text-red-600">{error}</div>;
  if (!item) return <div className="p-4">指定された商品が見つかりません。</div>;

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
        pickupWindowStart,
        pickupWindowEnd,
      },
    });
  }

  async function handleConfirmPayment() {
    // 二重送信防止: submitting中はボタン自体をdisabledにする(下のJSX)ため、
    // ここでも念のため既に送信中なら何もしない。
    if (submitting) return;

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
        try {
          sessionStorage.setItem(
            `traildrop_route_${res.id}`,
            JSON.stringify({ origin: routeOrigin, destination: routeDestination, passPoint: routePassPoint }),
          );
        } catch (storageError) {
          // 保存できなくても無視する。完了画面でGoogle Mapsボタンが
          // 表示されない可能性があるだけで、予約完了自体は継続する。
        }
      }

      navigate(`/complete/${res.id}`, {
        replace: true,
        state: {
          access_token: res?.access_token || null,
          ...(hasRouteContext
            ? { origin: routeOrigin, destination: routeDestination, passPoint: routePassPoint }
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
      setFormError(definitelyNotCreated ? e.message || "予約に失敗しました" : null);
    } finally {
      setSubmitting(false);
    }
  }

  const selectedPaymentLabel = PAYMENT_METHODS.find((m) => m.value === paymentMethod)?.label || "";

  return (
    <div className="min-h-screen p-4 bg-[#f7fbf6] text-[#16381b]">
      <header className="mb-4">
        <h2 className="text-xl font-semibold">{item.name}</h2>
        <div className="text-sm">場所: {item.location}</div>
        {/* RouteTestで受取時間帯を選択してきた場合のみ表示する(入力画面・
            確認画面の両方で確認できるようheaderに置く)。選択していない場合
            (ItemListから直接来た等)はこのブロック自体を出さない。 */}
        {pickupWindowStart && pickupWindowEnd && (
          <div className="text-sm text-gray-600">
            受取時間帯: {formatPickupWindow(pickupWindowStart, pickupWindowEnd)}
          </div>
        )}
      </header>

      {!isConfirmStep ? (
        <form onSubmit={handleProceedToConfirm} className="space-y-3">
          <div className="text-lg font-bold">¥{item.price}</div>
          {item.requiresDate && (
            <label className="block">
              <div className="text-sm">希望日時</div>
              <input type="datetime-local" value={date} min={minimumJapanDateTime()} onChange={(e) => setDate(e.target.value)} required className="mt-1 p-2 border rounded w-full" />
            </label>
          )}

          <label className="block">
            <div className="text-sm">氏名（必須）</div>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 p-2 border rounded w-full" />
          </label>

          <fieldset className="block">
            <legend className="text-sm">支払い方法（必須）</legend>
            <div className="mt-1 space-y-1">
              {PAYMENT_METHODS.map((method) => (
                <label key={method.value} className="flex items-center gap-2 p-2 border rounded">
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

          {formError && <div className="text-red-600">{formError}</div>}

          <div className="flex justify-end">
            <button type="submit" className="px-4 py-2 bg-[#2f6f3e] text-white rounded">
              支払い内容を確認する
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="bg-white p-4 rounded-md shadow">
            <h3 className="text-sm font-semibold mb-2">支払い内容のご確認</h3>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt>商品</dt>
                <dd>{item.name}</dd>
              </div>
              <div className="flex justify-between">
                <dt>金額</dt>
                <dd>¥{item.price}</dd>
              </div>
              <div className="flex justify-between">
                <dt>氏名</dt>
                <dd>{name}</dd>
              </div>
              {item.requiresDate && (
                <div className="flex justify-between">
                  <dt>希望日時</dt>
                  <dd>{date}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt>支払い方法</dt>
                <dd>{selectedPaymentLabel}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-gray-500">
              これはデモ用のモック決済です。実際の支払いは発生しません。
            </p>
          </div>

          {ambiguousFailure && (
            <div
              className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
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
          {formError && <div className="text-red-600">{formError}</div>}

          <div className="flex gap-2">
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
                    pickupWindowStart,
                    pickupWindowEnd,
                  },
                })
              }
              disabled={submitting}
              className="flex-1 px-4 py-2 bg-gray-200 rounded disabled:opacity-50"
            >
              戻る
            </button>
            <button
              type="button"
              onClick={handleConfirmPayment}
              disabled={submitting}
              aria-busy={submitting}
              className={`flex-1 px-4 py-2 text-white rounded ${submitting ? 'bg-gray-400' : 'bg-[#2f6f3e]'}`}
            >
              {submitting ? '予約中…' : '支払いを確定する'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
