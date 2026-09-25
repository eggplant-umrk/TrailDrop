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
    pickupAvailableFrom: serverItem.pickup_available_from,
    pickupAvailableTo: serverItem.pickup_available_to,
  };
}

// "HH:MM:SS" / "HH:MM" から表示用の"HH:MM"を取り出す(RouteTest.jsxの
// formatPickupHoursと同じ抽出方法)。
function formatPickupHours(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
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
        {/* 「受取」だけだと体験(ワークショップ)には合わないため、商品・
            体験の両方を含められる文言にする(一括修正U4)。 */}
        <h1 className="text-2xl font-semibold">TrailDrop — 近くで予約する</h1>
        <p className="text-sm text-gray-600">道の駅 ロック・ガーデンひちそう で受取・参加できます</p>
        <Link to="/route-test" className="mt-2 inline-block text-sm text-[#2f6f3e] underline">
          移動ルート上で受け取れる商品を調べる
        </Link>
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
              {/* 商品自体の営業時間(RouteTest.jsx/StaffVerify.jsxと同じ表示)。
                  未設定(主に体験)の商品では表示しない(一括修正U2)。 */}
              {it.pickupAvailableFrom && it.pickupAvailableTo && (
                <div className="text-xs text-gray-500 mt-1">
                  受取可能時間: {formatPickupHours(it.pickupAvailableFrom)}
                  〜{formatPickupHours(it.pickupAvailableTo)}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold">¥{it.price}</div>
              {it.stock > 0 ? (
                <>
                  <div className="text-sm">残り {it.stock}</div>
                  <Link
                    to={`/reserve/${it.id}`}
                    className="inline-block mt-2 px-3 py-1 bg-[#e07b39] text-white rounded-md"
                  >
                    予約
                  </Link>
                </>
              ) : (
                <>
                  {/* 在庫0はクリックして409を待たせず、その場で予約不可と
                      分かるようにする(一括修正m2)。 */}
                  <div className="text-sm text-red-600 font-medium">在庫切れ</div>
                  <span
                    aria-disabled="true"
                    className="inline-block mt-2 px-3 py-1 bg-gray-300 text-gray-500 rounded-md cursor-not-allowed"
                  >
                    予約
                  </span>
                </>
              )}
            </div>
          </article>
        ))}
      </main>
    </div>
  );
}
