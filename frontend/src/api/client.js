const BASE = import.meta.env.VITE_API_BASE_URL || "";
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
const ROUTE_ANALYSIS_CLIENT_KEY = import.meta.env.VITE_ROUTE_ANALYSIS_CLIENT_KEY || "";

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

async function request(path, options = {}) {
  const url = BASE ? `${BASE}${path}` : null;

  if (!url) {
    throw new Error("VITE_API_BASE_URL is not configured");
  }

  const res = await fetch(url, options);
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
    body: JSON.stringify({ item_id, user_name, requested_at, payment_method }),
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
      // Previously the check skipped validation when reservationToken was missing,
      // allowing anonymous access to demo reservations. Enforce presence and match.
      if (!reservationToken || res.access_token !== reservationToken) {
        const err = new Error("Invalid reservation token");
        err.status = 401;
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

export async function analyzeRoute({ origin, destination, departure_at }) {
  return await request(`/routes/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Key": ROUTE_ANALYSIS_CLIENT_KEY,
    },
    body: JSON.stringify({ origin, destination, departure_at }),
  });
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
// X-Staff-Tokenのみで認可する。access_tokenはBackend/DEMO_MODEどちらの
// 応答にも含めない。
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
      const { access_token: _accessToken, ...response } = entry;
      return { ...response, item_title: found?.title || null };
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

export default {
  getItems,
  createReservation,
  getReservation,
  cancelReservation,
  analyzeRoute,
  verifyQr,
  getStaffReservation,
};
