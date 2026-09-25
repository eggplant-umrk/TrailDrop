import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import { AppLayout, formatYen, primaryButtonClass, secondaryButtonClass } from "../components/ui";
import { toUserMessage } from "../utils/errorMessages";
import { formatPickupHours } from "../utils/pickupHours";

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
        setError(
          toUserMessage(e, {
            fallback: "商品一覧を取得できませんでした。時間をおいて、もう一度お試しください。",
          }),
        );
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <AppLayout>
      <header className="mb-4 pt-2">
        {/* 「受取」だけだと体験(ワークショップ)には合わないため、商品・
            体験の両方を含められる文言にする(一括修正U4)。 */}
        <h1 className="text-xl font-bold">すべての商品・体験</h1>
        <p className="mt-1 text-sm text-gray-600">道の駅 ロック・ガーデンひちそう で受取・参加できます</p>
        <Link to="/" className={`${secondaryButtonClass} mt-3`}>
          移動ルートから受け取れる商品を探す
        </Link>
      </header>

      {loading && <div className="p-3">読み込み中…</div>}
      {error && (
        <div className="p-3 text-red-600">
          <div>一覧の取得に失敗しました: {error}</div>
          <button onClick={load} className="mt-2 min-h-[44px] rounded-lg bg-gray-200 px-4 text-gray-800">
            再試行
          </button>
        </div>
      )}

      {!loading && !error && items.length === 0 && <div className="p-3">現在取り扱いはありません。</div>}

      <ul className="space-y-3">
        {items.map((it) => (
          <li key={it.id} className="rounded-xl bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  {it.name}
                  {it.type === "experience" && (
                    <span className="ml-2 text-xs font-normal text-gray-500">体験</span>
                  )}
                </p>
                <p className="mt-1 text-xs text-gray-600">{it.location}</p>
                {/* 商品自体の営業時間(RouteTest.jsx/StaffVerify.jsxと同じ表示)。
                    未設定(主に体験)の商品では表示しない(一括修正U2)。 */}
                {it.pickupAvailableFrom && it.pickupAvailableTo && (
                  <p className="mt-1 text-xs text-gray-600">
                    営業時間{" "}
                    <span className="whitespace-nowrap">
                      {formatPickupHours(it.pickupAvailableFrom)}〜{formatPickupHours(it.pickupAvailableTo)}
                    </span>
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-lg font-bold">{formatYen(it.price)}</p>
                <p className={`text-xs ${it.stock > 0 ? "text-gray-600" : "font-medium text-red-600"}`}>
                  {it.stock > 0 ? `残り${it.stock}` : "在庫切れ"}
                </p>
              </div>
            </div>
            {it.stock > 0 ? (
              <Link to={`/reserve/${it.id}`} className={`${primaryButtonClass} mt-3`}>
                予約する
              </Link>
            ) : (
              // 在庫0はクリックして409を待たせず、その場で予約不可と
              // 分かるようにする(一括修正m2)。
              <span
                aria-disabled="true"
                className="mt-3 flex min-h-[44px] w-full cursor-not-allowed items-center justify-center rounded-lg bg-gray-200 text-sm font-medium text-gray-500"
              >
                在庫切れ
              </span>
            )}
          </li>
        ))}
      </ul>
    </AppLayout>
  );
}
