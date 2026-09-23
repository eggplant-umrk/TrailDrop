import React, { useEffect, useState } from "react";
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

export default function ReservationComplete() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [reservation, setReservation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const tokenFromState = location.state?.access_token || null;
        const tokenFromSession = sessionStorage.getItem(`traildrop_access_token_${id}`);
        const accessToken = tokenFromState || tokenFromSession;

        if (!accessToken && import.meta.env.VITE_API_BASE_URL) {
          throw new Error("予約トークンが見つかりません");
        }

        const res = await api.getReservation(id, accessToken);
        if (mounted) setReservation(res);
      } catch (e) {
        if (mounted) setError(e.message || "予約情報の取得に失敗しました");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => (mounted = false);
  }, [id, location.state]);

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

  if (loading) return <div className="p-4">読み込み中…</div>;
  if (error)
    return (
      <div className="p-4">
        <div className="text-red-600 mb-3">{error}</div>
        <div className="flex space-x-2">
          <button onClick={() => navigate('/')} className="px-3 py-1 bg-[#2f6f3e] text-white rounded">一覧へ戻る</button>
          <button onClick={() => navigate(-1)} className="px-3 py-1 bg-gray-200 rounded">前のページへ戻る</button>
        </div>
      </div>
    );
  if (!reservation) return <div className="p-4">予約情報が見つかりません。</div>;

  return (
    <div className="min-h-screen p-4 bg-[#fffef6] text-[#16381b] flex flex-col items-center">
      <div className="w-full max-w-sm bg-white p-4 rounded-md shadow">
        <h2 className="text-lg font-semibold mb-2">予約完了</h2>
        <div className="mb-3">予約番号: <span className="font-mono">{reservation.id}</span></div>
        <div className="mb-3">氏名: {reservation.user_name}</div>
        <div className="mb-3">商品: {reservation.item_id}</div>
        {reservation.requested_at && (
          <div className="mb-3">希望日時: {formatRequestedAt(reservation.requested_at)}</div>
        )}
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
        <div className="text-xs text-gray-500">この画面を現地スタッフに提示してください。</div>

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
