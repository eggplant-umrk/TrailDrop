import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import {
  AppLayout,
  formatYen,
  primaryButtonClass,
  secondaryButtonClass,
  StockLabel,
} from "../components/ui";
import ItemThumbnail from "../components/ItemThumbnail";
import { toUserMessage } from "../utils/errorMessages";
import { formatPickupHours } from "../utils/pickupHours";
import { getShopName } from "../utils/shopNames";

export function mapItem(serverItem) {
  return {
    id: serverItem.id,
    type: serverItem.type,
    title: serverItem.title,
    price: serverItem.price,
    stock: serverItem.stock,
    location_name: serverItem.location_name,
    pickup_available_from: serverItem.pickup_available_from,
    pickup_available_to: serverItem.pickup_available_to,
    shop_id: serverItem.shop_id,
    description: serverItem.description,
    category: serverItem.category,
    content_amount: serverItem.content_amount,
    price_note: serverItem.price_note,
  };
}

export default function ItemList() {
  const [items, setItems] = useState([]);
  // 初回レンダーで空状態(「現在取り扱いはありません。」)が一瞬出ないよう、
  // 取得開始前からloading扱いにする。
  const [loading, setLoading] = useState(true);
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
        {items.map((it) => {
          const shopName = getShopName(it.shop_id);
          return (
            <li key={it.id} className="overflow-hidden rounded-xl bg-white p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <ItemThumbnail itemId={it.id} title={it.title} size="large" />
                <div className="min-w-0 flex-1">
                  {it.category && (
                    <span className="inline-flex rounded bg-[#eef6ec] px-2 py-0.5 text-xs font-medium text-[#2f6f3e]">
                      {it.category}
                    </span>
                  )}
                  <h2 className="mt-1 break-words text-base font-bold leading-snug">
                    {it.title}
                  </h2>
                  <p className="mt-1 break-words text-xs text-gray-600">
                    提供：{shopName || "提供元情報なし"}
                  </p>
                  {it.content_amount && (
                    <p className="mt-1 text-xs text-gray-500">内容量：{it.content_amount}</p>
                  )}
                </div>
              </div>

              {it.description && (
                <p className="mt-3 line-clamp-3 break-words text-sm leading-relaxed text-gray-700">
                  {it.description}
                </p>
              )}

              <div className="mt-3 flex items-end justify-between gap-3 border-t border-gray-100 pt-3">
                <div>
                  <p className="text-xl font-bold text-[#16381b]">{formatYen(it.price)}</p>
                  {it.price_note && <p className="mt-0.5 text-[11px] text-gray-500">※デモ用設定価格</p>}
                </div>
                <StockLabel stock={it.stock} />
              </div>

              <div className="mt-3 space-y-1 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
                <p className="break-words">受取場所：{it.location_name}</p>
                {/* 商品自体の営業時間(RouteTest.jsx/StaffVerify.jsxと同じ表示)。
                    未設定の商品では表示しない。 */}
                {it.pickup_available_from && it.pickup_available_to && (
                  <p>
                    受取可能時間：{" "}
                    <span className="whitespace-nowrap">
                      {formatPickupHours(it.pickup_available_from)}〜
                      {formatPickupHours(it.pickup_available_to)}
                    </span>
                  </p>
                )}
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
          );
        })}
      </ul>
    </AppLayout>
  );
}
