import React, { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import api from "../api/client";

function minimumJapanDateTime() {
  const oneMinuteFromNowInJapan = Date.now() + 9 * 60 * 60 * 1000 + 60 * 1000;
  return new Date(oneMinuteFromNowInJapan).toISOString().slice(0, 16);
}

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
  const [error, setError] = useState(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
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

  async function handleReserve(e) {
    e.preventDefault();
    if (!name.trim()) {
      setError("氏名を入力してください。");
      return;
    }
    if (item.requiresDate && !date) {
      setError("希望日時を入力してください。");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const requestedAt = item.requiresDate ? `${date}:00+09:00` : null;
      const res = await api.createReservation({
        item_id: item.id,
        user_name: name.trim(),
        requested_at: requestedAt,
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
      const msg = e.message || "予約に失敗しました";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen p-4 bg-[#f7fbf6] text-[#16381b]">
      <header className="mb-4">
        <h2 className="text-xl font-semibold">{item.name}</h2>
        <div className="text-sm">場所: {item.location}</div>
      </header>

      <form onSubmit={handleReserve} className="space-y-3">
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

        {error && <div className="text-red-600">{error}</div>}

        <div className="flex justify-end">
          <button type="submit" disabled={submitting} className={`px-4 py-2 ${submitting ? 'bg-gray-400' : 'bg-[#2f6f3e]'} text-white rounded`}>
            {submitting ? '予約中…' : '予約確定'}
          </button>
        </div>
      </form>
    </div>
  );
}
