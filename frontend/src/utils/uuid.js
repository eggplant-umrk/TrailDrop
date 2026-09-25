// Backend(main.py require_valid_uuid / models.py QRVerifyRequest.qr_token)が
// 受け付けるqr_tokenはuuid4の正準形式(ハイフン区切り36文字)。
// QRスキャンでは受取確認へ送る前にこの形式かどうかをここで確認する。
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_REGEX.test(value);
}
