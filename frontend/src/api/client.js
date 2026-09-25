const BASE = import.meta.env.VITE_API_BASE_URL || "";
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
const ROUTE_ANALYSIS_CLIENT_KEY = import.meta.env.VITE_ROUTE_ANALYSIS_CLIENT_KEY || "";

// 通信が固まったまま返ってこない状態でUIを永久にloadingのまま止めない
// ためのtimeout。予約作成がtimeoutした場合は、DEFINITELY_NOT_CREATED_
// STATUSES(Reservation.jsx)に含まれないstatus無しのErrorを投げることで、
// 既存の「曖昧な失敗」扱い(即再送を促さない)にそのまま乗せる。
const DEFAULT_TIMEOUT_MS = 20000;
// Backend(route_analysis.py)のGoogle呼び出し自体のtimeoutが15秒なので、
// それより少し余裕を持たせる。
const ROUTE_ANALYSIS_TIMEOUT_MS = 18000;
const TIMEOUT_ERROR_MESSAGE =
  "通信がタイムアウトしました。結果が不明なため、内容を確認してから再試行してください。";

// main.pyのVALID_PAYMENT_METHODSと合わせる。実決済は行わないモック決済。
const VALID_PAYMENT_METHODS = new Set(["paypay", "credit_card"]);

function errorMessage(json, status) {
  const detail = json?.detail;
  if (typeof detail === "string") return detail;

  if (Array.isArray(detail)) {
    const hasRequestedAtError = detail.some(
      (entry) => Array.isArray(entry?.loc) && entry.loc.includes("requested_at"),
    );
    return hasRequestedAtError
      ? "入力された日時が正しくありません。"
      : "入力内容が正しくありません。";
  }

  if (detail && typeof detail === "object" && typeof detail.msg === "string") {
    return detail.msg;
  }
  if (typeof json?.message === "string") return json.message;
  if (status === 422) return "入力内容が正しくありません。";
  return `HTTP ${status}`;
}

async function request(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = BASE ? `${BASE}${path}` : null;

  if (!url) {
    throw new Error("VITE_API_BASE_URL is not configured");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    // timeoutは「失敗した」と断定できない(リクエストがサーバーに届いた後で
    // 応答だけが失われた可能性がある)ため、statusを付与しないErrorにする。
    // Reservation.jsxのDEFINITELY_NOT_CREATED_STATUSESにstatus無しは含まれ
    // ないため、既存の曖昧な失敗の扱いにそのまま乗る。
    if (e?.name === "AbortError") {
      const timeoutError = new Error(TIMEOUT_ERROR_MESSAGE);
      // 既に日本語の利用者向け文言なので、utils/errorMessages.jsのtoUserMessage
      // でもそのまま表示する。
      timeoutError.userMessage = TIMEOUT_ERROR_MESSAGE;
      throw timeoutError;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    throw new Error(`Invalid JSON response (${res.status})`);
  }

  if (!res.ok) {
    const msg = errorMessage(json, res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    // FastAPIのバリデーションエラー(detailが配列)は、errorMessage()で既に
    // 日本語化している。英語のdetail文字列はここでは日本語化せず、各画面が
    // toUserMessage(utils/errorMessages.js)で変換する。
    if (Array.isArray(json?.detail)) {
      err.userMessage = msg;
    }
    throw err;
  }

  return json;
}

function demoGetItems() {
  return [
    {
      id: "wood-001",
      title: "間伐材の薪（小）",
      type: "product",
      price: 500,
      stock: 20,
      location_name: "道の駅 ロック・ガーデンひちそう",
      pickup_available_from: "09:00:00",
      pickup_available_to: "18:00:00",
    },
    {
      id: "log-experience-001",
      title: "丸太の玉切り体験",
      type: "experience",
      price: 1500,
      stock: 8,
      location_name: "道の駅 ロック・ガーデンひちそう",
      pickup_available_from: null,
      pickup_available_to: null,
    },
  ];
}

export async function getItems() {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 200));
    return demoGetItems();
  }
  return await request(`/items`, { method: "GET" });
}

