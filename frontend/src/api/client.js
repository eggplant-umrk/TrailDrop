const BASE = import.meta.env.VITE_API_BASE_URL || "";
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
const ROUTE_ANALYSIS_CLIENT_KEY = import.meta.env.VITE_ROUTE_ANALYSIS_CLIENT_KEY || "";

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

export async function createReservation({ item_id, user_name, requested_at = null }) {
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
    body: JSON.stringify({ item_id, user_name, requested_at }),
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
      if (entry.status === "completed") {
        const err = new Error("Reservation is already completed");
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

export default { getItems, createReservation, getReservation, analyzeRoute, verifyQr };
