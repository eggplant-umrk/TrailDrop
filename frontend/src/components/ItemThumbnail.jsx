import { useState } from "react";
import { getItemImage } from "../utils/itemImages";

// 商品カード用の正方形サムネイル。画像が未登録・読み込み失敗の場合は、
// 壊れた画像を出さずに同じ大きさの控えめなplaceholderを表示する。
export default function ItemThumbnail({ itemId, title, size = "small" }) {
  const src = getItemImage(itemId);
  const [failedSrc, setFailedSrc] = useState(null);
  const showImage = src && failedSrc !== src;
  const sizeClass =
    size === "xlarge" ? "h-32 w-32" : size === "large" ? "h-28 w-28" : "h-16 w-16";
  const iconClass =
    size === "xlarge" ? "h-11 w-11" : size === "large" ? "h-10 w-10" : "h-7 w-7";
  const pixelSize = size === "xlarge" ? 128 : size === "large" ? 112 : 64;

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#eef6ec] ${sizeClass}`}
    >
      {showImage ? (
        <img
          src={src}
          alt={title}
          width={pixelSize}
          height={pixelSize}
          loading="lazy"
          onError={() => setFailedSrc(src)}
          className="h-full w-full object-cover"
        />
      ) : (
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={`${iconClass} text-[#2f6f3e] opacity-40`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 8h14l-1.2 11.2a1 1 0 0 1-1 .8H7.2a1 1 0 0 1-1-.8L5 8Z" />
          <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
        </svg>
      )}
    </div>
  );
}
