import { useRef, useState } from "react";
import api from "../api/client";
import QrScanner from "../components/QrScanner";

function formatJapanDateTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

// 予約確認結果の取得時刻用(例: 2026/09/24 15:00)。
function formatFetchedAt(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

// Reservation.jsxのPAYMENT_METHODSと合わせる。
const PAYMENT_METHOD_LABELS = {
  paypay: "PayPay",
  credit_card: "クレジットカード",
};

// Backend/DBのpayment_statusは'pending'/'paid'/'cancelled'(予約自体の
// status pending/completed/cancelledとは別の値域)。
// 'pending'は支払い機能(PR #14)追加以前の既存予約に入るデフォルト値で、
// 実際の支払い状況は不明。「未払い」と表示すると支払いを求める誤解を
// 招くため、支払い情報が無いことをそのまま表示する。
const PAYMENT_STATUS_LABELS = {
  pending: "支払い情報なし（機能追加前の予約）",
  paid: "支払い済み",
  cancelled: "キャンセル済み",
};

// ReservationComplete.jsxのSTATUS_DISPLAYと同じ3状態だが、文言はスタッフが
// 「今これを受け渡してよいか」を即座に判断できる表現にしている。
const RESERVATION_STATUS_DISPLAY = {
  pending: { label: "受け渡し可能", className: "bg-[#eef6ec] text-[#2f6f3e]" },
  completed: { label: "受取済み", className: "bg-blue-50 text-blue-800" },
  cancelled: { label: "キャンセル済み", className: "bg-gray-100 text-gray-600" },
};
const UNKNOWN_RESERVATION_STATUS_DISPLAY = {
  label: "状態不明",
  className: "bg-gray-100 text-gray-700",
};

// Backendのdetailは英語のまま返るため、想定済みのステータスはここで日本語へ
// 変換する(client.jsの共通errorMessage()は他フローにも使われるため変更しない)。
const STATUS_MESSAGES = {
  401: "スタッフトークンが正しくありません。",
  404: "QRトークンが見つかりません。",
  409: "この予約はすでに受取済みです。",
  422: "QRトークンの形式が正しくありません。",
  502: "QR検証に失敗しました。",
  503: "スタッフ認証が設定されていません。",
};

// GET /staff/reservations/{id}用。verify_qrとdetail文言が異なる箇所だけ
// 上書きする。
const LOOKUP_STATUS_MESSAGES = {
  ...STATUS_MESSAGES,
  404: "予約が見つかりません。",
  502: "予約情報の取得に失敗しました。",
};

// verify_qrは409を「すでに受取済み(completed)」と「キャンセル済み
// (cancelled)」の両方に使うため、detailの文言で区別する。errorMessage()
// (client.js)はdetailが文字列ならそのまま返すので、Backend/DEMO_MODEの
// どちらでも requestError.message === "Reservation is cancelled" になる。
function isCancelledConflict(requestError) {
  return requestError?.status === 409 && requestError?.message === "Reservation is cancelled";
}

function resolveErrorMessage(requestError) {
  if (isCancelledConflict(requestError)) {
    return "この予約はキャンセル済みのため、受け渡しできません。";
  }
  return STATUS_MESSAGES[requestError?.status] || requestError?.message || "QR検証に失敗しました。";
}

function resolveLookupErrorMessage(requestError) {
  return (
    LOOKUP_STATUS_MESSAGES[requestError?.status] ||
    requestError?.message ||
    "予約情報の取得に失敗しました。"
  );
}

export default function StaffVerify() {
  const [staffToken, setStaffToken] = useState("");
  const [qrToken, setQrToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  // 受取完了した予約の商品名。GET /itemsの正式な商品データからitem_idで引き、
  // 取得できない場合は推測せず取得失敗として表示する。
  const [itemTitle, setItemTitle] = useState(null);
  // カメラでのQR読み取りUIの表示状態。手入力方式とは併用できる。
  const [scanning, setScanning] = useState(false);
  // 受取確認の二重送信防止。loading stateは非同期に反映されるため、
  // 読み取り直後の連続通知などでも確実に1回だけAPIを呼ぶようrefで判定する。
  const verifyingRef = useRef(false);

  // 予約情報の確認(読み取り専用、GET /staff/reservations/{id})用の状態。
  // 受取確認(QR検証、上のstate)とは完全に独立させ、どちらの操作も互いに
  // 影響しないようにする。
  const [reservationId, setReservationId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState(null);
  const [lookupResult, setLookupResult] = useState(null);
  // 予約確認結果はその時点のスナップショットで、後から受取確認などで状態が
  // 変わっても自動では更新されない。スタッフが古い「受け渡し可能」を
  // 信じ続けないよう、取得した時刻(ブラウザの現在時刻)を併せて表示する。
  const [lookupFetchedAt, setLookupFetchedAt] = useState(null);

  async function verify(token) {
    if (!staffToken.trim() || !token.trim()) {
      setError({ status: null, message: "スタッフトークンとQRトークンを入力してください。" });
      return;
    }
    if (verifyingRef.current) return;
    verifyingRef.current = true;

    setLoading(true);
    setError(null);
    setResult(null);
    setItemTitle(null);

    try {
      const response = await api.verifyQr(token.trim(), staffToken);
      setQrToken("");
      // 商品名の取得失敗は受取完了の表示を妨げない。
      let title = null;
      try {
        const items = await api.getItems();
        const found = (items || []).find((it) => String(it.id) === String(response.item_id));
        title = found?.title || null;
      } catch (itemsError) {
        title = null;
      }
      setItemTitle(title);
      setResult(response);
    } catch (requestError) {
      setError({
        status: requestError.status,
        cancelled: isCancelledConflict(requestError),
        message: resolveErrorMessage(requestError),
      });
    } finally {
      verifyingRef.current = false;
      setLoading(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    verify(qrToken);
  }

  function handleStartScan() {
    setError(null);
    setResult(null);
    setScanning(true);
  }

  // 読み取り成功時: 手入力欄にはセットせず、そのまま受取確認へ進む。
  // 404/409/通信エラーなどでverifyが失敗してもQRトークンを画面に残さない
  // ため。QrScannerは1回読み取った時点でカメラを止めるため、同じQRを
  // 映し続けてもここは1度しか呼ばれない。
  function handleScanDetected(value) {
    setScanning(false);
    verify(value);
  }

  async function handleLookupSubmit(event) {
    event.preventDefault();
    if (!staffToken.trim() || !reservationId.trim()) {
      setLookupError({ message: "スタッフトークンと予約IDを入力してください。" });
      return;
    }

    setLookupLoading(true);
    setLookupError(null);
    setLookupResult(null);
    setLookupFetchedAt(null);

    try {
      const response = await api.getStaffReservation(reservationId.trim(), staffToken);
      setLookupResult(response);
      setLookupFetchedAt(new Date());
    } catch (requestError) {
      setLookupError({
        status: requestError.status,
        message: resolveLookupErrorMessage(requestError),
      });
    } finally {
      setLookupLoading(false);
    }
  }

  const lookupStatusDisplay = lookupResult
    ? RESERVATION_STATUS_DISPLAY[lookupResult.status] || UNKNOWN_RESERVATION_STATUS_DISPLAY
    : null;

  return (
    <main className="min-h-screen bg-[#f7fbf6] px-4 py-8 text-[#16381b]">
      <div className="mx-auto max-w-xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">スタッフ用画面</h1>
          <p className="mt-1 text-sm text-gray-600">
            QRトークンで受取を確認するか、予約IDで予約内容を確認できます
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-4 bg-white p-4 shadow-sm rounded-md">
          <h2 className="text-lg font-semibold">受取確認</h2>
          <label className="block">
            <span className="text-sm font-medium">スタッフトークン</span>
            <input
              type="password"
              value={staffToken}
              onChange={(event) => setStaffToken(event.target.value)}
              required
              autoComplete="off"
              className="mt-1 w-full rounded border border-gray-300 p-2"
            />
          </label>

          <div className="space-y-2">
            {scanning ? (
              <QrScanner onDetected={handleScanDetected} onCancel={() => setScanning(false)} />
            ) : (
              <button
                type="button"
                onClick={handleStartScan}
                disabled={loading || !staffToken.trim()}
                className={`w-full rounded px-4 py-3 font-medium text-white ${
                  loading || !staffToken.trim() ? "bg-gray-400" : "bg-[#2f6f3e]"
                }`}
              >
                QRコードをスキャン
              </button>
            )}
            <p className="text-xs text-gray-500">
              {!staffToken.trim() && !scanning && "スタッフトークンを入力するとスキャンできます。"}
              カメラ読み取りはHTTPSで開いた画面でのみ利用できます。カメラが使えない場合は、下の欄にQRトークンを手入力してください。
            </p>
          </div>

          <label className="block">
            <span className="text-sm font-medium">QRトークン（手入力）</span>
            <input
              type="text"
              value={qrToken}
              onChange={(event) => setQrToken(event.target.value)}
              required
              className="mt-1 w-full rounded border border-gray-300 p-2"
            />
          </label>

          {error && (
            <p
              className={`text-sm ${
                error.status === 409 && !error.cancelled ? "text-blue-700" : "text-red-600"
              }`}
            >
              {error.message}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className={`w-full rounded px-4 py-2 font-medium text-white ${
              loading ? "bg-gray-400" : "bg-[#2f6f3e]"
            }`}
          >
            {loading ? "確認中…" : "受取を確認"}
          </button>
        </form>

        {result && (
          <section className="bg-white p-4 shadow-sm rounded-md" aria-live="polite">
            <h2 className="text-lg font-semibold text-[#2f6f3e]">受取完了</h2>
            <dl className="mt-3 space-y-3">
              <div>
                <dt className="text-sm text-gray-600">氏名</dt>
                <dd className="font-medium">{result.user_name}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">商品</dt>
                <dd className="font-medium">
                  {itemTitle || (
                    <span className="text-sm text-gray-500">
                      商品情報を取得できませんでした（ID: {result.item_id}）
                    </span>
                  )}
                </dd>
              </div>
              {result.requested_at && (
                <div>
                  <dt className="text-sm text-gray-600">希望日時</dt>
                  <dd className="font-medium">{formatJapanDateTime(result.requested_at)}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {/* 予約情報の確認: QR検証(状態を変更する)とは別に、読み取り専用で
            予約の内容・状態を確認できるようにする(GET /staff/reservations/
            {id})。X-Reservation-Tokenは使わず、上のスタッフトークンのみで
            認可する。 */}
        <form
          onSubmit={handleLookupSubmit}
          className="space-y-4 bg-white p-4 shadow-sm rounded-md"
        >
          <h2 className="text-lg font-semibold">予約情報の確認</h2>
          <p className="text-sm text-gray-600">
            予約IDを入力すると、受取前に予約の内容・状態を確認できます（この操作では受取は完了しません）。
          </p>

          <label className="block">
            <span className="text-sm font-medium">予約ID</span>
            <input
              type="text"
              value={reservationId}
              onChange={(event) => setReservationId(event.target.value)}
              required
              className="mt-1 w-full rounded border border-gray-300 p-2"
            />
          </label>

          {lookupError && <p className="text-sm text-red-600">{lookupError.message}</p>}

          <button
            type="submit"
            disabled={lookupLoading}
            className={`w-full rounded px-4 py-2 font-medium text-white ${
              lookupLoading ? "bg-gray-400" : "bg-[#2f6f3e]"
            }`}
          >
            {lookupLoading ? "確認中…" : "予約情報を確認"}
          </button>
        </form>

        {lookupResult && (
          <section className="bg-white p-4 shadow-sm rounded-md" aria-live="polite">
            <div className={`mb-3 rounded p-3 ${lookupStatusDisplay.className}`}>
              <span className="font-semibold">{lookupStatusDisplay.label}</span>
            </div>
            {lookupFetchedAt && (
              <p className="mb-3 text-xs text-gray-500">
                確認日時：{formatFetchedAt(lookupFetchedAt)}
                （この時点の状態です。受け渡し直前に再確認してください）
              </p>
            )}
            <dl className="space-y-3">
              <div>
                <dt className="text-sm text-gray-600">商品</dt>
                <dd className="font-medium">
                  {lookupResult.item_title || (
                    <span className="text-sm text-gray-500">
                      商品情報を取得できませんでした（ID: {lookupResult.item_id}）
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">予約者名</dt>
                <dd className="font-medium">{lookupResult.user_name}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">予約日時</dt>
                <dd className="font-medium">
                  {lookupResult.reserved_at ? formatJapanDateTime(lookupResult.reserved_at) : "―"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">受取希望時間</dt>
                <dd className="font-medium">
                  {lookupResult.requested_at
                    ? formatJapanDateTime(lookupResult.requested_at)
                    : "指定なし"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">支払い方法</dt>
                <dd className="font-medium">
                  {lookupResult.payment_method
                    ? PAYMENT_METHOD_LABELS[lookupResult.payment_method] ||
                      lookupResult.payment_method
                    : "―"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">支払い状態</dt>
                <dd className="font-medium">
                  {lookupResult.payment_status
                    ? PAYMENT_STATUS_LABELS[lookupResult.payment_status] ||
                      lookupResult.payment_status
                    : "―"}
                </dd>
              </div>
            </dl>
          </section>
        )}
      </div>
    </main>
  );
}
