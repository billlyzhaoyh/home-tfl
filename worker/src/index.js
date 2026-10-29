// Sync API for home-tfl: one household, one shared key.
//
// POST /sync  { since, trips: [{ id, data, updatedAt, deleted }], settings?: { data, updatedAt } }
//   -> { cursor, trips: [{ id, data, updatedAt, deleted }], settings: { data, updatedAt } | null }
//
// Trips and settings are stored as JSON blobs, so the app can add fields without migrations.
// Each write carries the phone's updatedAt and the newest one wins. Pulls use the server's
// clock (synced_at) as the cursor, so a phone with a wrong clock can't miss updates.

const MAX_BODY = 1024 * 1024;
const MAX_TRIPS = 2000;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });

    const url = new URL(request.url);
    if (url.pathname !== "/sync" || request.method !== "POST") return json({ error: "not found" }, 404, cors);
    if (!authorised(request, env)) return json({ error: "unauthorised" }, 401, cors);

    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return json({ error: "too large" }, 413, cors);
      body = JSON.parse(text);
    } catch (e) {
      return json({ error: "bad json" }, 400, cors);
    }
    const problem = invalid(body);
    if (problem) return json({ error: problem }, 400, cors);

    // Push: upsert rows that are newer than what's stored.
    const now = Date.now();
    const writes = body.trips.map((t) => env.DB.prepare(
      `INSERT INTO trips (id, data, updated_at, synced_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
         synced_at = excluded.synced_at, deleted = excluded.deleted
       WHERE excluded.updated_at > trips.updated_at`
    ).bind(t.id, JSON.stringify(t.data ?? null), t.updatedAt, now, t.deleted ? 1 : 0));
    if (body.settings) writes.push(env.DB.prepare(
      `INSERT INTO settings (id, data, updated_at, synced_at) VALUES (1, ?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
         synced_at = excluded.synced_at
       WHERE excluded.updated_at > settings.updated_at`
    ).bind(JSON.stringify(body.settings.data), body.settings.updatedAt, now));
    if (writes.length) await env.DB.batch(writes);

    // Pull: everything stored since the phone's last cursor, plus the current settings.
    const [trips, settings] = await env.DB.batch([
      env.DB.prepare("SELECT id, data, updated_at, deleted FROM trips WHERE synced_at > ?1 ORDER BY synced_at").bind(body.since || 0),
      env.DB.prepare("SELECT data, updated_at FROM settings WHERE id = 1")
    ]);
    const s = settings.results[0];
    return json({
      cursor: now,
      trips: trips.results.map((r) => ({ id: r.id, data: JSON.parse(r.data), updatedAt: r.updated_at, deleted: Boolean(r.deleted) })),
      settings: s ? { data: JSON.parse(s.data), updatedAt: s.updated_at } : null
    }, 200, cors);
  }
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

// Constant-time comparison of the bearer token with the HOUSEHOLD_KEY secret.
function authorised(request, env) {
  const got = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const want = env.HOUSEHOLD_KEY || "";
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function invalid(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "body must be an object";
  if (b.since != null && !(Number.isFinite(b.since) && b.since >= 0)) return "since must be a timestamp";
  if (!Array.isArray(b.trips) || b.trips.length > MAX_TRIPS) return `trips must be an array of at most ${MAX_TRIPS}`;
  for (const t of b.trips) {
    if (!t || typeof t.id !== "string" || !t.id || t.id.length > 100) return "each trip needs an id";
    if (!Number.isFinite(t.updatedAt)) return "each trip needs updatedAt";
    if (t.data != null && typeof t.data !== "object") return "trip data must be an object";
  }
  if (b.settings != null) {
    if (typeof b.settings.data !== "object" || b.settings.data === null) return "settings data must be an object";
    if (!Number.isFinite(b.settings.updatedAt)) return "settings need updatedAt";
  }
  return null;
}

function json(value, status, cors) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(cors || {}) }
  });
}
