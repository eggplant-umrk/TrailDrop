// Backend(main.py require_valid_uuid / models.py QRVerifyRequest.qr_token)が
// 受け付けるqr_tokenはuuid4の正準形式(ハイフン区切り36文字)。
// QRスキャンでは受取確認へ送る前にこの形式かどうかをここで確認する。
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_REGEX.test(value);
}

// 予約のidempotency key用のUUID v4。crypto.randomUUIDはHTTPS(secure
// context)でしか使えないため、LAN内のhttp等でも動くようgetRandomValuesで
// 同じ形式を組み立てる(getRandomValuesはsecure contextを要求しない)。
export function randomUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
