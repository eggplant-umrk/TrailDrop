import { useState } from "react";
import api from "../api/client";

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

export default function StaffVerify() {
  const [staffToken, setStaffToken] = useState("");
  const [qrToken, setQrToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  // 受取完了した予約の商品名。GET /itemsの正式な商品データからitem_idで引き、
  // 取得できない場合は推測せず取得失敗として表示する。
  const [itemTitle, setItemTitle] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!staffToken.trim() || !qrToken.trim()) {
      setError({ status: null, message: "スタッフトークンとQRトークンを入力してください。" });
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setItemTitle(null);

    try {
      const response = await api.verifyQr(qrToken.trim(), staffToken);
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
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f7fbf6] px-4 py-8 text-[#16381b]">
      <div className="mx-auto max-w-xl">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold">受取確認（スタッフ用）</h1>
          <p className="mt-1 text-sm text-gray-600">
            予約者のQRトークンを入力して受取を確認します
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-4 bg-white p-4 shadow-sm rounded-md">
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

          <label className="block">
            <span className="text-sm font-medium">QRトークン</span>
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
          <section className="mt-5 bg-white p-4 shadow-sm rounded-md" aria-live="polite">
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
      </div>
    </main>
  );
}
