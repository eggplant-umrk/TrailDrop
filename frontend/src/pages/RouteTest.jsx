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
  }).format(new Date(value));
}

export default function RouteTest() {
  const [origin, setOrigin] = useState("名古屋駅");
  const [destination, setDestination] = useState("下呂温泉");
  const [departureAt, setDepartureAt] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await api.analyzeRoute({
        origin: origin.trim(),
        destination: destination.trim(),
        departure_at: `${departureAt}:00+09:00`,
      });
      setResult(data);
    } catch (requestError) {
      setError(requestError.message || "ルート分析に失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f7fbf6] px-4 py-8 text-[#16381b]">
      <div className="mx-auto max-w-xl">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold">ルート分析</h1>
          <p className="mt-1 text-sm text-gray-600">七宗の通過予定時刻を確認</p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-4 bg-white p-4 shadow-sm rounded-md">
          <label className="block">
            <span className="text-sm font-medium">出発地</span>
            <input
              type="text"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              required
              className="mt-1 w-full rounded border border-gray-300 p-2"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium">目的地</span>
            <input
              type="text"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              required
              className="mt-1 w-full rounded border border-gray-300 p-2"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium">出発日時</span>
            <input
              type="datetime-local"
              value={departureAt}
              onChange={(event) => setDepartureAt(event.target.value)}
              required
              className="mt-1 w-full rounded border border-gray-300 p-2"
            />
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className={`w-full rounded px-4 py-2 font-medium text-white ${
              loading ? "bg-gray-400" : "bg-[#2f6f3e]"
            }`}
          >
            {loading ? "分析中…" : "ルート分析"}
          </button>
        </form>

        {result && (
          <section className="mt-5 bg-white p-4 shadow-sm rounded-md" aria-live="polite">
            <h2 className="text-lg font-semibold">分析結果</h2>
            <dl className="mt-3 space-y-3">
              <div>
                <dt className="text-sm text-gray-600">七宗通過予定時刻</dt>
                <dd className="font-medium">{formatJapanDateTime(result.pass_at)}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">通過地点</dt>
                <dd className="font-medium">{result.pass_point}</dd>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-sm text-gray-600">総移動時間</dt>
                  <dd className="font-medium">{result.total_duration_minutes}分</dd>
                </div>
                <div>
                  <dt className="text-sm text-gray-600">総距離</dt>
                  <dd className="font-medium">
                    {(result.total_distance_meters / 1000).toFixed(1)}km
                  </dd>
                </div>
              </div>
            </dl>
          </section>
        )}
      </div>
    </main>
  );
}
