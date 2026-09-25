// API呼び出しの失敗を、利用者に見せる日本語メッセージへ変換する。
// Backend(FastAPI)のdetailは英語の内部向け文言のため、そのまま画面に出さない。
// 変換の優先順位:
//   1. client.jsが付けたuserMessage(タイムアウト・422の入力エラーなど、
//      Frontend側で既に日本語化済みの文言)
//   2. 呼び出し側が渡したbyDetail(Backend/DEMO_MODEのdetail英文ごとの文言)
//   3. 呼び出し側が渡したbyStatus → 共通のstatus別文言
//   4. statusが無い(通信自体の失敗など)場合は通信エラーの文言
//   5. どれにも当たらなければfallback
// API仕様(status・detail)自体は変更しない。

export const NETWORK_ERROR_MESSAGE =
  "通信に失敗しました。通信環境を確認してから、もう一度お試しください。";
export const SERVER_ERROR_MESSAGE =
  "サーバーで問題が発生しました。時間をおいて、もう一度お試しください。";
export const RATE_LIMIT_ERROR_MESSAGE =
  "アクセスが集中しています。しばらく待ってから、もう一度お試しください。";
export const UNAVAILABLE_ERROR_MESSAGE =
  "現在この機能を利用できません。時間をおいて、もう一度お試しください。";

const COMMON_STATUS_MESSAGES = {
  429: RATE_LIMIT_ERROR_MESSAGE,
  500: SERVER_ERROR_MESSAGE,
  502: SERVER_ERROR_MESSAGE,
  503: UNAVAILABLE_ERROR_MESSAGE,
  504: SERVER_ERROR_MESSAGE,
};

function detailOf(error) {
  const detail = error?.body?.detail;
  if (typeof detail === "string") return detail;
  // DEMO_MODEのエラーはbodyを持たず、messageにBackendと同じdetail英文を入れている。
  return typeof error?.message === "string" ? error.message : null;
}

export function toUserMessage(error, { byDetail = {}, byStatus = {}, fallback } = {}) {
  if (typeof error?.userMessage === "string" && error.userMessage) {
    return error.userMessage;
  }
  const detail = detailOf(error);
  if (detail && Object.prototype.hasOwnProperty.call(byDetail, detail)) {
    return byDetail[detail];
  }
  const status = error?.status;
  if (typeof status === "number") {
    return byStatus[status] || COMMON_STATUS_MESSAGES[status] || fallback || SERVER_ERROR_MESSAGE;
  }
  return NETWORK_ERROR_MESSAGE;
}
