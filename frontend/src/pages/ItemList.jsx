import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";

function mapItem(serverItem) {
  return {
    id: serverItem.id,
    type: serverItem.type,
    name: serverItem.title,
    price: serverItem.price,
    stock: serverItem.stock,
    location: serverItem.location_name,
  };
}

export default function ItemList() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getItems();
      const mapped = Array.isArray(data) ? data.map(mapItem) : [];
      setItems(mapped);
    } catch (e) {
      if (e.message === "NO_API_BASE") {
        // demo fallback: keep items empty or use built-in demo from client
        const demo = await api.getItems();
        const mapped = Array.isArray(demo) ? demo.map(mapItem) : [];
        setItems(mapped);
      } else {
        setError(e.message || "Failed to load items");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="min-h-screen bg-[#f7fbf6] text-[#16381b] p-4">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">TrailDrop — 近くで受け取る予約</h1>
        <p className="text-sm text-gray-600">道の駅 ロック・ガーデンひちそう で受取</p>
      </header>

      {loading && <div className="p-3">読み込み中…</div>}
      {error && (
        <div className="p-3 text-red-600">
          <div>一覧の取得に失敗しました: {error}</div>
          <button onClick={load} className="mt-2 px-3 py-1 bg-gray-200 rounded">再試行</button>
        </div>
      )}

      {!loading && !error && items.length === 0 && <div className="p-3">現在取り扱いはありません。</div>}

      <main className="space-y-3">
        {items.map((it) => (
          <article key={it.id} className="bg-white p-3 rounded-md shadow-sm flex justify-between items-center">
            <div>
              <div className="text-lg font-medium">{it.name}</div>
              <div className="text-sm text-gray-600">{it.type === 'experience' ? '体験' : ''}</div>
              <div className="text-sm mt-1">場所: {it.location}</div>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold">¥{it.price}</div>
              <div className="text-sm">残り {it.stock}</div>
              <Link to={`/reserve/${it.id}`} className="inline-block mt-2 px-3 py-1 bg-[#e07b39] text-white rounded-md">予約</Link>
            </div>
          </article>
        ))}
      </main>
    </div>
  );
}
