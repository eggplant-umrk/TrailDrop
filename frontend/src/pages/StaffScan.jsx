import { useRef, useState } from "react";
import api from "../api/client";
import QrScanner from "../components/QrScanner";

const STAFF_TOKEN_SESSION_KEY = "traildrop_staff_token";

function loadStaffToken() {
  try {
    return sessionStorage.getItem(STAFF_TOKEN_SESSION_KEY) || "";
  } catch {
    return "";
  }
}

function saveStaffToken(token) {
  try {
    sessionStorage.setItem(STAFF_TOKEN_SESSION_KEY, token);
  } catch {
    // sessionStorageが使えない環境では、このタブ内のstateだけで継続する。
  }
}

function clearStaffToken() {
  try {
    sessionStorage.removeItem(STAFF_TOKEN_SESSION_KEY);
  } catch {
    // 保存済みでなければ削除できなくても問題ない。
  }
}

function isCancelledConflict(requestError) {
  return requestError?.status === 409 && requestError?.message === "Reservation is cancelled";
}

export function scanErrorMessage(requestError) {
  if (isCancelledConflict(requestError)) {
    return "この予約はキャンセルされています";
  }
  if (requestError?.status === 409) {
    return "このQRコードはすでに使用されています";
  }
  if (requestError?.status === 401) {
    return "スタッフ認証に失敗しました";
  }
  return "受取確認に失敗しました";
}

export default function StaffScan() {
  const storedToken = loadStaffToken();
  const [staffToken, setStaffToken] = useState(storedToken);
  const [tokenInput, setTokenInput] = useState("");
  const [view, setView] = useState(storedToken ? "scanning" : "setup");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const verifyingRef = useRef(false);

  function handleSetup(event) {
    event.preventDefault();
    const token = tokenInput.trim();
    if (!token) return;
    saveStaffToken(token);
    setStaffToken(token);
    setTokenInput("");
    setError("");
    setView("scanning");
  }

  async function handleDetected(qrToken) {
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    setError("");
    setView("verifying");

    try {
      const verified = await api.verifyQr(qrToken, staffToken);
      let reservation = null;
      try {
        // verifyレスポンスの商品IDからGET /itemsを引くと、inactiveになった
        // 過去商品を表示できない。スタッフ用予約照会を使い、予約時の商品を
        // active状態に関係なく取得する。
        reservation = await api.getStaffReservation(verified.id, staffToken);
      } catch {
        // 商品名の追加取得に失敗しても、完了済みの受取結果は取り消さない。
      }
      setResult({
        itemTitle: reservation?.item_title || null,
        userName: reservation?.user_name || verified.user_name,
      });
      setView("completed");
    } catch (requestError) {
      setError(scanErrorMessage(requestError));
      setView("error");
    } finally {
      verifyingRef.current = false;
    }
  }

  function restartScan() {
    setError("");
    setResult(null);
    setView("scanning");
  }

  function resetAuthentication() {
    clearStaffToken();
    setStaffToken("");
    setTokenInput("");
    setError("");
    setResult(null);
    setView("setup");
  }

  return (
    <main className="min-h-screen bg-[#f7fbf6] px-4 py-8 text-[#16381b] sm:py-12">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col">
        <header className="text-center">
          <p className="text-sm font-semibold text-[#2f6f3e]">TrailDrop</p>
          <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">
            {view === "setup" ? "受取端末の準備" : "商品を受け取る"}
          </h1>
        </header>

        {view === "setup" && (
          <form
            onSubmit={handleSetup}
            className="mx-auto mt-10 w-full max-w-md space-y-5 rounded-md border border-[#dce9da] bg-white p-6 shadow-sm"
          >
            <label className="block">
              <span className="text-sm font-medium">スタッフ認証</span>
              <input
                type="password"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                required
                autoComplete="off"
                className="mt-2 min-h-12 w-full rounded border border-gray-300 px-3 py-2"
              />
            </label>
            <button
              type="submit"
              className="min-h-12 w-full rounded bg-[#2f6f3e] px-4 py-3 font-semibold text-white"
            >
              受取端末を開始
            </button>
          </form>
        )}

        {view === "scanning" && (
          <section className="mx-auto mt-8 w-full max-w-xl" aria-label="QRコード読み取り">
            <QrScanner
              onDetected={handleDetected}
              onCancel={() => setView("paused")}
              showManualEntryHint={false}
            />
            <p className="mx-auto mt-6 max-w-sm text-center text-lg font-medium leading-relaxed">
              スマートフォンの
              <span className="block">受取QRコードをかざしてください</span>
            </p>
          </section>
        )}

        {view === "verifying" && (
          <section className="flex flex-1 items-center justify-center" aria-live="polite">
            <p className="text-xl font-semibold">受取を確認しています…</p>
          </section>
        )}

        {view === "paused" && (
          <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <p className="text-lg text-gray-700">カメラを停止しました</p>
            <button
              type="button"
              onClick={restartScan}
              className="min-h-12 rounded bg-[#2f6f3e] px-8 py-3 font-semibold text-white"
            >
              カメラを開始
            </button>
            <button
              type="button"
              onClick={resetAuthentication}
              className="min-h-11 px-4 py-2 text-sm font-medium text-gray-600 underline"
            >
              スタッフ認証をやり直す
            </button>
          </section>
        )}

        {view === "completed" && (
          <section
            className="flex flex-1 flex-col items-center justify-center py-10 text-center"
            aria-live="polite"
          >
            <div
              className="flex h-24 w-24 items-center justify-center rounded-full bg-[#2f6f3e] text-5xl font-semibold text-white"
              aria-hidden="true"
            >
              ✓
            </div>
            <h2 className="mt-6 text-4xl font-semibold text-[#2f6f3e] sm:text-5xl">受取完了</h2>
            <p className="mt-8 text-xl font-semibold sm:text-2xl">
              {result?.itemTitle || "商品情報を取得できませんでした"}
            </p>
            <p className="mt-3 text-lg text-gray-700">{result?.userName} さん</p>
            <p className="mt-8 text-lg">受け取りありがとうございました</p>
          </section>
        )}

        {view === "error" && (
          <section
            className="flex flex-1 flex-col items-center justify-center py-10 text-center"
            aria-live="assertive"
          >
            <h2 className="text-3xl font-semibold text-red-700">受取を確認できませんでした</h2>
            <p className="mt-5 text-xl font-medium">{error}</p>
            <button
              type="button"
              onClick={restartScan}
              className="mt-8 min-h-12 rounded bg-[#2f6f3e] px-8 py-3 font-semibold text-white"
            >
              QRコードを読み直す
            </button>
            <button
              type="button"
              onClick={resetAuthentication}
              className="mt-3 min-h-11 px-4 py-2 text-sm font-medium text-gray-600 underline"
            >
              スタッフ認証をやり直す
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
