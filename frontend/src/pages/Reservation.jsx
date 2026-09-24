import React, { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import api from "../api/client";

function minimumJapanDateTime() {
  const oneMinuteFromNowInJapan = Date.now() + 9 * 60 * 60 * 1000 + 60 * 1000;
  return new Date(oneMinuteFromNowInJapan).toISOString().slice(0, 16);
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
const AMBIGUOUS_CREATION_FAILURE_MESSAGE =
  "予約の結果を確認できませんでした。予約が作成されている可能性があります。再試行する前に予約状況をご確認ください。";

export default function Reservation() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // RouteTestから遷移してきた場合のみ、Google Maps引き継ぎに使う経路情報を
  // 受け取る。ItemListから直接来た場合はundefinedのままで、以降も一切
  // 補完しない(推測でdestinationを作らない)。
  const { origin: routeOrigin, destination: routeDestination, passPoint: routePassPoint } =
    location.state || {};
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  // 商品自体の読み込み失敗(致命的、フォームごと表示できない)専用。
  // フォームの入力チェックや予約API呼び出しの失敗はformErrorを使う
  // (誤ってこちらを使うと、下のearly returnで画面全体がエラー文言だけに
  // なってしまう)。
  const [error, setError] = useState(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [formError, setFormError] = useState(null);
  // 「予約情報入力」の後に「支払い確認」を挟む(このコンポーネント内の
  // インライン確認ステップとして。新しい画面遷移は増やさない)。confirming
  // がtrueの間は入力内容を確定として扱い、実際のAPI呼び出しはconfirmボタン
  // を押したときだけ行う。
  const [confirming, setConfirming] = useState(false);
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
    setConfirming(true);
  }

  async function handleConfirmPayment() {
    // 二重送信防止: submitting中はボタン自体をdisabledにする(下のJSX)ため、
    // ここでも念のため既に送信中なら何もしない。
    if (submitting) return;

    setSubmitting(true);
    setFormError(null);
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
      });
      if (res?.access_token) {
        sessionStorage.setItem(`traildrop_access_token_${res.id}`, res.access_token);
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
      // エラー時もconfirming(支払い確認画面)は維持し、name/date/
      // paymentMethodのstateも一切触らない。入力し直さずそのまま
      // 「支払いを確定する」を再度押せば再試行できる。
      const msg = DEFINITELY_NOT_CREATED_STATUSES.has(e?.status)
        ? e.message || "予約に失敗しました"
        : AMBIGUOUS_CREATION_FAILURE_MESSAGE;
      setFormError(msg);
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
      </header>

      {!confirming ? (
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

          {formError && <div className="text-red-600">{formError}</div>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setFormError(null);
              }}
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
