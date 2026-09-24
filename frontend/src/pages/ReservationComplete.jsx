import React, { useEffect, useRef, useState } from "react";
import { useLocation, useParams, useNavigate } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import api from "../api/client";

function formatRequestedAt(value) {
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

function buildGoogleMapsUrl({ destination, passPoint }) {
  const params = new URLSearchParams({
    api: "1",
    destination,
    waypoints: passPoint,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

// Backend/DBのstatusは'pending'と'completed'のみ(schema.sqlのcheck制約)。
// それ以外の値は受取済みとも受付済みとも扱わず、状態不明として表示する。
const STATUS_DISPLAY = {
  pending: {
    heading: "予約受付済み",
    description: "受取時にこの画面のQRコードを現地スタッフに提示してください。",
    className: "bg-[#eef6ec] text-[#2f6f3e]",
  },
  completed: {
    heading: "受取済み",
    description: "この予約はスタッフによる受取確認が完了しています。",
    className: "bg-blue-50 text-blue-800",
  },
};

const UNKNOWN_STATUS_DISPLAY = {
  heading: "予約状態を確認できません",
  description: "お手数ですが現地スタッフにお問い合わせください。",
  className: "bg-gray-100 text-gray-700",
};

export default function ReservationComplete() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [reservation, setReservation] = useState(null);
  // 初回読み込みの失敗は画面全体のエラー表示にする(既存挙動を維持)。
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState(null);
  // 「最新の状態に更新」ボタンによる再取得は、初回読み込みとは失敗時の扱いを
  // 分ける。失敗しても表示中の予約情報・QRはそのまま残し、ボタン付近にだけ
  // エラーを表示する。
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);

  // 商品名は予約情報の表示とは独立して取得する。取得中・失敗のいずれでも
  // 予約情報・status・QRの表示は妨げない。取得できない場合は推測で補わず
  // 「取得できませんでした」と表示する。
  const [itemTitle, setItemTitle] = useState(null);
  const [itemTitleError, setItemTitleError] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function fetchReservation({ isInitial }) {
    if (isInitial) {
      setInitialLoading(true);
      setInitialError(null);
    } else {
      setRefreshing(true);
      setRefreshError(null);
    }

    try {
      const tokenFromState = location.state?.access_token || null;
      const tokenFromSession = sessionStorage.getItem(`traildrop_access_token_${id}`);
      const accessToken = tokenFromState || tokenFromSession;

      if (!accessToken && import.meta.env.VITE_API_BASE_URL) {
        throw new Error("予約トークンが見つかりません");
      }

      const res = await api.getReservation(id, accessToken);
      if (!mountedRef.current) return;
      setReservation(res);
    } catch (e) {
      if (!mountedRef.current) return;
      const message = e.message || "予約情報の取得に失敗しました";
      if (isInitial) {
        setInitialError(message);
      } else {
        setRefreshError(message);
      }
    } finally {
      if (!mountedRef.current) return;
      if (isInitial) setInitialLoading(false);
      else setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchReservation({ isInitial: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 予約のitem_idが分かった時点で商品名を取得する。予約の再取得(初回・更新)
  // とは別のライフサイクルで動くため、商品名取得の成否が予約表示の
  // loading/エラー状態に影響しない。
  useEffect(() => {
    if (!reservation?.item_id) return;
    let mounted = true;
    setItemTitle(null);
    setItemTitleError(false);

    async function loadItemTitle() {
      try {
        const items = await api.getItems();
        const found = (items || []).find((it) => String(it.id) === String(reservation.item_id));
        if (mounted) {
          setItemTitle(found?.title || null);
          setItemTitleError(!found?.title);
        }
      } catch (e) {
        if (mounted) {
          setItemTitle(null);
          setItemTitleError(true);
        }
      }
    }

    loadItemTitle();
    return () => {
      mounted = false;
    };
  }, [reservation?.item_id]);

  // RouteTest経由で予約した場合のみ、Google Maps引き継ぎに使う経路情報を持つ。
  // ItemListから直接予約した場合や、stateを保持しないリロード直後は
  // location.stateが空になるため、access_tokenと同じくsessionStorageへ
  // フォールバックする。いずれにもなければroute情報はnullのままとし、
  // 目的地を推測で補うことはしない。
  let routeContext =
    location.state?.origin && location.state?.destination && location.state?.passPoint
      ? {
          origin: location.state.origin,
          destination: location.state.destination,
          passPoint: location.state.passPoint,
        }
      : null;

  if (!routeContext) {
    try {
      const raw = sessionStorage.getItem(`traildrop_route_${id}`);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed?.origin && parsed?.destination && parsed?.passPoint) {
        routeContext = parsed;
      }
    } catch (e) {
      // 壊れたsessionStorageの内容はroute情報なしとして扱う。
    }
  }

  if (initialLoading) return <div className="p-4">読み込み中…</div>;
  if (initialError)
    return (
      <div className="p-4">
        <div className="text-red-600 mb-3">{initialError}</div>
        <div className="flex space-x-2">
          <button onClick={() => navigate('/')} className="px-3 py-1 bg-[#2f6f3e] text-white rounded">一覧へ戻る</button>
          <button onClick={() => navigate(-1)} className="px-3 py-1 bg-gray-200 rounded">前のページへ戻る</button>
        </div>
      </div>
    );
  if (!reservation) return <div className="p-4">予約情報が見つかりません。</div>;

  const statusDisplay = STATUS_DISPLAY[reservation.status] || UNKNOWN_STATUS_DISPLAY;
  const isPending = reservation.status === "pending";

  return (
    <div className="min-h-screen p-4 bg-[#fffef6] text-[#16381b] flex flex-col items-center">
      <div className="w-full max-w-sm bg-white p-4 rounded-md shadow">
        <div className={`mb-4 rounded p-3 ${statusDisplay.className}`} aria-live="polite">
          <h2 className="text-lg font-semibold">{statusDisplay.heading}</h2>
          <p className="mt-1 text-sm">{statusDisplay.description}</p>
        </div>
        <div className="mb-3">予約番号: <span className="font-mono">{reservation.id}</span></div>
        <div className="mb-3">氏名: {reservation.user_name}</div>
        <div className="mb-3">
          商品:{" "}
          {itemTitle ? (
            itemTitle
          ) : (
            <span className="text-sm text-gray-500">
              {itemTitleError ? "商品情報を取得できませんでした" : "読み込み中…"}
            </span>
          )}
        </div>
        {reservation.requested_at && (
          <div className="mb-3">希望日時: {formatRequestedAt(reservation.requested_at)}</div>
        )}
        {/* QRは受取前(pending)のみ表示する。受取済み・状態不明の予約でQRを
            提示させないため。案内文は上のstatus表示(description)に一本化し、
            ここでは重複させない。 */}
        {isPending && (
          <>
            <div className="flex justify-center my-3">
              {reservation.qr_token ? (
                <QRCodeCanvas value={String(reservation.qr_token)} size={180} />
              ) : (
                <div className="text-sm text-gray-500">(QR生成用のトークンがありません)</div>
              )}
            </div>
            {reservation.qr_token && (
              <div className="mb-3 text-center">
                <div className="text-xs text-gray-500">QRが読み取れない場合：</div>
                <div className="font-mono text-sm break-all">{reservation.qr_token}</div>
              </div>
            )}
          </>
        )}

        <button
          type="button"
          onClick={() => fetchReservation({ isInitial: false })}
          disabled={refreshing}
          aria-busy={refreshing}
          className={`mt-4 w-full rounded px-4 py-2 text-sm ${
            refreshing ? "bg-gray-100 text-gray-400" : "bg-gray-200"
          }`}
        >
          {refreshing ? "更新中…" : "最新の状態に更新"}
        </button>
        {refreshError && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {refreshError}（表示中の予約情報は変更していません）
          </p>
        )}

        {routeContext && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() =>
                window.open(buildGoogleMapsUrl(routeContext), "_blank", "noopener,noreferrer")
              }
              className="w-full rounded px-4 py-2 font-medium text-white bg-[#2f6f3e]"
            >
              Google Mapsでルートを開く
            </button>
            <p className="mt-1 text-xs text-gray-500">
              現在地から、受取地点を経由して目的地へのルートを開きます
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
