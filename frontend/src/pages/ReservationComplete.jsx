import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams, useNavigate } from "react-router-dom";
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
import { buildGoogleMapsPlaceUrl, buildGoogleMapsUrl } from "../utils/googleMaps";
import { formatPickupHours } from "../utils/pickupHours";
import { AppLayout, primaryButtonClass, secondaryButtonClass } from "../components/ui";

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

// RouteTestで選択した受取時間帯の表示用(「9月26日(土) 10:00〜12:00」)。
// start/endが両方揃っている場合のみ範囲表示し、片方でも欠けていれば
// 「時間指定なし」とする(この機能追加以前の既存予約・RouteTestを経由しない
// 予約はpickup_window_start/endが両方nullのため、常にこちらになる)。
function formatPickupWindow(startValue, endValue) {
  if (!startValue || !endValue) return "時間指定なし";
  const dayFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const start = new Date(startValue);
  return `${dayFormatter.format(start)} ${timeFormatter.format(start)}〜${timeFormatter.format(new Date(endValue))}`;
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
    heading: "予約完了",
    description: "受取時にこのQRコードをスタッフに見せてください。",
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
  // 商品の受取場所。RouteTestを経由しない予約の受取地点表示に使う。
  const [itemLocation, setItemLocation] = useState(null);

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
    setItemLocation(null);

    async function loadItemTitle() {
      try {
        const items = await api.getItems();
        const found = (items || []).find((it) => String(it.id) === String(reservation.item_id));
        if (mounted) {
          setItemTitle(found?.title || null);
          setItemTitleError(!found?.title);
          setItemLocation(found?.location_name || null);
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
          passPointLat: location.state.passPointLat,
          passPointLng: location.state.passPointLng,
        }
      : null;

  if (!routeContext) {
    try {
      routeContext = loadRouteContext(id);
    } catch (e) {
      // 壊れたstorageの内容はroute情報なしとして扱う。
    }
  }

  if (initialLoading)
    return (
      <AppLayout step={4}>
        <p className="p-4">読み込み中…</p>
      </AppLayout>
    );
  if (initialError)
    return (
      <AppLayout step={4}>
        <p className="mb-3 pt-2 text-red-600">{initialError}</p>
        <div className="space-y-2">
          <button type="button" onClick={() => navigate("/")} className={primaryButtonClass}>
            トップへ戻る
          </button>
          <button type="button" onClick={() => navigate(-1)} className={secondaryButtonClass}>
            前のページへ戻る
          </button>
        </div>
      </AppLayout>
    );
  if (!reservation)
    return (
      <AppLayout step={4}>
        <p className="p-4">予約情報が見つかりません。</p>
      </AppLayout>
    );

  const statusDisplay = STATUS_DISPLAY[reservation.status] || UNKNOWN_STATUS_DISPLAY;
  const isPending = reservation.status === "pending";
  // PMレビューMAJOR M1: completed/cancelledはaccess_tokenを既に削除済み
  // (このタブのstateにまだ残っていれば直近の更新自体は成功し得るが、
  // 最終状態はこれ以上変わらないため再取得する意味が無い)。押せてしまうと
  // 次にトークンが無くなったタイミングで紛らわしい通信エラー表示に
  // つながるため、最終状態になった時点で更新ボタンごと無効化する。
  const isFinalStatus = reservation.status === "completed" || reservation.status === "cancelled";

  // 受取地点はRouteTestで選んだ地点を優先し、無ければ商品の受取場所。
  const pickupPlace = routeContext?.passPoint || itemLocation;
  // RouteTest経由ならルート(経由地つき)、そうでなければ受取地点そのものを開く。
  // どちらも目的地を推測で補うことはしない。
  const mapsUrl = routeContext
    ? buildGoogleMapsUrl(routeContext)
    : pickupPlace
      ? buildGoogleMapsPlaceUrl(pickupPlace)
      : null;

  // 予約IDは内部値のため全体を出さず、窓口で伝えやすい末尾4桁だけにする。
  const shortReservationNumber = String(reservation.id).slice(-4).toUpperCase();

  const detailRows = [
    {
      label: "商品",
      value: itemTitle || (
        <span className="text-gray-500">
          {itemTitleError ? "商品情報を取得できませんでした" : "読み込み中…"}
        </span>
      ),
    },
    { label: "氏名", value: reservation.user_name },
    ...(reservation.requested_at
      ? [{ label: "希望日時", value: formatRequestedAt(reservation.requested_at) }]
      : []),
    ...(itemPickupHours
      ? [
          {
            label: "営業時間",
            value: `${formatPickupHours(itemPickupHours.from)}〜${formatPickupHours(itemPickupHours.to)}`,
          },
        ]
      : []),
    ...(reservation.payment_method
      ? [
          {
            label: "支払い方法",
            value: `${PAYMENT_METHOD_LABELS[reservation.payment_method] || reservation.payment_method}（デモ決済）`,
          },
        ]
      : []),
    { label: "予約番号", value: `末尾 ${shortReservationNumber}` },
  ];

  return (
    <AppLayout step={4}>
      <section className={`rounded-xl p-4 ${statusDisplay.className}`} aria-live="polite">
        <h1 className="text-2xl font-bold">
          {isPending && <span aria-hidden="true">✓ </span>}
          {statusDisplay.heading}
        </h1>
        <p className="mt-1 text-sm">
          {isPending && itemTitle ? `${itemTitle}を予約しました。` : ""}
          {statusDisplay.description}
        </p>
      </section>

      <section className="mt-3 rounded-xl bg-white p-4 shadow-sm">
        <dl className="space-y-2">
          <div>
            <dt className="text-xs text-gray-500">受取地点</dt>
            <dd className="font-semibold">{pickupPlace || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">受取時間帯</dt>
            <dd className="font-semibold">
              {formatPickupWindow(reservation.pickup_window_start, reservation.pickup_window_end)}
            </dd>
          </div>
        </dl>

        {/* QRは受取前(pending)のみ表示する。受取済み・状態不明の予約でQRを
            提示させないため。 */}
        {isPending && (
          <div className="mt-3 flex justify-center">
            {reservation.qr_token ? (
              <QRCodeCanvas
                value={String(reservation.qr_token)}
                size={208}
                aria-label="受取用QRコード"
              />
            ) : (
              <p className="text-sm text-gray-500">QRコードを表示できませんでした</p>
            )}
          </div>
        )}
      </section>

      {isPending && mapsUrl && (
        <div className="mt-3">
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={primaryButtonClass}
          >
            Google Mapsで向かう
          </a>
          <p className="mt-1 text-center text-xs text-gray-500">
            {routeContext
              ? "現在地から、受取地点を経由して目的地へのルートを開きます"
              : "受取地点をGoogle Mapsで開きます"}
          </p>
        </div>
      )}

      <section className="mt-6 rounded-xl bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold">予約内容</h2>
        <dl className="mt-2 divide-y divide-gray-100 text-sm">
          {detailRows.map((row) => (
            <div key={row.label} className="flex justify-between gap-3 py-2">
              <dt className="shrink-0 text-gray-500">{row.label}</dt>
              <dd className="text-right">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {isPending && (
        <>
          {/* 現地でQRを出せなくなる事態を防ぐための再表示の案内。access_token
              をこの端末に保存できたかどうかで文言を切り替える。 */}
          {persisted ? (
            // 文の途中で1〜2文字だけ改行されないよう、文単位で折り返す。
            <p className="mt-3 rounded-lg bg-white p-3 text-xs text-gray-600">
              <span className="inline-block">この予約はこの端末に保存されています。</span>
              <span className="inline-block">
                この画面を閉じても、同じ端末・同じブラウザでこのページを開けばQRコードを再表示できます。
              </span>
              <span className="inline-block">
                念のため、このページをブックマークするか、QRコードのスクリーンショットを保存しておいてください。
              </span>
            </p>
          ) : (
            <p
              className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
              role="alert"
            >
              この端末に予約情報を保存できませんでした。この画面を閉じるとQRコードを再表示できなくなるため、閉じる前にQRコードのスクリーンショットを保存してください。
            </p>
          )}

          {/* QRが読み取れない場合にスタッフが手入力するためのコード。内部値
              のため、既定では折りたたんでおく。 */}
          {reservation.qr_token && (
            <details className="mt-3 rounded-lg bg-white p-3 text-sm">
              <summary className="flex min-h-[44px] cursor-pointer items-center text-[#2f6f3e]">
                QRコードが読み取れない場合
              </summary>
              <p className="text-xs text-gray-500">スタッフにこのコードをお伝えください</p>
              <p className="mt-1 break-all font-mono text-sm">{reservation.qr_token}</p>
            </details>
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
          className={`${secondaryButtonClass} mt-4 border-gray-300 text-gray-700`}
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

      <p className="mt-4 text-center">
        <Link
          to="/"
          className="inline-flex min-h-[44px] items-center text-sm text-[#2f6f3e] underline"
        >
          トップへ戻る
        </Link>
      </p>

      {/* キャンセルはpending(受取前)の予約にのみ表示する。completed/
          cancelledの予約はキャンセル不可(Backend側でも拒否される)。
          取り消し操作のため、画面の最下部に他の操作と離して置く。 */}
      {isPending &&
        (!cancelConfirming ? (
          <button
            type="button"
            onClick={() => {
              setCancelConfirming(true);
              setCancelError(null);
            }}
            disabled={refreshing}
            className="mt-6 flex min-h-[44px] w-full items-center justify-center border-t border-gray-200 pt-2 text-sm text-red-700 underline disabled:opacity-50"
          >
            予約をキャンセルする
          </button>
        ) : (
          <div className="mt-6 rounded-lg border border-red-200 bg-white p-3">
            <p className="text-sm text-red-700">本当にキャンセルしますか？</p>
            <div className="mt-2 flex gap-2">
              {/* 2等分だとスマホ幅で「はい、キャンセルす/る」と改行されるため、
                  短い「いいえ」より広く取る。 */}
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelling}
                aria-busy={cancelling}
                className={`min-h-[44px] flex-[2] rounded-lg px-4 py-2 text-sm text-white ${
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
                className="min-h-[44px] flex-1 rounded-lg bg-gray-200 px-4 py-2 text-sm disabled:opacity-50"
              >
                いいえ
              </button>
            </div>
          </div>
        ))}
      {cancelError && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {cancelError}（表示中の予約情報は変更していません）
        </p>
      )}

    </AppLayout>
  );
}
