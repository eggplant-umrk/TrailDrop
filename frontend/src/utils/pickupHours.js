// 商品の受取可能時間(pickup_available_from/to)まわりの純粋関数。
// 判定ロジック自体はRouteTest.jsxにあったものをそのまま移したもの。

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const JST_OFFSET_MS = 9 * 60 * MINUTE_MS;

// dateが指すJST上の「その日の0時からの経過分」。深夜またぎ(前日/翌日をまたぐ受取枠)
// は今回のスコープ外のため、日付をまたいだ比較は正しく扱わない前提でよい。
export function jstMinutesSinceMidnight(date) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

// "HH:MM:SS" / "HH:MM" (Supabaseのtime型がJSONで返す形式) を0時からの経過分へ。
export function parseTimeStringToMinutes(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// "HH:MM:SS" / "HH:MM" から表示用の"HH:MM"を取り出す。time型には日付・
// timezoneの概念が無いため、Dateへの変換は行わず文字列のまま扱う。
export function formatPickupHours(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

// 商品の受取可能時間に、実効受取予定時刻(pass_at + windowOffsetMinutes)が
// 収まっているかどうか。受取可能時間が未設定(null)の商品は対象外。境界
// (ちょうど開店・閉店時刻)は利用可として扱う。
export function isItemAvailableAt(item, effectiveMinutes) {
  const itemStart = parseTimeStringToMinutes(item.pickup_available_from);
  const itemEnd = parseTimeStringToMinutes(item.pickup_available_to);
  if (itemStart === null || itemEnd === null) {
    return false;
  }
  return itemStart <= effectiveMinutes && effectiveMinutes <= itemEnd;
}

export function hasPickupHours(item) {
  return (
    parseTimeStringToMinutes(item?.pickup_available_from) !== null &&
    parseTimeStringToMinutes(item?.pickup_available_to) !== null
  );
}

// 受取時間のスライダー(±maxMinutes、stepMinutes刻み)の範囲内で、この商品を
// 受け取れるようになる最小のずらし幅(分)。範囲内に無ければnull。
// 判定はisItemAvailableAtと同じ一点判定を使う。
export function findWindowOffsetForItem(item, passAtMs, { stepMinutes, maxMinutes }) {
  if (!hasPickupHours(item) || !Number.isFinite(passAtMs)) return null;
  const offsets = [0];
  for (let offset = stepMinutes; offset <= maxMinutes; offset += stepMinutes) {
    offsets.push(offset, -offset);
  }
  for (const offset of offsets) {
    const minutes = jstMinutesSinceMidnight(new Date(passAtMs + offset * MINUTE_MS));
    if (isItemAvailableAt(item, minutes)) return offset;
  }
  return null;
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

// スライダーでは届かない商品向けに、「出発をこの時刻にすれば受取可能時間内に
// 着く」目安の出発日時(datetime-localの値)を返す。所要時間(pass_at -
// departure)は変わらない前提の目安で、実際の判定は再検索の結果で行う。
// 受取可能時間の開始から最大60分後(短い営業時間なら中央)を狙う。
export function suggestDepartureForItem(item, { passAtMs, departureMs, nowMs = Date.now() }) {
  if (!hasPickupHours(item) || !Number.isFinite(passAtMs) || !Number.isFinite(departureMs)) {
    return null;
  }
  const start = parseTimeStringToMinutes(item.pickup_available_from);
  const end = parseTimeStringToMinutes(item.pickup_available_to);
  if (end < start) return null;
  const targetMinutes = start + Math.min(60, Math.floor((end - start) / 2));

  const jstMidnightMs =
    Math.floor((passAtMs + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
  let targetMs = jstMidnightMs + targetMinutes * MINUTE_MS;
  if (targetMs <= passAtMs) targetMs += DAY_MS;

  const tenMinutes = 10 * MINUTE_MS;
  let suggestedMs = Math.round((departureMs + (targetMs - passAtMs)) / tenMinutes) * tenMinutes;
  const earliestMs = nowMs + 5 * MINUTE_MS;
  if (suggestedMs < earliestMs) suggestedMs = Math.ceil(earliestMs / tenMinutes) * tenMinutes;
  return toJstDateTimeInputValue(suggestedMs);
}