export async function createReservation({
  item_id,
  user_name,
  requested_at = null,
  payment_method = null,
  // RouteTestで選択した受取時間帯(ISO文字列)。RouteTestを経由しない予約
  // では両方nullのまま送る(既存予約との後方互換性)。
  pickup_window_start = null,
  pickup_window_end = null,
}) {
  // 本番Backend(main.pyのcreate_reservation)と同じ「未指定・不正はどちらも
  // 400」という扱いを、DEMO_MODEでも先に行う。実際の決済処理はどちらの
  // モードでも一切行わない(モック決済)。
  if (!VALID_PAYMENT_METHODS.has(payment_method)) {
    const err = new Error("Invalid payment method");
    err.status = 400;
    throw err;
  }

  if (DEMO_MODE) {
    // Demo mode: persist reservations in sessionStorage so they survive reloads
    const now = new Date().toISOString();
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `demo-${Date.now()}`;
    const qr = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `qr-${Date.now()}`;
    const access = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `access-${Date.now()}`;
    const reservation = {
      id,
      item_id,
      user_name,
      qr_token: qr,
      access_token: access,
      status: "pending",
      requested_at,
      reserved_at: now,
      payment_method,
      // 本番のcreate_reservation_with_stock RPCと同じく、モック決済は
      // 予約作成と同時に即時「成功」扱いにする(中間状態を残さない)。
      payment_status: "paid",
      pickup_window_start,
      pickup_window_end,
    };

    try {
      const raw = sessionStorage.getItem("demo_reservations") || "{}";
      const map = JSON.parse(raw);
      map[id] = reservation;
      sessionStorage.setItem("demo_reservations", JSON.stringify(map));
    } catch (e) {
      // ignore storage errors in demo mode
    }

    return reservation;
  }
  return await request(`/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      item_id,
      user_name,
      requested_at,
      payment_method,
      pickup_window_start,
      pickup_window_end,
    }),
  });
}

export async function getReservation(reservationId, reservationToken) {
  if (DEMO_MODE) {
    // Demo mode: load persisted reservation created via createReservation
    try {
      const raw = sessionStorage.getItem("demo_reservations") || "{}";
      const map = JSON.parse(raw);
      const res = map[reservationId];
      if (!res) {
        const err = new Error("Reservation not found");
        err.status = 404;
        throw err;
      }
      // Require a reservationToken and validate it against stored access_token.
      // A missing/mismatched token returns the same 404 "Reservation not found"
      // as an unknown id, exactly like the real GET /reservations/{id}
      // (main.py) and cancelReservation() below, so the id's existence can't
      // be probed and both modes share one error contract.
      if (!reservationToken || res.access_token !== reservationToken) {
        const err = new Error("Reservation not found");
        err.status = 404;
        throw err;
      }
      const { access_token: _accessToken, ...response } = res;
      return response;
    } catch (e) {
      if (e && typeof e.status === "number") throw e;
      const err = new Error("Failed to load reservation");
      err.status = 502;
      throw err;
    }
  }

  const headers = {};
  if (reservationToken) {
    headers["X-Reservation-Token"] = reservationToken;
  }

  return await request(`/reservations/${encodeURIComponent(reservationId)}`, {
    method: "GET",
    headers,
  });
}

export async function cancelReservation(reservationId, reservationToken) {
  if (DEMO_MODE) {
    // Demo mode: mirror the real /reservations/{id}/cancel endpoint's
    // status codes. A missing/mismatched token and an unknown id both
    // return 404 (not 401) so the id's existence can't be probed, matching
    // getReservation()'s access-token check and the Backend's cancel RPC.
    // There is no stock to return here: demo items always come from the
    // static demoGetItems() list, which createReservation() never
    // decrements either.
    try {
      const raw = sessionStorage.getItem("demo_reservations") || "{}";
      const map = JSON.parse(raw);
      const res = map[reservationId];
      if (!res || !reservationToken || res.access_token !== reservationToken) {
        const err = new Error("Reservation not found");
        err.status = 404;
        throw err;
      }
      if (res.status !== "pending") {
        const err = new Error("Reservation cannot be cancelled");
        err.status = 409;
        throw err;
      }
      res.status = "cancelled";
      // 本番のcancel_reservation_with_stock RPCと同じく、payment_statusが
      // "paid"の場合だけ"cancelled"にする("pending"はそのまま)。
      if (res.payment_status === "paid") {
        res.payment_status = "cancelled";
      }
      map[reservationId] = res;
      sessionStorage.setItem("demo_reservations", JSON.stringify(map));
      const { access_token: _accessToken, ...response } = res;
      return response;
    } catch (e) {
      if (e && typeof e.status === "number") throw e;
      const err = new Error("Failed to cancel reservation");
      err.status = 502;
      throw err;
    }
  }

  const headers = {};
  if (reservationToken) {
    headers["X-Reservation-Token"] = reservationToken;
  }

  return await request(`/reservations/${encodeURIComponent(reservationId)}/cancel`, {
    method: "POST",
    headers,
  });
}

// DEMO_MODEでは実際のGoogle Routes APIを一切呼ばず、決定的なダミー結果を
// 返す。route_analysis.py(Backend)と同じ形(pass_atはdeparture_atに固定の
// 所要時間を足した値、pass_pointはdemoGetItems()の商品が実際に紐づく
// location_name)にすることで、RouteTest.jsxの以降のロジック(受取時間の
// 計算・商品の絞り込み)を本番と全く同じコードパスで動かせる。
const DEMO_FIRST_LEG_MINUTES = 60;
const DEMO_TOTAL_DURATION_MINUTES = 120;
const DEMO_TOTAL_DISTANCE_METERS = 60000;
// demoGetItems()の商品が実際に持つlocation_nameと一致させる。
const DEMO_PASS_POINT = "道の駅 ロック・ガーデンひちそう";

function demoAnalyzeRoute({ origin, destination, departure_at }) {
  const departureDate = new Date(departure_at);
  const passAt = new Date(departureDate.getTime() + DEMO_FIRST_LEG_MINUTES * 60000).toISOString();
  return {
    origin,
    destination,
    pass_point: DEMO_PASS_POINT,
    pass_at: passAt,
    // DEMOでは実在地点の座標を持たない(未確認の座標を使わない)ため、座標は
    // null。Google Mapsの経由地は地点名で開く。
    pass_point_lat: null,
    pass_point_lng: null,
    pickup_candidates: [
      {
        name: DEMO_PASS_POINT,
        lat: null,
        lng: null,
        pass_at: passAt,
        distance_from_route_meters: 0,
      },
    ],
    total_duration_minutes: DEMO_TOTAL_DURATION_MINUTES,
    total_distance_meters: DEMO_TOTAL_DISTANCE_METERS,
  };
}

// origin_location({lat, lng})は「現在地を使う」で取得した場合だけ送る。
export async function analyzeRoute({ origin, destination, departure_at, origin_location = null }) {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 200));
    return demoAnalyzeRoute({ origin, destination, departure_at });
  }
  return await request(
    `/routes/analyze`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Key": ROUTE_ANALYSIS_CLIENT_KEY,
      },
      body: JSON.stringify({
        origin,
        destination,
        departure_at,
        ...(origin_location ? { origin_location } : {}),
      }),
    },
    ROUTE_ANALYSIS_TIMEOUT_MS,
  );
}

export async function verifyQr(qrToken, staffToken) {
  if (DEMO_MODE) {
    // Demo mode: there is no real STAFF_API_TOKEN to compare against, so any
    // non-empty value is accepted (see main.py's require_staff_token for the
    // real behavior this stands in for).
    if (!staffToken) {
      const err = new Error("Invalid staff token");
      err.status = 401;
      throw err;
    }
    try {
      const raw = sessionStorage.getItem("demo_reservations") || "{}";
      const map = JSON.parse(raw);
      const entry = Object.values(map).find((res) => res.qr_token === qrToken);
      if (!entry) {
        const err = new Error("QR token not found");
        err.status = 404;
        throw err;
      }
      // pending以外は全て拒否する(completedはもちろん、cancelledも)。
      // cancelledをcompletedと同じ扱いにしてしまうと、キャンセル済みの
      // 予約が受け渡し完了扱いになってしまうため、絶対にここを通さない。
      // メッセージは本番Backend(main.pyのverify_qr)と同じ文言にして、
      // StaffVerify.jsxが本番/DEMO_MODEを区別せずcancelledを判定できる
      // ようにする。
      if (entry.status !== "pending") {
        const err = new Error(
          entry.status === "cancelled"
            ? "Reservation is cancelled"
            : "Reservation is already completed",
        );
        err.status = 409;
        throw err;
      }
      entry.status = "completed";
      map[entry.id] = entry;
      sessionStorage.setItem("demo_reservations", JSON.stringify(map));
      const { access_token: _accessToken, ...response } = entry;
      return response;
    } catch (e) {
      if (e && typeof e.status === "number") throw e;
      const err = new Error("Failed to verify QR token");
      err.status = 502;
      throw err;
    }
  }

  return await request(`/qr/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Staff-Token": staffToken,
    },
    body: JSON.stringify({ qr_token: qrToken }),
  });
}

