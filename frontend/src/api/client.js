const BASE = import.meta.env.VITE_API_BASE_URL || "";

async function request(path, options = {}) {
  const url = BASE ? `${BASE}${path}` : null;

  if (!url) {
    throw new Error("NO_API_BASE");
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
    const msg = json?.detail || json?.message || `HTTP ${res.status}`;
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
    },
    {
      id: "log-experience-001",
      title: "丸太の玉切り体験",
      type: "experience",
      price: 1500,
      stock: 8,
      location_name: "道の駅 ロック・ガーデンひちそう",
    },
  ];
}

export async function getItems() {
  if (!BASE) {
    await new Promise((r) => setTimeout(r, 200));
    return demoGetItems();
  }
  return await request(`/items`, { method: "GET" });
}

export async function createReservation({ item_id, user_name, requested_at = null }) {
  if (!BASE) {
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
    sessionStorage.setItem(`traildrop_demo_reservation_${id}`, JSON.stringify(reservation));
    return reservation;
  }
  return await request(`/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_id, user_name, requested_at }),
  });
}

export async function getReservation(reservationId, reservationToken) {
  if (!BASE) {
    const stored = sessionStorage.getItem(`traildrop_demo_reservation_${reservationId}`);
    if (stored) {
      const reservation = JSON.parse(stored);
      const { access_token: _accessToken, ...response } = reservation;
      return response;
    }
    const now = new Date().toISOString();
    return {
      id: reservationId,
      item_id: "wood-001",
      user_name: "(demo)",
      qr_token: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `qr-${Date.now()}`,
      status: "pending",
      requested_at: null,
      reserved_at: now,
    };
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

export default { getItems, createReservation, getReservation };
