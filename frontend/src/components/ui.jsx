import { Link } from "react-router-dom";

// 画面共通の最小限のUI部品。390×844のスマホ表示を基準にする。

// 主要CTA用のclass。<button>・<Link>・<a>のどれにも付けられるよう
// 文字列として公開する(タップ領域は44px以上)。
export const primaryButtonClass =
  "flex min-h-[48px] w-full items-center justify-center rounded-lg bg-[#2f6f3e] px-4 py-3 text-base font-semibold text-white shadow-sm active:bg-[#255a32] disabled:bg-gray-400 disabled:shadow-none";

export const secondaryButtonClass =
  "flex min-h-[44px] w-full items-center justify-center rounded-lg border border-[#2f6f3e] bg-white px-4 py-2 text-sm font-medium text-[#2f6f3e] disabled:opacity-50";

export function formatYen(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `¥${number.toLocaleString("ja-JP")}` : `¥${value}`;
}

export function PrimaryButton({ className = "", ...props }) {
  return <button className={`${primaryButtonClass} ${className}`} {...props} />;
}

const STEPS = ["ルート", "商品", "予約", "受取QR"];

// 現在地(1始まり)を示す簡易ステップ表示。
export function StepIndicator({ current }) {
  return (
    <ol className="flex items-center gap-1 text-[11px]" aria-label="手順">
      {STEPS.map((label, index) => {
        const step = index + 1;
        const state = step < current ? "done" : step === current ? "current" : "todo";
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            className={`flex flex-1 flex-col items-center gap-1 ${
              state === "todo" ? "text-gray-400" : "text-[#2f6f3e]"
            }`}
          >
            <span
              className={`h-1 w-full rounded-full ${state === "todo" ? "bg-gray-200" : "bg-[#2f6f3e]"}`}
            />
            <span className={state === "current" ? "font-semibold" : ""}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ヘッダー(ブランド名)と本文の共通レイアウト。bottomBarを渡すと画面下に
// 固定表示し、本文がCTAに隠れないよう下余白を確保する。
export function AppLayout({ step, children, bottomBar }) {
  return (
    <div className="min-h-screen bg-[#f7fbf6] text-[#16381b]">
      <header className="sticky top-0 z-10 border-b border-[#dfe9dc] bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-md items-center justify-between px-4">
          <Link
            to="/"
            className="flex min-h-[44px] items-center text-lg font-bold tracking-tight text-[#2f6f3e]"
          >
            TrailDrop
          </Link>
          {step && (
            <div className="w-48">
              <StepIndicator current={step} />
            </div>
          )}
        </div>
      </header>
      <main className={`mx-auto max-w-md px-4 py-4 ${bottomBar ? "pb-32" : "pb-8"}`}>{children}</main>
      {bottomBar && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-[#dfe9dc] bg-white px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-md">{bottomBar}</div>
        </div>
      )}
    </div>
  );
}