// スタッフ用の予約確認(読み取り専用)。X-Reservation-Tokenは使わず、
// X-Staff-Tokenのみで認可する。access_token・qr_tokenはBackend/DEMO_MODE
// どちらの応答にも含めない。
export async function getStaffReservation(reservationId, staffToken) {
  if (DEMO_MODE) {
    // Demo mode: verifyQr()と同じく、STAFF_API_TOKENの実体が無いので
    // 非空であれば受理する。
    if (!staffToken) {
      const err = new Error("Invalid staff token");
      err.status = 401;
      throw err;
    }
    try {
      const raw = sessionStorage.getItem("demo_reservations") || "{}";
      const map = JSON.parse(raw);
      const entry = map[reservationId];
      if (!entry) {
        const err = new Error("Reservation not found");
        err.status = 404;
        throw err;
      }
      const items = await getItems();
      const found = (items || []).find((it) => String(it.id) === String(entry.item_id));
      // 本番のStaffReservationResponseと同じ項目だけを返す。access_tokenと
      // qr_token(受取完了に使う秘密情報)は絶対に含めない。
      return {
        id: entry.id,
        item_id: entry.item_id,
        item_title: found?.title || null,
        user_name: entry.user_name,
        status: entry.status,
        requested_at: entry.requested_at ?? null,
        reserved_at: entry.reserved_at ?? null,
        payment_method: entry.payment_method ?? null,
        payment_status: entry.payment_status ?? null,
        pickup_window_start: entry.pickup_window_start ?? null,
        pickup_window_end: entry.pickup_window_end ?? null,
      };
    } catch (e) {
      if (e && typeof e.status === "number") throw e;
      const err = new Error("Failed to fetch reservation");
      err.status = 502;
      throw err;
    }
  }

  return await request(`/staff/reservations/${encodeURIComponent(reservationId)}`, {
    method: "GET",
    headers: { "X-Staff-Token": staffToken },
  });
}

