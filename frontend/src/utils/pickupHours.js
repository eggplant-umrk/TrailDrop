// 受取時間帯(RouteTestで選ぶ2時間の受取枠)まわりの純粋関数。
//
// 受取場所は無人ロッカーのため、受取は24時間いつでも可能。商品ごとの
// 「営業時間(pickup_available_from/to)」という考え方は廃止し、判定には使わない。
// 受取枠が使えるかどうかは、次の2つだけで決まる。
//   1. 受取枠の終了 >= 受取地点への到着予定(pass_at)
//      (到着前に終わってしまう枠では受け取れない)
//   2. 受取枠の終了 > 現在時刻
//      (Backend models.py ReservationCreateと同じ基準 end <= now なら終了)

const MINUTE_MS = 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * MINUTE_MS;

// 受取枠は到着予定を中心にした2時間。30分単位で最大3時間後までずらせる。
// 前へは、枠の終了が到着予定と同じになる所(= -枠の半分)までしかずらせない。
export const WINDOW_DURATION_MINUTES = 120;
export const WINDOW_HALF_DURATION_MINUTES = WINDOW_DURATION_MINUTES / 2;
export const WINDOW_OFFSET_STEP_MINUTES = 30;
export const WINDOW_OFFSET_MAX_MINUTES = 180;
export const WINDOW_OFFSET_MIN_MINUTES = -WINDOW_HALF_DURATION_MINUTES;

export function clampWindowOffset(offsetMinutes) {
  const value = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  return Math.max(WINDOW_OFFSET_MIN_MINUTES, Math.min(WINDOW_OFFSET_MAX_MINUTES, value));
}

// 到着予定(passAtMs)を中心に、offsetMinutesだけずらした受取枠。
export function pickupWindowAt(passAtMs, offsetMinutes) {
  return {
    startMs: passAtMs + (offsetMinutes - WINDOW_HALF_DURATION_MINUTES) * MINUTE_MS,
    endMs: passAtMs + (offsetMinutes + WINDOW_HALF_DURATION_MINUTES) * MINUTE_MS,
  };
}

// 受取枠が「到着後に受け取れて、まだ終了していない」か。
export function isPickupWindowUsable({ passAtMs, offsetMinutes, nowMs = Date.now() }) {
  if (!Number.isFinite(passAtMs)) return false;
  const { endMs } = pickupWindowAt(passAtMs, offsetMinutes);
  return endMs >= passAtMs && endMs > nowMs;
}

// 受取時間のスライダーの範囲内で、この商品を受け取れるようになる最小の
// ずらし幅(分)。在庫切れの商品は時間を変えても受け取れないためnull。
// 範囲内に使える受取枠が無ければnull。
export function findWindowOffsetForItem(
  item,
  passAtMs,
  { stepMinutes = WINDOW_OFFSET_STEP_MINUTES, maxMinutes = WINDOW_OFFSET_MAX_MINUTES, nowMs = Date.now() } = {},
) {
  if (!(item?.stock > 0) || !Number.isFinite(passAtMs)) return null;
  const offsets = [0];
  for (let offset = stepMinutes; offset <= maxMinutes; offset += stepMinutes) {
    offsets.push(offset, -offset);
  }
  for (const offset of offsets) {
    if (offset < WINDOW_OFFSET_MIN_MINUTES) continue;
    if (isPickupWindowUsable({ passAtMs, offsetMinutes: offset, nowMs })) return offset;
  }
  return null;
}

// 受取地点の商品を、今の受取枠で「予約できる/在庫切れ/時間を変えれば
// 受け取れる」に分ける。受取は24時間可能なので、時間で弾かれるのは
// 受取枠そのものが使えない(到着前に終わる・終了済み)場合だけ。
export function classifyItemsForWindow({ items, passAtMs, offsetMinutes, nowMs = Date.now() }) {
  const list = Array.isArray(items) ? items : [];
  const windowUsable = isPickupWindowUsable({ passAtMs, offsetMinutes, nowMs });
  const inStock = list.filter((item) => item.stock > 0);
  const soldOut = list.filter((item) => !(item.stock > 0));
  return {
    windowUsable,
    // 一覧に出す商品(使える枠なら全商品、使えない枠なら在庫切れの商品だけ)。
    listedItems: windowUsable ? list : soldOut,
    bookableItems: windowUsable ? inStock : [],
    // 時間を変えれば受け取れる商品(在庫がある商品だけ)。
    laterItems: windowUsable ? [] : inStock,
    laterOffset: windowUsable
      ? null
      : (inStock.length > 0
          ? findWindowOffsetForItem(inStock[0], passAtMs, { nowMs })
          : null),
  };
}

// datetime-localの値("YYYY-MM-DDTHH:MM"、JST壁時計時刻)への変換。
export function toJstDateTimeInputValue(ms) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16);
}

// 「今すぐ」出発の値。Backendはdeparture_atが未来であることを要求するため、
// 送信までの時間を見込んで少し先(分単位に切り上げ)にする。
export function nowDepartureInputValue(nowMs = Date.now(), leadMinutes = 2) {
  const ms = Math.ceil((nowMs + leadMinutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
  return toJstDateTimeInputValue(ms);
}

// 指定した出発日時(datetime-localの値)が、検索する時点の現在時刻より後か。
// Backend(models.py RouteAnalysisRequest)はdeparture_atが未来であることを
// 要求するため、送信までの時間を見込んで1分の余裕を取る。
export function isDepartureInputInFuture(value, nowMs = Date.now(), leadMinutes = 1) {
  if (typeof value !== "string" || !value) return false;
  const ms = new Date(`${value}:00+09:00`).getTime();
  if (Number.isNaN(ms)) return false;
  return ms >= nowMs + leadMinutes * MINUTE_MS;
}
