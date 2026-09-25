// 予約照会用access_tokenのブラウザ内保存。
// - sessionStorage: 既存どおりタブ単位で保持する。
// - localStorage: タブを閉じた後や別タブでも、同じ端末・同じブラウザなら
//   予約完了画面(/complete/:id)からQRを再表示できるように保持する。
// 保存するのは予約IDをキーにしたaccess_tokenのみ。qr_tokenなど他の値は
// 保存しない(QRは毎回GET /reservations/{id}で取得する)。
// どの操作もstorageが使えない環境で例外を投げないようにする(予約自体の
// 成否をstorageの可否で左右させないため)。

const KEY_PREFIX = "traildrop_access_token_";

function storageKey(reservationId) {
  return `${KEY_PREFIX}${reservationId}`;
}

// 両方のstorageへの保存を試みる。localStorageに保存できたかどうかを返す
// (完了画面で「この端末に保存できなかった」旨を案内するため)。
export function saveAccessToken(reservationId, accessToken) {
  if (!reservationId || !accessToken) return false;
  try {
    sessionStorage.setItem(storageKey(reservationId), accessToken);
  } catch {
    // タブ単位の保存に失敗してもlocation.state/localStorageで復元できる。
  }
  try {
    localStorage.setItem(storageKey(reservationId), accessToken);
    return true;
  } catch {
    return false;
  }
}

// sessionStorage → localStorageの順に探す。
export function loadAccessToken(reservationId) {
  try {
    const fromSession = sessionStorage.getItem(storageKey(reservationId));
    if (fromSession) return fromSession;
  } catch {
    // 読めない場合はlocalStorageを試す。
  }
  try {
    return localStorage.getItem(storageKey(reservationId));
  } catch {
    return null;
  }
}

// この端末(localStorage)に保存済みかどうか。
export function isAccessTokenPersisted(reservationId) {
  try {
    return Boolean(localStorage.getItem(storageKey(reservationId)));
  } catch {
    return false;
  }
}

// completed/cancelledになった予約はもうQRを再表示する必要が無いため、
// sessionStorage/localStorageの両方からaccess_tokenを削除する。無期限に
// 端末へ残さないための後始末(一括修正m1)。storageが使えない環境でも
// 例外を投げない(既存の各関数と同じ方針)。
export function clearAccessToken(reservationId) {
  try {
    sessionStorage.removeItem(storageKey(reservationId));
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(storageKey(reservationId));
  } catch {
    // ignore
  }
}

const FINALIZED_KEY_PREFIX = "traildrop_finalized_status_";

function finalizedStatusKey(reservationId) {
  return `${FINALIZED_KEY_PREFIX}${reservationId}`;
}

// PMレビューMAJOR M1: completed/cancelledになった予約はaccess_tokenを
// clearAccessTokenで削除するが、その削除が「セキュリティ上意図した削除」
// であることを後から区別できるよう、status(completed/cancelled)だけを
// 別途記録しておく。access_token自体は含まないため、これが漏れても
// 予約の照会・悪用には使えない。reload・別タブでこの予約を開いた際、
// 「トークンが無い=通信エラー」ではなく「既に最終状態だから削除済み」と
// 案内するために使う(ReservationComplete.jsx)。
export function saveFinalizedStatus(reservationId, status) {
  if (!reservationId || !status) return;
  try {
    localStorage.setItem(finalizedStatusKey(reservationId), status);
  } catch {
    // 保存できなくても致命的ではない(通常の通信エラー文言にフォールバックする)。
  }
}

export function loadFinalizedStatus(reservationId) {
  try {
    return localStorage.getItem(finalizedStatusKey(reservationId));
  } catch {
    return null;
  }
}
