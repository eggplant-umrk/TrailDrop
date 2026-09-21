import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../api/client";

export default function Reservation() {
  const { id } = useParams();
  const navigate = useNavigate();
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
        if (e.message === "NO_API_BASE") {
          const demo = await api.getItems();
          const found = (demo || []).find((it) => String(it.id) === String(id));
          if (found) {
            setItem({
              id: found.id,
              name: found.title,
              price: found.price,
              location: found.location_name,
              requiresDate: found.type === "experience",
              stock: found.stock,
            });
          } else {
            setError("指定された商品が見つかりません。");
          }
        } else {
          setError(e.message || "Failed to load item");
        }
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

    setSubmitting(true);
    setError(null);
    try {
      const res = await api.createReservation({ item_id: item.id, user_name: name.trim() });
      if (res?.access_token) {
        sessionStorage.setItem(`traildrop_access_token_${res.id}`, res.access_token);
      }
      navigate(`/complete/${res.id}`, { replace: true, state: { access_token: res?.access_token || null } });
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
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 p-2 border rounded w-full" />
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
