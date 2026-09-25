import React, { useEffect, useRef, useState } from "react";
import { useLocation, useParams, useNavigate } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import api from "../api/client";
import {
  clearAccessToken,
  isAccessTokenPersisted,
  loadAccessToken,
  loadFinalizedStatus,
  saveAccessToken,
  saveFinalizedStatus,
} from "../utils/reservationAccess";
import { loadRouteContext } from "../utils/routeContext";
import { toUserMessage } from "../utils/errorMessages";

// 初回読み込み(予約照会)の失敗も、Backendの英文detail("Reservation not
// found"等)をそのまま出さない。GET /reservations/{id}は本番・DEMO_MODEとも、
// 予約IDの誤り・トークンの不一致/欠落をすべて404で返す。
const MISSING_TOKEN_MESSAGE =
  "この端末には予約の確認に必要な情報が保存されていません。予約した端末・ブラウザで開いてください。";
const FETCH_ERROR_BY_STATUS = {
  404: "予約が見つかりませんでした。URLが正しいか、予約した端末・ブラウザで開いているかをご確認ください。",
};
const FETCH_ERROR_FALLBACK = "予約情報の取得に失敗しました。時間をおいて、もう一度お試しください。";

function formatRequestedAt(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

// RouteTestで選択した受取時間帯の表示用。start/endが両方揃っている場合の
// み範囲表示し、片方でも欠けていれば「未設定」とする(この機能追加以前の
// 既存予約・RouteTestを経由しない予約はpickup_window_start/endが両方
// nullのため、常にこちらになる)。
function formatPickupWindow(startValue, endValue) {
  if (!startValue || !endValue) return "未設定";
  const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${dateFormatter.format(new Date(startValue))}〜${timeFormatter.format(new Date(endValue))}`;
}

// "HH:MM:SS" / "HH:MM" から表示用の"HH:MM"を取り出す(ItemList.jsx/
// RouteTest.jsxと同じ抽出方法)。一括修正U2: 商品自体の営業時間を表示する。
function formatPickupHours(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function buildGoogleMapsUrl({ destination, passPoint }) {
  const params = new URLSearchParams({
    api: "1",
    destination,
    waypoints: passPoint,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

// Reservation.jsxのPAYMENT_METHODSと合わせる。この画面より前に作られた
// 予約(payment_methodがNone)は表示自体を出さない(推測で補わない)。
const PAYMENT_METHOD_LABELS = {
  paypay: "PayPay",
  credit_card: "クレジットカード",
};

// Backend/DBのstatusは'pending'・'completed'・'cancelled'のみ
// (schema.sqlのcheck制約)。それ以外の値はどれとも扱わず、状態不明として
// 表示する。
const STATUS_DISPLAY = {
  pending: {
    heading: "予約受付済み",
    description: "受取時にこの画面のQRコードを現地スタッフに提示してください。",
    className: "bg-[#eef6ec] text-[#2f6f3e]",
  },
  completed: {
    heading: "受取済み",
    description: "この予約はスタッフによる受取確認が完了しています。",
    className: "bg-blue-50 text-blue-800",
  },
  cancelled: {
    heading: "キャンセル済み",
    description: "この予約はキャンセルされました。",
    className: "bg-gray-100 text-gray-600",
  },
};

const UNKNOWN_STATUS_DISPLAY = {
  heading: "予約状態を確認できません",
  description: "お手数ですが現地スタッフにお問い合わせください。",
  className: "bg-gray-100 text-gray-700",
};

// 更新ボタンの再取得失敗は、fetchやHTTPの生のエラー文言(英語になり得る)を
// そのまま出さず、常にこの固定文言を表示する。初回読み込みの失敗(initialError)
// はtoUserMessageでstatus別の日本語にする。
const REFRESH_ERROR_MESSAGE =
  "最新の状態を取得できませんでした。通信環境を確認して再度お試しください。";

// キャンセル失敗も同様に、Backendの生のdetail文言(英語)をそのまま出さず
// 固定の日本語メッセージにする。409(completed/cancelled済みからの拒否)だけ
// 理由が伝わるよう個別のメッセージにし、それ以外は通信エラー等としてまとめる。
const CANCEL_ERROR_MESSAGES = {
  404: "予約が見つかりませんでした。",
  409: "この予約はすでに受取済みまたはキャンセル済みのため、キャンセルできません。",
};
const CANCEL_GENERIC_ERROR_MESSAGE =
  "予約をキャンセルできませんでした。通信環境を確認して再度お試しください。";

function resolveCancelErrorMessage(err) {
  return CANCEL_ERROR_MESSAGES[err?.status] || CANCEL_GENERIC_ERROR_MESSAGE;
}

export default function ReservationComplete() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [reservation, setReservation] = useState(null);
  // 初回読み込みの失敗は画面全体のエラー表示にする(既存挙動を維持)。
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState(null);
  // 「最新の状態に更新」ボタンによる再取得は、初回読み込みとは失敗時の扱いを
  // 分ける。失敗しても表示中の予約情報・QRはそのまま残し、ボタン付近にだけ
  // エラーを表示する。
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  // この端末(localStorage)にaccess_tokenを保存できているか。保存できて
  // いない場合は、タブを閉じるとQRを再表示できなくなる旨を案内する。
  const [persisted, setPersisted] = useState(() => isAccessTokenPersisted(id));
  // 更新ボタンを押すたびに増やす。商品名取得effectの依存に含めることで、
  // item_idが変わっていなくても更新のたびに商品名を取り直せるようにする
  // (初回取得が失敗していた場合の再試行手段)。
  const [itemReloadKey, setItemReloadKey] = useState(0);

  // キャンセルはpendingの予約にのみ表示する破壊的な操作なので、誤操作を
  // 防ぐためワンクッション(確認表示)を挟む。失敗しても表示中の予約情報は
  // そのまま残し、更新(refreshError)とは別にエラーを表示する。
  const [cancelConfirming, setCancelConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(null);

  // 商品名は予約情報の表示とは独立して取得する。取得中・失敗のいずれでも
  // 予約情報・status・QRの表示は妨げない。取得できない場合は推測で補わず
  // 「取得できませんでした」と表示する。
  const [itemTitle, setItemTitle] = useState(null);
  const [itemTitleError, setItemTitleError] = useState(false);
  // 商品自体の営業時間(一括修正U2)。itemTitleと同じ取得ライフサイクルで
  // 一緒に埋める。
  const [itemPickupHours, setItemPickupHours] = useState(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 予約照会・キャンセルの両方で使う、同じ解決ロジック(state優先、
  // sessionStorage→localStorageへフォールバック)を1箇所にまとめる。
  // localStorageにより、タブを閉じた後や別タブで開いた場合でも、同じ端末
  // なら予約を再表示できる。
  function getAccessToken() {
    const tokenFromState = location.state?.access_token || null;
    return tokenFromState || loadAccessToken(id);
  }

  async function fetchReservation({ isInitial }) {
    if (isInitial) {
      setInitialLoading(true);
      setInitialError(null);
    } else {
      setRefreshing(true);
      setRefreshError(null);
    }

    try {
      const accessToken = getAccessToken();

      if (!accessToken) {
        // PMレビューMAJOR M1: completed/cancelledになった時点でaccess_tokenは
        // 意図的に端末から削除している(セキュリティ上の設計、下のclearAccess
        // Token呼び出し箇所を参照)。そのため、リロード・別タブでの再アクセス
        // や、完了/キャンセル後にもう一度更新ボタンを押した場合にトークンが
        // 無いのは「通信の失敗」ではなく想定通りの状態であり、それを
        // 「通信環境を確認して再度お試しください」という紛らわしい文言で
        // 表示してはいけない。事前に記録しておいたfinalized statusがあれば、
        // 実際の通信は行わずにその旨を案内する。
        const finalizedStatus = loadFinalizedStatus(id);
        if (finalizedStatus === "completed" || finalizedStatus === "cancelled") {
          const message =
            finalizedStatus === "completed"
              ? "この予約はすでに受取済みです。セキュリティのためこの端末に保存していたトークンは削除済みのため、これ以上の更新はできません。詳細は受取窓口にお問い合わせください。"
              : "この予約はすでにキャンセル済みです。セキュリティのためこの端末に保存していたトークンは削除済みのため、これ以上の更新はできません。";
          if (isInitial) setInitialError(message);
          else setRefreshError(message);
          return;
        }
        if (import.meta.env.VITE_API_BASE_URL) {
          const missingTokenError = new Error(MISSING_TOKEN_MESSAGE);
          missingTokenError.userMessage = MISSING_TOKEN_MESSAGE;
          throw missingTokenError;
        }
      }

      const res = await api.getReservation(id, accessToken);
      if (!mountedRef.current) return;
      setReservation(res);
      if (res.status === "completed" || res.status === "cancelled") {
        // 受取済み・キャンセル済みになった予約はもうQRを再表示する必要が
        // 無いため、access_tokenを端末に無期限で残さない(一括修正m1)。
        clearAccessToken(id);
        saveFinalizedStatus(id, res.status);
        setPersisted(false);
      } else if (accessToken) {
        // 予約作成直後の保存に失敗していた場合(location.stateのみで到達した
        // 場合など)に備え、照会に成功したaccess_tokenをこの端末へ保存し直す。
        // 保存できたかどうかを案内表示に使う。
        setPersisted(saveAccessToken(id, accessToken));
      }
    } catch (e) {
      if (!mountedRef.current) return;
      if (isInitial) {
        setInitialError(
          toUserMessage(e, { byStatus: FETCH_ERROR_BY_STATUS, fallback: FETCH_ERROR_FALLBACK }),
        );
      } else {
        setRefreshError(REFRESH_ERROR_MESSAGE);
      }
    } finally {
      if (!mountedRef.current) return;
      if (isInitial) setInitialLoading(false);
      else setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchReservation({ isInitial: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleCancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      const accessToken = getAccessToken();
      const res = await api.cancelReservation(id, accessToken);
      if (!mountedRef.current) return;
      // status更新はBackend(cancel_reservation_with_stock RPC)からの応答を
      // そのまま反映する。在庫返却もそのRPC内で同時に行われている前提で、
      // Frontend側では在庫に関する処理を一切行わない。
      setReservation(res);
      // キャンセル完了時点でaccess_tokenはもう不要(一括修正m1)。
      clearAccessToken(id);
      saveFinalizedStatus(id, res.status);
      setPersisted(false);
      setCancelConfirming(false);
    } catch (e) {
      if (!mountedRef.current) return;
      setCancelError(resolveCancelErrorMessage(e));
    } finally {
      if (!mountedRef.current) return;
      setCancelling(false);
    }
  }

  // 予約のitem_idが分かった時点で商品名を取得する。予約の再取得(初回・更新)
  // とは別のライフサイクルで動くため、商品名取得の成否が予約表示の
  // loading/エラー状態に影響しない。itemReloadKeyを依存に含めることで、
  // item_idが変わらない更新操作でも商品名を取り直せる(初回取得の失敗を
  // 更新ボタンでリトライできるようにするため)。
  useEffect(() => {
    if (!reservation?.item_id) return;
    let mounted = true;
    setItemTitle(null);
    setItemTitleError(false);
    setItemPickupHours(null);

    async function loadItemTitle() {
      try {
        const items = await api.getItems();
        const found = (items || []).find((it) => String(it.id) === String(reservation.item_id));
        if (mounted) {
          setItemTitle(found?.title || null);
          setItemTitleError(!found?.title);
          setItemPickupHours(
            found?.pickup_available_from && found?.pickup_available_to
              ? { from: found.pickup_available_from, to: found.pickup_available_to }
              : null,
          );
        }
      } catch (e) {
        if (mounted) {
          setItemTitle(null);
          setItemTitleError(true);
        }
      }
    }

    loadItemTitle();
    return () => {
      mounted = false;
    };
  }, [reservation?.item_id, itemReloadKey]);

  // RouteTest経由で予約した場合のみ、Google Maps引き継ぎに使う経路情報を持つ。
  // ItemListから直接予約した場合や、stateを保持しないリロード直後は
  // location.stateが空になるため、access_tokenと同じくlocalStorage(TTL付き、
  // 別タブでも復元できる。一括修正U6)へフォールバックする。いずれにも
  // なければroute情報はnullのままとし、目的地を推測で補うことはしない。
  let routeContext =
    location.state?.origin && location.state?.destination && location.state?.passPoint
      ? {
          origin: location.state.origin,
          destination: location.state.destination,
          passPoint: location.state.passPoint,
        }
      : null;

  if (!routeContext) {
    try {
      routeContext = loadRouteContext(id);
    } catch (e) {
      // 壊れたstorageの内容はroute情報なしとして扱う。
    }
  }

  if (initialLoading) return <div className="p-4">読み込み中…</div>;
  if (initialError)
    return (
      <div className="p-4">
        <div className="text-red-600 mb-3">{initialError}</div>
        <div className="flex space-x-2">
          <button onClick={() => navigate('/')} className="px-3 py-1 bg-[#2f6f3e] text-white rounded">一覧へ戻る</button>
          <button onClick={() => navigate(-1)} className="px-3 py-1 bg-gray-200 rounded">前のページへ戻る</button>
        </div>
      </div>
    );
  if (!reservation) return <div className="p-4">予約情報が見つかりません。</div>;

  const statusDisplay = STATUS_DISPLAY[reservation.status] || UNKNOWN_STATUS_DISPLAY;
  const isPending = reservation.status === "pending";
  // PMレビューMAJOR M1: completed/cancelledはaccess_tokenを既に削除済み
  // (このタブのstateにまだ残っていれば直近の更新自体は成功し得るが、
  // 最終状態はこれ以上変わらないため再取得する意味が無い)。押せてしまうと
  // 次にトークンが無くなったタイミングで紛らわしい通信エラー表示に
  // つながるため、最終状態になった時点で更新ボタンごと無効化する。
  const isFinalStatus = reservation.status === "completed" || reservation.status === "cancelled";

  return (
    <div className="min-h-screen p-4 bg-[#fffef6] text-[#16381b] flex flex-col items-center">
      <div className="w-full max-w-sm bg-white p-4 rounded-md shadow">
        <div className={`mb-4 rounded p-3 ${statusDisplay.className}`} aria-live="polite">
          <h2 className="text-lg font-semibold">{statusDisplay.heading}</h2>
          <p className="mt-1 text-sm">{statusDisplay.description}</p>
        </div>
        <div className="mb-3">予約番号: <span className="font-mono">{reservation.id}</span></div>
        <div className="mb-3">氏名: {reservation.user_name}</div>
        <div className="mb-3">
          商品:{" "}
          {itemTitle ? (
            itemTitle
          ) : (
            <span className="text-sm text-gray-500">
              {itemTitleError ? "商品情報を取得できませんでした" : "読み込み中…"}
            </span>
          )}
        </div>
        {itemPickupHours && (
          <div className="mb-3 text-sm text-gray-600">
            商品受取可能時間: {formatPickupHours(itemPickupHours.from)}
            〜{formatPickupHours(itemPickupHours.to)}
          </div>
        )}
        {reservation.requested_at && (
          <div className="mb-3">希望日時: {formatRequestedAt(reservation.requested_at)}</div>
        )}
        <div className="mb-3">
          受取時間帯:{" "}
          {formatPickupWindow(reservation.pickup_window_start, reservation.pickup_window_end)}
        </div>
        {reservation.payment_method && (
          <div className="mb-3">
            <div>
              支払い方法: {PAYMENT_METHOD_LABELS[reservation.payment_method] || reservation.payment_method}
            </div>
            <div className="text-xs text-gray-500">デモ決済（実際の請求はありません）</div>
          </div>
        )}
        {/* QRは受取前(pending)のみ表示する。受取済み・状態不明の予約でQRを
            提示させないため。案内文は上のstatus表示(description)に一本化し、
            ここでは重複させない。 */}
        {isPending && (
          <>
            <div className="flex justify-center my-3">
              {reservation.qr_token ? (
                <QRCodeCanvas value={String(reservation.qr_token)} size={180} />
              ) : (
                <div className="text-sm text-gray-500">(QR生成用のトークンがありません)</div>
              )}
            </div>
            {reservation.qr_token && (
              <div className="mb-3 text-center">
                <div className="text-xs text-gray-500">QRが読み取れない場合：</div>
                <div className="font-mono text-sm break-all">{reservation.qr_token}</div>
              </div>
            )}

            {/* 現地でQRを出せなくなる事態を防ぐための再表示の案内。access_token
                をこの端末に保存できたかどうかで文言を切り替える。 */}
            {persisted ? (
              <div className="mb-3 rounded bg-gray-50 p-3 text-xs text-gray-700">
                この予約はこの端末に保存されています。この画面を閉じても、同じ端末・同じブラウザでこのページを開けばQRコードを再表示できます。念のため、このページをブックマークするか、QRコードのスクリーンショットを保存しておいてください。
              </div>
            ) : (
              <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900" role="alert">
                この端末に予約情報を保存できませんでした。この画面を閉じるとQRコードを再表示できなくなるため、閉じる前にQRコードのスクリーンショットを保存してください。
              </div>
            )}

            {/* キャンセルはpending(受取前)の予約にのみ表示する。completed/
                cancelledの予約はキャンセル不可(Backend側でも拒否される)。 */}
            {!cancelConfirming ? (
              <button
                type="button"
                onClick={() => {
                  setCancelConfirming(true);
                  setCancelError(null);
                }}
                disabled={refreshing}
                className="mt-2 w-full rounded px-4 py-2 text-sm border border-red-300 text-red-700 disabled:opacity-50"
              >
                予約をキャンセルする
              </button>
            ) : (
              <div className="mt-2 rounded border border-red-200 p-3">
                <p className="text-sm text-red-700">本当にキャンセルしますか？</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={cancelling}
                    aria-busy={cancelling}
                    className={`flex-1 rounded px-4 py-2 text-sm text-white ${
                      cancelling ? "bg-red-300" : "bg-red-600"
                    }`}
                  >
                    {cancelling ? "キャンセル中…" : "はい、キャンセルする"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCancelConfirming(false);
                      setCancelError(null);
                    }}
                    disabled={cancelling}
                    className="flex-1 rounded px-4 py-2 text-sm bg-gray-200 disabled:opacity-50"
                  >
                    いいえ
                  </button>
                </div>
              </div>
            )}
            {cancelError && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {cancelError}（表示中の予約情報は変更していません）
              </p>
            )}
          </>
        )}

        {!isFinalStatus && (
          <button
            type="button"
            onClick={() => {
              fetchReservation({ isInitial: false });
              setItemReloadKey((count) => count + 1);
            }}
            disabled={refreshing || cancelling || cancelConfirming}
            aria-busy={refreshing}
            className={`mt-4 w-full rounded px-4 py-2 text-sm ${
              refreshing ? "bg-gray-100 text-gray-400" : "bg-gray-200"
            }`}
          >
            {refreshing ? "更新中…" : "最新の状態に更新"}
          </button>
        )}
        {refreshError && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {refreshError}
            {!isFinalStatus && "（表示中の予約情報は変更していません）"}
          </p>
        )}

        {routeContext && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() =>
                window.open(buildGoogleMapsUrl(routeContext), "_blank", "noopener,noreferrer")
              }
              className="w-full rounded px-4 py-2 font-medium text-white bg-[#2f6f3e]"
            >
              Google Mapsでルートを開く
            </button>
            <p className="mt-1 text-xs text-gray-500">
              現在地から、受取地点を経由して目的地へのルートを開きます
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