// 予約IDが分からない顧客(曖昧な失敗で予約IDを受け取れなかった場合など)を、
// スタッフが氏名の部分一致で探せるようにする読み取り専用検索(一括修正U7)。
// 他の利用者の予約を不用意に一覧化しないよう、Backend側で最大件数・最小
// 検索文字数を制限している(main.pyのSTAFF_SEARCH_MAX_RESULTS/
// STAFF_SEARCH_MIN_QUERY_LENGTH)。
export async function searchStaffReservations(userName, staffToken) {
  if (DEMO_MODE) {
    if (!staffToken) {
      const err = new Error("Invalid staff token");
      err.status = 401;
      throw err;
    }
    const trimmed = (userName || "").trim();
    if (trimmed.length < 2) {
      const err = new Error("user_name must be at least 2 characters");
      err.status = 422;
      throw err;
    }
    try {
      const raw = sessionStorage.getItem("demo_reservations") || "{}";
      const map = JSON.parse(raw);
      const items = await getItems();
      const needle = trimmed.toLowerCase();
      return Object.values(map)
        .filter((entry) => (entry.user_name || "").toLowerCase().includes(needle))
        .sort((a, b) => new Date(b.reserved_at) - new Date(a.reserved_at))
        .slice(0, 20)
        .map((entry) => {
          const found = items.find((it) => String(it.id) === String(entry.item_id));
          return {
            id: entry.id,
            item_id: entry.item_id,
            item_title: found?.title || null,
            user_name: entry.user_name,
            status: entry.status,
            requested_at: entry.requested_at ?? null,
            reserved_at: entry.reserved_at ?? null,
            payment_method: entry.payment_method ?? null,
            payment_status: entry.payment_status ?? null,
            pickup_window_start: entry.pickup_window_start ?? null,
            pickup_window_end: entry.pickup_window_end ?? null,
          };
        });
    } catch (e) {
      if (e && typeof e.status === "number") throw e;
      const err = new Error("Failed to search reservations");
      err.status = 502;
      throw err;
    }
  }

  // PMレビューm-3: 顧客の氏名がURL・アクセスログに残らないよう、GETの
  // クエリパラメータではなくPOST + JSON bodyで送る。
  return await request("/staff/reservations-search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Staff-Token": staffToken,
    },
    body: JSON.stringify({ user_name: userName }),
  });
}

export default {
  getItems,
  createReservation,
  getReservation,
  cancelReservation,
  analyzeRoute,
  verifyQr,
  getStaffReservation,
  searchStaffReservations,
};
