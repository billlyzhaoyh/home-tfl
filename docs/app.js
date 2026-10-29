"use strict";

// ---------- storage ----------
// Every github.io project of this user shares one origin, so keys are namespaced.
const NS = "hometfl.";
const store = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(NS + k); } catch (e) {} },
  keys() { try { return Object.keys(localStorage).filter((k) => k.startsWith(NS)); } catch (e) { return []; } }
};

const PEOPLE = ["a", "b"];
const MODES = [
  { id: "tube", label: "Tube", c: "#0098D4" },
  { id: "elizabeth-line", label: "Elizabeth line", c: "#6950A1" },
  { id: "overground", label: "Overground", c: "#FA7B05" },
  { id: "dlr", label: "DLR", c: "#00A4A7" },
  { id: "bus", label: "Bus", c: "#DC241F" },
  { id: "national-rail", label: "National Rail", c: "#8b9096" },
  { id: "tram", label: "Tram", c: "#84B817" }
];
const PREFS = [["leasttime", "Fastest"], ["leastinterchange", "Fewest changes"], ["leastwalking", "Least walking"]];

function normaliseSettings(s = {}) {
  return {
    names: { a: "", b: "", ...s.names },
    home: s.home || "",
    office: { a: "", b: "", ...s.office },
    modes: Array.isArray(s.modes) && s.modes.length ? s.modes : ["tube", "elizabeth-line", "dlr", "overground"],
    pref: s.pref || "leasttime",
    // Extra routes to plan on every Check: change at a station, optionally onto one mode.
    routes: { a: [], b: [], ...s.routes },
    key: s.key || "",
    updatedAt: s.updatedAt || 0
  };
}

let settings = normaliseSettings(store.get("settings", {}));
let device = { self: "a", theme: "system", onboarded: false, ...store.get("device", {}) };
const saveSettings = () => { settings.updatedAt = Date.now(); store.set("settings", settings); queueSync(); };
const saveDevice = () => store.set("device", device);

// Trips are identified by person + start time, and carry an edit time for sync.
// Older trips predate these fields, so fill them in once.
const tripId = (t) => `${t.who}-${t.start}`;
(function migrateLog() {
  const log = store.get("log", []);
  let changed = false;
  log.forEach((t) => {
    if (!t.id) { t.id = tripId(t); changed = true; }
    if (!t.updatedAt) { t.updatedAt = t.end || t.start; changed = true; }
  });
  if (changed) store.set("log", log);
})();

// Every change to the trip log goes through saveLog so the changed ids are queued for sync.
// Deleted trips leave a tombstone until the server has it.
function saveLog(log, changedIds = [], deletedIds = []) {
  store.set("log", log);
  if (deletedIds.length) {
    const tombs = store.get("tombstones", {});
    deletedIds.forEach((id) => (tombs[id] = Date.now()));
    store.set("tombstones", tombs);
  }
  const ids = [...changedIds, ...deletedIds];
  if (ids.length) { store.set("outbox", [...new Set([...store.get("outbox", []), ...ids])]); queueSync(); }
}

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const MIN = 60000;

// ?now=08:05 fakes the clock (for testing the time-of-day direction default).
const CLOCK_OFFSET = (() => {
  const m = new URLSearchParams(location.search).get("now")?.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const d = new Date(); d.setHours(+m[1], +m[2], 0, 0);
  return d.getTime() - Date.now();
})();
const nowMs = () => Date.now() + CLOCK_OFFSET;
const now = () => new Date(nowMs());
const hm = (d) => pad(d.getHours()) + ":" + pad(d.getMinutes());
const hhmm = (iso) => (iso || "").slice(11, 16);
const minsUntil = (d) => Math.round((new Date(d) - now()) / MIN);
const relMins = (m) => m <= 0 ? (m >= -1 ? "now" : `${-m} min ago`) : m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;

const name = (p) => settings.names[p] || (p === device.self ? "Me" : "Partner");
const other = (p) => (p === "a" ? "b" : "a");
const placeLabel = (dir) => (dir === "work" ? "office" : "home");
const configured = () => Boolean(settings.home && settings.office[device.self]);

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 1800);
}

// ---------- sync (Cloudflare Worker + D1) ----------
// The phone's storage stays the working copy; the Worker holds the shared copy for both
// phones. Syncing talks only to the Worker: on open, a couple of seconds after a change,
// and on "Sync now". Failed syncs keep their changes queued for next time.
let syncing = false, syncTimer = null;
const syncOn = () => Boolean(device.sync?.url && device.sync?.key);
function queueSync() {
  if (!syncOn()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 2000);
}
function connectSync(url, key) {
  device.sync = { url: url.trim().replace(/\/+$/, ""), key: key.trim(), cursor: 0, firstSync: true };
  saveDevice();
  // Upload everything already on this phone the first time.
  store.set("outbox", [...new Set([...store.get("outbox", []), ...store.get("log", []).map((t) => t.id)])]);
}

async function sync() {
  if (!syncOn() || syncing) return;
  syncing = true; renderSyncStatus();
  const s = device.sync;
  const outbox = store.get("outbox", []), tombs = store.get("tombstones", {});
  const byId = new Map(store.get("log", []).map((t) => [t.id, t]));
  const sent = new Map(); // id -> updatedAt we sent, to know what's still pending afterwards
  const trips = outbox.map((id) => {
    const t = byId.get(id);
    const row = t ? { id, data: t, updatedAt: t.updatedAt } : { id, data: null, deleted: true, updatedAt: tombs[id] || Date.now() };
    sent.set(id, row.updatedAt);
    return row;
  });
  // On a phone's first sync the server's settings win; after that, local edits are pushed.
  const { key: _tflKey, ...shared } = settings;
  const pushSettings = !s.firstSync && settings.updatedAt > (s.settingsPushed || 0);
  try {
    const res = await fetch(s.url + "/sync", {
      method: "POST",
      headers: { Authorization: "Bearer " + s.key, "Content-Type": "application/json" },
      body: JSON.stringify({ since: s.cursor || 0, trips, settings: pushSettings ? { data: shared, updatedAt: settings.updatedAt } : undefined })
    });
    if (res.status === 401) throw new Error("the household key was rejected");
    if (!res.ok) throw new Error("the sync server returned " + res.status);
    const reply = await res.json();
    const settingsChanged = mergeRemote(reply, s.firstSync);
    // Keep anything that changed again while the request was in flight.
    const now = new Map(store.get("log", []).map((t) => [t.id, t.updatedAt]));
    store.set("outbox", store.get("outbox", []).filter((id) => !sent.has(id) || (now.has(id) && now.get(id) !== sent.get(id))));
    const left = store.get("tombstones", {});
    sent.forEach((_, id) => delete left[id]);
    store.set("tombstones", left);
    if (pushSettings) s.settingsPushed = settings.updatedAt;
    if (s.firstSync && !reply.settings) s.settingsPushed = 0; // server had none: upload ours next time
    const pushNext = s.firstSync && !reply.settings;
    Object.assign(s, { cursor: reply.cursor, lastOk: Date.now(), lastError: "", firstSync: false });
    if (pushNext) {
      if (!settings.updatedAt) { settings.updatedAt = Date.now(); store.set("settings", settings); }
      queueSync();
    }
    if (settingsChanged && !PEOPLE.includes(state.who)) state.who = device.self;
  } catch (e) {
    s.lastError = /fetch|network|load failed/i.test(e.message) ? "can't reach the sync server" : e.message;
  } finally {
    saveDevice(); syncing = false;
    renderSyncStatus(); refreshAfterSync();
  }
}

// Newer wins for each trip; a remote delete removes a trip unless it was edited here since.
// Returns true if the shared settings changed.
function mergeRemote(reply, first) {
  const log = store.get("log", []);
  const byId = new Map(log.map((t) => [t.id, t]));
  let changed = false;
  for (const t of reply.trips || []) {
    const mine = byId.get(t.id);
    if (t.deleted) {
      if (mine && (mine.updatedAt || 0) <= t.updatedAt) { byId.delete(t.id); changed = true; }
    } else if (t.data && (!mine || (mine.updatedAt || 0) < t.updatedAt)) {
      byId.set(t.id, t.data); changed = true;
    }
  }
  if (changed) store.set("log", [...byId.values()].sort((a, b) => b.start - a.start).slice(0, 2000));
  const r = reply.settings;
  if (r && (first || r.updatedAt > (settings.updatedAt || 0))) {
    settings = normaliseSettings({ ...r.data, key: settings.key, updatedAt: r.updatedAt });
    store.set("settings", settings);
    device.sync.settingsPushed = r.updatedAt;
    return true;
  }
  return false;
}

function renderSyncStatus() {
  const el = $("syncStatus");
  if (!el) return;
  const s = device.sync || {};
  $("syncNow").disabled = !syncOn() || syncing;
  $("syncDisconnect").classList.toggle("hidden", !syncOn());
  $("setupIntro").textContent = syncOn()
    ? "Kept on this phone and synced to your own Cloudflare database, shared with your partner's phone. The site's code is public; your addresses go only to TfL (for journeys) and your sync server."
    : "Saved only in this browser. The site's code is public, but your addresses never leave your phone except in requests to TfL.";
  if (!syncOn()) { el.textContent = "Not connected — trips and settings are only on this phone."; return; }
  const waiting = store.get("outbox", []).length;
  const when = s.lastOk ? new Date(s.lastOk).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "not yet";
  el.innerHTML = syncing ? "Syncing…"
    : s.lastError ? `<span class="stale-note">Couldn't sync: ${esc(s.lastError)}.</span> ${waiting ? `${waiting} change${waiting > 1 ? "s" : ""} will go up next time.` : ""}`
    : `Synced ${esc(when)} · ${store.get("log", []).length} trips shared across both phones.`;
}
// Show what arrived, without clobbering a Setup field someone is typing in.
function refreshAfterSync() {
  const tab = currentTab();
  if (tab === "today") renderToday();
  if (tab === "trips") renderTrips();
  if (tab === "setup" && !document.activeElement?.matches("input, select")) renderSetup();
  renderHeader();
}

// ---------- TfL ----------
const RAIL = new Set(["tube", "elizabeth-line", "dlr", "overground", "national-rail", "tram"]);
const LINE_COLOURS = {
  bakerloo: "#B36305", central: "#E32017", circle: "#FFD300", district: "#00782A",
  "hammersmith-city": "#F3A9BB", jubilee: "#A0A5A9", metropolitan: "#9B0056", northern: "#000000",
  piccadilly: "#003688", victoria: "#0098D4", "waterloo-city": "#95CDBA", elizabeth: "#6950A1",
  dlr: "#00A4A7", liberty: "#5D6061", lioness: "#FAA61A", mildmay: "#0077AD", suffragette: "#5BB972",
  weaver: "#823A62", windrush: "#ED1B00", tram: "#84B817"
};
const STATUS_MODES = "tube,elizabeth-line,dlr,overground,tram";

async function tfl(path, params = {}) {
  const url = new URL("https://api.tfl.gov.uk" + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  if (settings.key) url.searchParams.set("app_key", settings.key);
  const res = await fetch(url);
  if (res.status === 300) { const e = new Error("ambiguous"); e.code = 300; e.body = await res.json().catch(() => ({})); throw e; }
  if (!res.ok) throw new Error("TfL returned " + res.status);
  return res.json();
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("no geolocation"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(p.coords.latitude.toFixed(5) + "," + p.coords.longitude.toFixed(5)),
      reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

// ---------- live train analysis ----------
const norm = (s) => String(s || "").toLowerCase()
  .replace(/\b(underground|rail|dlr|overground|elizabeth line)\b/g, "")
  .replace(/\bstation\b/g, "").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

// The journey planner calls about half the trains from Hammersmith (H&C) "circle", but the
// arrivals feed tags them all "hammersmith-city" (Circle ones say towards "Circle Line"), so
// the two lines are matched as one service.
const SAME_SERVICE = { circle: ["circle", "hammersmith-city"], "hammersmith-city": ["hammersmith-city", "circle"] };
const servesLeg = (a, leg) => !leg.line || (SAME_SERVICE[leg.line] || [leg.line]).includes(a.lineId);
const serviceName = (leg) => (SAME_SERVICE[leg.line] ? "H&C and Circle" : leg.name || legName(leg));

// Pick the arrivals for this leg's direction. Trains are grouped by direction
// ("Eastbound - Platform 2" -> "Eastbound") so a terminus with several platforms reads as
// one list. Trains terminating here are dropped (at a terminus TfL lists them with both
// destination and "towards" set to this station), as are duplicate listings of one train.
// Keeps directions where at least one train heads to the leg's listed destinations,
// falling back to every direction.
function pickArrivals(arrivals, leg) {
  const here = norm(leg.from);
  const isHere = (s) => { const n = norm(s); return !n || here.startsWith(n) || n.startsWith(here); };
  const groupOf = (a) => (a.platformName || "?").split(" - ")[0].trim();
  const seen = new Set();
  const departing = arrivals
    .filter((a) => servesLeg(a, leg) && !(isHere(a.destinationName) && isHere(a.towards)))
    .sort((a, b) => a.timeToStation - b.timeToStation)
    .filter((a) => {
      const k = [groupOf(a), a.vehicleId || a.id, Math.round(a.timeToStation / 60)].join("|");
      return !seen.has(k) && seen.add(k);
    });
  const dirs = leg.directions.map(norm).filter(Boolean);
  const byGroup = {};
  departing.forEach((a) => (byGroup[groupOf(a)] ||= []).push(a));
  const matches = (a) => dirs.some((d) => {
    const dest = norm(a.destinationName), tow = norm(a.towards);
    return (dest && (dest.includes(d) || d.includes(dest))) || (tow && tow.includes(d));
  });
  let groups = Object.entries(byGroup).filter(([, list]) => list.some(matches));
  const matched = groups.length > 0;
  if (!matched) groups = Object.entries(byGroup);
  return {
    matched,
    platforms: groups.slice(0, 2).map(([name, list]) => ({ name, trains: list.slice(0, 4) }))
  };
}

// Turn the next few arrival times (seconds) into a plain-English note.
function analyseGaps(seconds) {
  const mins = seconds.slice(0, 4).map((s) => s / 60);
  if (!mins.length) return { level: "warn", note: "No live trains shown — could be a problem on the line." };
  const gaps = mins.slice(1).map((m, i) => m - mins[i]);
  const first = mins[0];
  // "normal" spacing = the gaps after the next one (so a single big gap doesn't hide itself)
  const rest = gaps.slice(1).sort((a, b) => a - b);
  const typical = rest.length ? rest[Math.floor(rest.length / 2)] : 3;
  if (first >= 8 && gaps[0] !== undefined && gaps[0] <= 3)
    return { level: "warn", note: `Long ${Math.round(first)} min wait, but the next train is only ${Math.round(gaps[0])} min behind — let the first one go if it's packed.` };
  if (first >= 8)
    return { level: "bad", note: `Long ${Math.round(first)} min wait — the platform will be filling up. Worth checking another route.` };
  if (gaps[0] !== undefined && gaps[0] >= Math.max(6, 2 * typical))
    return { level: "warn", note: `Big gap after the next train (${Math.round(gaps[0])} min) — catch this one if you can.` };
  if (gaps.some((g) => g >= 8))
    return { level: "warn", note: "Uneven service — gaps of 8+ min further down the line." };
  return { level: "ok", note: "Trains running normally." };
}

// TfL's value is a fraction of the busiest the station has been since July 2019 (not of a
// normal day). TfL's own bands: quiet below 0.4, busy to 0.7, very busy above.
function crowdLabel(v) {
  if (v == null) return null;
  const lvl = v < 0.4 ? ["ok", "quiet"] : v < 0.7 ? ["warn", "busy"] : ["bad", "very busy"];
  return { pct: Math.round(v * 100), level: lvl[0], text: lvl[1] };
}

// ---------- direction ----------
// Mornings default to the office, afternoons to home; the swap button flips it.
const autoDir = () => (now().getHours() < 13 ? "work" : "home");

// ---------- view state ----------
const state = { who: device.self, dir: null, fromHere: false, sel: 0, busy: false, liveBusy: false, othersOpen: false, error: "" };
const dir = () => state.dir || autoDir();
const cacheKey = (who, d) => `cache.${who}.${d}`;

function endpoints(who, d) {
  return d === "work"
    ? { from: settings.home, to: settings.office[who], fromName: "home" }
    : { from: settings.office[who], to: settings.home, fromName: "office" };
}

function journeyParams() {
  const at = now();
  return {
    mode: [...settings.modes, "walking"].join(","),
    journeyPreference: settings.pref,
    date: `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`,
    time: pad(at.getHours()) + pad(at.getMinutes()),
    timeIs: "Departing"
  };
}

// Keep only what the UI needs so the cache stays small.
function slim(j) {
  return {
    start: j.startDateTime, end: j.arrivalDateTime, duration: j.duration,
    legs: j.legs.map((l) => {
      const o = l.routeOptions?.[0] || {};
      return {
        mode: l.mode?.id, duration: l.duration, dep: l.departureTime,
        line: o.lineIdentifier?.id || "", name: o.name || "",
        directions: (l.routeOptions || []).flatMap((r) => r.directions || []),
        from: l.departurePoint?.commonName || "", naptan: l.departurePoint?.naptanId || ""
      };
    })
  };
}
function rank(journeys, limit = 4) {
  // Earliest arrival first.
  return journeys.slice().sort((a, b) => a.end.localeCompare(b.end) || a.duration - b.duration).slice(0, limit);
}
const firstRail = (j) => j.legs.find((l) => RAIL.has(l.mode) && l.naptan);
// Boarding and interchange points: where you wait on a platform.
const railLegs = (j) => j.legs.filter((l) => RAIL.has(l.mode) && l.naptan);

// ---------- typical busyness ----------
// TfL publishes an average week per station in 15-minute bands. It barely changes, so each
// station is fetched once on a Check and cached for 30 days. Tube and Elizabeth line only;
// some stations have no data.
// TfL's values are fractions of the station's all-time busiest moment, so an average week
// rarely tops 0.4 and TfL's live bands would call nearly everything quiet. Instead each band
// is compared with that station's own busiest band of the week: how close to its rush hour.
const DAY_KEYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const PROFILE_TTL = 30 * 24 * 60 * MIN;
let profiles = store.get("profiles", {});

async function loadProfiles(naptans) {
  // Stations without data are retried after a week rather than a month.
  const fresh = (p) => p && "peak" in p && Date.now() - p.at < (p.days ? PROFILE_TTL : PROFILE_TTL / 4);
  const need = [...new Set(naptans)].filter((n) => !fresh(profiles[n]));
  if (!need.length) return;
  await Promise.all(need.map(async (n) => {
    try {
      let d = await tfl(`/crowding/${n}`);
      // Big rail stations have several IDs (Paddington: 910GPADTON for planning, 910GPADTLL
      // for crowding). If one has no profile, try its siblings in the same hub. Tube stations
      // in a hub can be separate buildings (Hammersmith), so they're left alone.
      if (!d.isFound && n.startsWith("910G")) {
        const stop = await tfl(`/StopPoint/${n}`);
        const hub = stop.hubNaptanCode && await tfl(`/StopPoint/${stop.hubNaptanCode}`);
        const siblings = (hub?.children || []).filter((c) => c.id !== n && /Naptan(Metro|Rail)Station/.test(c.stopType) &&
          (c.modes || []).some((m) => (stop.modes || []).includes(m)));
        for (const c of siblings) {
          const alt = await tfl(`/crowding/${c.id}`).catch(() => null);
          if (alt?.isFound) { d = alt; break; }
        }
      }
      const days = {};
      (d.daysOfWeek || []).forEach((day) => {
        const bands = new Array(96).fill(null);
        (day.timeBands || []).forEach((t) => {
          const [h, m] = t.timeBand.slice(0, 5).split(":").map(Number);
          bands[(h * 60 + m) / 15] = Math.round(t.percentageOfBaseLine * 100) / 100;
        });
        days[day.dayOfWeek] = bands;
      });
      const peak = Math.max(0, ...Object.values(days).flat().filter((v) => v != null));
      profiles[n] = { at: Date.now(), peak, days: d.isFound && peak > 0 ? days : null };
    } catch (e) { /* try again on the next Check */ }
  }));
  store.set("profiles", profiles);
}

// How busy a station typically is (0–1 of its weekly peak) in the 15-minute band
// containing `iso`, shifted by `offset` bands.
function typicalAt(naptan, iso, offset = 0) {
  const p = profiles[naptan];
  if (!p?.days || !p.peak) return null;
  const d = new Date(new Date(iso).getTime() + offset * 15 * MIN);
  const v = p.days[DAY_KEYS[d.getDay()]]?.[Math.floor((d.getHours() * 60 + d.getMinutes()) / 15)];
  return v == null ? null : v / p.peak;
}
function typicalLabel(r) {
  const lvl = r < 0.5 ? ["ok", "quiet"] : r < 0.8 ? ["warn", "busy"] : ["bad", "peak"];
  return { level: lvl[0], text: lvl[1] };
}
// The busiest platform you'll wait on for this journey: { v, leg }, or null without data.
function peakBusyness(j) {
  return railLegs(j).map((leg) => ({ v: typicalAt(leg.naptan, leg.dep), leg }))
    .filter((x) => x.v != null).sort((a, b) => b.v - a.v)[0] || null;
}
const busyPhrase = (r) => (typicalLabel(r).text === "peak" ? "at its peak" : "usually " + typicalLabel(r).text);
const liveKey = (leg) => leg.naptan + "|" + leg.line;
// Live trains only matter close to departure; skip them for a plan an hour out.
const dueSoon = (leg) => { const m = minsUntil(leg.dep); return m >= -2 && m <= 30; };
// "Hammersmith (Dist&Picc Line) Underground Station" -> "Hammersmith"; the line is named separately.
const stationName = (s) => String(s || "").replace(/ (Underground|Rail|DLR|Overground) Station$/, "").replace(/ Station$/, "").replace(/\s*\([^)]*\)$/, "");

// Arrivals + crowding once per station, then split per leg (several routes often share a first station).
async function loadLiveFor(legs) {
  const stations = [...new Set(legs.map((l) => l.naptan))];
  const fetched = await Promise.all(stations.map((id) => Promise.allSettled([
    tfl(`/StopPoint/${id}/Arrivals`),
    tfl(`/crowding/${id}/Live`)
  ])));
  const byStation = Object.fromEntries(stations.map((id, i) => [id, fetched[i]]));
  return Object.fromEntries(legs.map((leg) => {
    const [arr, crowd] = byStation[leg.naptan];
    const out = { at: Date.now() };
    if (arr.status === "fulfilled") {
      const picked = pickArrivals(arr.value, leg);
      out.matched = picked.matched;
      out.platforms = picked.platforms.map((p) => ({ name: p.name, times: p.trains.map((t) => t.expectedArrival) }));
    } else out.error = true;
    if (crowd.status === "fulfilled" && crowd.value?.dataAvailable) out.crowd = crowdLabel(crowd.value.percentageOfBaseline);
    return [liveKey(leg), out];
  }));
}

// TfL answers 300 when a place is ambiguous. Retry once with its best match if there is a
// clear one; otherwise report which place it couldn't find.
async function planJourney(from, to, params) {
  const path = (a, b) => `/Journey/JourneyResults/${encodeURIComponent(a)}/to/${encodeURIComponent(b)}`;
  try { return await tfl(path(from, to), params); }
  catch (e) {
    if (e.code !== 300) throw e;
    const pick = (dis, original) => {
      if (!dis || dis.matchStatus === "identified") return original;
      const best = (dis.disambiguationOptions || [])
        .filter((o) => /^-?\d+\.\d+,-?\d+\.\d+$/.test(o.parameterValue || "") && /[a-z]/i.test(o.place?.commonName || ""))
        .sort((a, b) => b.matchQuality - a.matchQuality)[0];
      if (!best) { const err = new Error("ambiguous"); err.code = 300; err.place = original; throw err; }
      return best.parameterValue;
    };
    return tfl(path(pick(e.body.fromLocationDisambiguation, from), pick(e.body.toLocationDisambiguation, to)), params);
  }
}

// ---------- routes to compare ----------
// TfL only suggests a few near-identical options, so people can save routes to try.
// "Via X" is one request with TfL's `via`. "Via X, then <mode>" is planned in two halves
// (to X, then X onward on that mode only), because TfL happily passes through X on the
// same line otherwise. Towards home the halves swap: <mode> to X, then anything home.
const RAIL_MODES = MODES.filter((m) => m.id !== "bus");
const viaLabel = (r) => `via ${r.via.name}${r.then ? " · " + MODES.find((m) => m.id === r.then).label : ""}`;
const tflDate = (iso) => ({ date: iso.slice(0, 10).replace(/-/g, ""), time: iso.slice(11, 13) + iso.slice(14, 16) });

async function planVia(r, from, to, d, params) {
  const path = (a, b) => `/Journey/JourneyResults/${encodeURIComponent(a)}/to/${encodeURIComponent(b)}`;
  const best = (jr) => rank((jr.journeys || []).map(slim))[0];
  if (!r.then) {
    const j = best(await tfl(path(from, to), { ...params, via: r.via.id }));
    return j && { ...j, via: viaLabel(r) };
  }
  const only = { ...params, mode: r.then + ",walking" };
  const [firstParams, secondParams] = d === "work" ? [params, only] : [only, params];
  const j1 = best(await tfl(path(from, r.via.id), firstParams));
  if (!j1) return null;
  const j2 = best(await tfl(path(r.via.id, to), { ...secondParams, ...tflDate(j1.end) }));
  if (!j2) return null;
  return {
    start: j1.start, end: j2.end, duration: Math.round((new Date(j2.end) - new Date(j1.start)) / MIN),
    legs: [...j1.legs, ...j2.legs], via: viaLabel(r)
  };
}

async function searchStations(q) {
  const d = await tfl(`/StopPoint/Search/${encodeURIComponent(q)}`, { modes: RAIL_MODES.map((m) => m.id).join(","), maxResults: 6 });
  return (d.matches || []).map((m) => ({
    id: m.id, name: stationName(m.name), modes: (m.modes || []).filter((x) => RAIL_MODES.some((r) => r.id === x))
  }));
}
// Search returns hubs (e.g. HUBPAD) that group several stations; the journey planner needs
// the station itself, so pick the one serving the chosen mode (the most specific one).
async function resolveStation(match, mode) {
  if (!match.id.startsWith("HUB")) return match.id;
  const hub = await tfl(`/StopPoint/${match.id}`);
  const kids = (hub.children || []).filter((c) => /Naptan(Metro|Rail)Station/.test(c.stopType));
  const serving = kids.filter((c) => (c.modes || []).includes(mode)).sort((a, b) => a.modes.length - b.modes.length);
  return (serving[0] || kids[0] || match).id;
}

// ---------- checking TfL (the only places that fetch) ----------
async function check() {
  if (state.busy) return;
  const who = state.who, d = dir();
  const ends = endpoints(who, d);
  if (!ends.from || !ends.to) { renderToday(); return; }
  state.busy = true; state.error = ""; renderToday();
  try {
    let from = ends.from, fromName = ends.fromName;
    if (state.fromHere) {
      try { from = await getLocation(); fromName = "your location"; }
      catch (e) { toast(`Location unavailable — using ${ends.fromName}`); }
    }
    const params = journeyParams();
    const [jr, ...extra] = await Promise.all([
      planJourney(from, ends.to, params),
      ...(settings.routes[who] || []).map((r) => planVia(r, from, ends.to, d, params).catch(() => null))
    ]);
    // TfL's best few, then one per saved route (skipping any TfL already suggested).
    const suggested = rank((jr.journeys || []).map(slim)).slice(0, 3);
    const same = (x, y) => routeSummary(x) === routeSummary(y) && x.start === y.start;
    const journeys = rank(suggested.concat(extra.filter((x) => x && !suggested.some((y) => same(x, y)))), Infinity);
    const liveLegs = {};
    journeys.forEach((j) => { const l = firstRail(j); if (l && dueSoon(l)) liveLegs[liveKey(l)] = l; });
    const [lines, live] = await Promise.all([
      tfl(`/Line/Mode/${STATUS_MODES}/Status`).catch(() => []),
      loadLiveFor(Object.values(liveLegs)),
      loadProfiles(journeys.flatMap(railLegs).map((l) => l.naptan))
    ]);
    const status = lines.map((l) => {
      const s = l.lineStatuses?.[0] || {};
      return { id: l.id, name: l.name, sev: s.statusSeverity, desc: s.statusSeverityDescription, reason: (s.reason || "").replace(/^.*?:\s*/, "").slice(0, 200) };
    });
    store.set(cacheKey(who, d), { at: nowMs(), fromName, journeys, status, live });
    state.sel = 0;
  } catch (e) {
    state.error = e.code === 300
      ? `TfL doesn't recognise "${e.place || "one of your places"}". Try a nearby postcode or station name in Setup.`
      : "Couldn't reach TfL (" + e.message + "). Your last result is shown below.";
  } finally {
    state.busy = false; renderToday();
  }
}

// Re-fetch just the next trains for the selected route (2 requests).
async function refreshTrains(leg) {
  if (state.liveBusy) return;
  const c = store.get(cacheKey(state.who, dir()), null);
  if (!c) return;
  state.liveBusy = true; renderToday();
  try {
    c.live = { ...c.live, ...(await loadLiveFor([leg])) };
    store.set(cacheKey(state.who, dir()), c);
  } finally { state.liveBusy = false; renderToday(); }
}

// ---------- rendering: shared pieces ----------
function legColour(l) {
  if (l.mode === "bus") return "var(--bus)";
  return LINE_COLOURS[l.line] || (l.mode === "overground" ? "#FA7B05" : "var(--muted)");
}
function legName(l) {
  if (l.mode === "walking") return "Walk";
  if (l.mode === "bus") return l.name || "Bus";
  return (l.name || l.mode).replace(/ line$/i, "");
}
function strip(j, mini = false) {
  return `<div class="strip${mini ? " mini" : ""}" role="img" aria-label="${esc(routeSummary(j))}">` + j.legs.map((l) => {
    const walk = l.mode === "walking";
    const label = mini ? "" : `<span class="name">${esc(legName(l))}<small>${l.duration}m</small></span>`;
    return `<div class="seg-leg${walk ? " walk" : ""}" style="flex:${Math.max(1, l.duration)} 1 0;--c:${legColour(l)}"><span class="bar"></span>${label}</div>`;
  }).join("") + `</div>`;
}
const routeSummary = (j) => j.legs.filter((l) => l.mode !== "walking").map(legName).join(" › ") || "Walk";
const sevClass = (sev) => (sev === 10 || sev == null ? "ok" : sev <= 6 ? "bad" : "warn");

function routeStatus(j, statusById) {
  const seen = new Set();
  return j.legs.filter((l) => RAIL.has(l.mode) && l.line && !seen.has(l.line) && seen.add(l.line)).map((l) => {
    const s = statusById[l.line];
    if (!s) return "";
    const cls = sevClass(s.sev);
    const why = cls !== "ok" && s.reason ? `<span class="why"> — ${esc(s.reason)}</span>` : "";
    return `<li class="fact ${cls}"><span class="dot"></span><span>${esc(s.name)}: ${esc(s.desc)}${why}</span></li>`;
  }).join("");
}

function renderLive(leg, live) {
  const station = esc(stationName(leg.from));
  const fresh = live && Date.now() - live.at < 15 * MIN;
  const m = minsUntil(leg.dep);
  const btn = m > 30 ? "" : `<button class="linkbtn" type="button" data-refresh-trains ${state.liveBusy ? "disabled" : ""}>${state.liveBusy ? "Refreshing…" : "Refresh trains"}</button>`;
  const head = `<div class="live-head"><p class="label">Next ${esc(serviceName(leg))} trains · ${station}</p>${btn}</div>`;
  if (!live || !fresh) {
    const msg = m > 30 ? `Live trains appear 30 min before you leave (${relMins(m)}).` : live ? "Live trains are out of date." : "No live trains loaded.";
    return `<div class="live">${head}<p class="hint">${msg}</p></div>`;
  }
  const crowd = live.crowd ? `<p class="fact ${live.crowd.level} note"><span class="dot"></span><span>${station} is ${live.crowd.text} right now (${live.crowd.pct}% of its busiest)</span></p>` : "";
  if (live.error) return `<div class="live">${head}<p class="hint">Live trains unavailable.</p>${crowd}</div>`;
  const plats = (live.platforms || []).map((p) => {
    const secs = p.times.map((t) => (new Date(t) - Date.now()) / 1000).filter((s) => s > -30);
    if (!secs.length) return "";
    const g = analyseGaps(secs);
    const trains = secs.map((s, i) => `<span class="train${i === 0 ? " first" : ""}">${Math.max(0, Math.round(s / 60))}<small>m</small></span>`).join("");
    const where = live.matched ? "" : `<div class="plat-name">${esc(p.name)}</div>`;
    return `<div class="plat">${where}<div class="trains">${trains}</div><p class="note ${g.level}">${esc(g.note)}</p></div>`;
  }).join("");
  return `<div class="live">${head}${plats || `<p class="note warn">No live trains listed at ${station}.</p>`}${crowd}</div>`;
}

// ---------- rendering: Today ----------
function renderBusyness(j) {
  const legs = railLegs(j);
  if (!legs.length) return "";
  const rows = legs.map((l) => {
    const v = typicalAt(l.naptan, l.dep);
    const name = `<span class="busy-name">${esc(stationName(l.from))}</span><span class="busy-time mono">${hhmm(l.dep)}</span>`;
    const h = ownHistory(l);
    const mine = h ? `<li class="busy-mine"><b>You, around this time:</b> ${ownHistoryText(h)}</li>` : "";
    if (v == null) return `<li class="busy-row">${name}<span class="busy-none">no data</span></li>${mine}`;
    const lvl = typicalLabel(v);
    // An hour either side, one bar per 15 minutes, the band you're there in highlighted.
    const bars = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((o) => {
      const b = typicalAt(l.naptan, l.dep, o);
      const h = b == null ? 0 : Math.max(2, Math.round(b * 22));
      const t = new Date(new Date(l.dep).getTime() + o * 15 * MIN);
      const tip = b == null ? "" : `<title>${hm(t)}: ${typicalLabel(b).text} (${Math.round(b * 100)}% of its usual peak)</title>`;
      return `<rect x="${(o + 4) * 7}" y="${22 - h}" width="5" height="${h}" rx="1.5" class="${o === 0 ? "now " + lvl.level : ""}">${tip}</rect>`;
    }).join("");
    return `<li class="busy-row">${name}<svg class="busy-spark" viewBox="0 0 61 22" role="img" aria-label="Typical busyness an hour either side">${bars}</svg><span class="busy-lvl"><span class="dot ${lvl.level}"></span>${lvl.text}</span></li>${mine}`;
  }).join("");
  // If the busiest stop is usually calmer 15 or 30 min earlier, say so.
  let hint = "";
  const scored = legs.map((l) => ({ l, v: typicalAt(l.naptan, l.dep) })).filter((x) => x.v != null).sort((a, b) => b.v - a.v);
  if (scored.length) {
    const { l, v } = scored[0];
    for (const o of [-1, -2]) {
      const e = typicalAt(l.naptan, l.dep, o);
      if (e != null && typicalLabel(e).text !== typicalLabel(v).text && e < v) {
        hint = `<p class="hint">About ${-o * 15} min earlier, ${esc(stationName(l.from))} is usually ${typicalLabel(e).text}.</p>`;
        break;
      }
    }
  }
  const day = new Date(j.start).toLocaleDateString("en-GB", { weekday: "long" });
  return `<div class="busy"><p class="label" title="Compared with each station's own busiest time of the week">Usual busyness · ${day}s</p><ul class="busy-list">${rows}</ul>${hint}</div>`;
}

function renderHeader() {
  const t = now();
  $("date").textContent = t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
  $("whoSeg").innerHTML = [device.self, other(device.self)].map((p) =>
    `<button type="button" data-who="${p}" class="${p === state.who ? "on" : ""}" aria-pressed="${p === state.who}">${esc(name(p))}</button>`).join("");
}

// The journey as a headline: HOME → OFFICE with the postcodes underneath.
function renderRoute() {
  const d = dir(), ends = endpoints(state.who, d);
  const place = (v) => (/^-?\d+\.\d+,-?\d+\.\d+$/.test(v) ? "Pinned location" : String(v || "Not set").toUpperCase());
  $("routeFrom").textContent = state.fromHere ? "Here" : d === "work" ? "Home" : "Office";
  $("routeFromSub").textContent = state.fromHere ? "Your location" : place(ends.from);
  $("fromBtn").setAttribute("aria-pressed", state.fromHere);
  $("fromBtn").title = state.fromHere ? `Tap to start from ${d === "work" ? "home" : "the office"}` : "Tap to start from your current location";
  $("routeTo").textContent = d === "work" ? "Office" : "Home";
  $("routeToSub").textContent = place(ends.to);
  $("route").classList.toggle("hidden", !configured());
}

function renderStatusline(c) {
  const bits = [];
  if (state.busy) bits.push("Checking TfL…");
  else if (c) {
    const age = Math.round((nowMs() - c.at) / MIN);
    const when = new Date(c.at);
    const day = when.toDateString() === now().toDateString() ? "" : " " + when.toLocaleDateString("en-GB", { weekday: "short" });
    bits.push(`<span class="${age > 15 ? "stale" : ""}">Checked ${hm(when)}${day}${age > 1 && age < 120 ? ` (${age} min ago)` : ""}</span>`);
  } else bits.push("Not checked yet");
  bits.push("Updates only when you tap Check");
  $("statusline").innerHTML = bits.map((b) => `<span>${b}</span>`).join('<span aria-hidden="true">·</span>');
}

function renderToday() {
  renderHeader();
  if (activeTrip()) { showTripView(); return; }
  $("view-trip").classList.add("hidden");
  if (currentTab() === "today") $("view-today").classList.remove("hidden");
  renderRoute();
  const d = dir();
  const c = store.get(cacheKey(state.who, d), null);
  renderStatusline(configured() ? c : null);
  $("checkBtn").disabled = state.busy || !configured();
  $("checkBtn").innerHTML = state.busy ? `<span class="spin" aria-hidden="true"></span>Checking` : "Check now";
  $("leaveBtn").disabled = !configured();
  $("actions").classList.toggle("hidden", !configured());

  if (!configured()) {
    $("board").innerHTML = `<div class="empty"><h2>Set up your commute</h2><p>Add home and office once, and this becomes a one-tap board: when to leave, which line, and how the trains look.</p><a class="btn btn-primary" href="#setup">Get started</a></div>`;
    return;
  }
  const ends = endpoints(state.who, d);
  if (!ends.to) {
    $("board").innerHTML = `<div class="empty"><h2>No office for ${esc(name(state.who))}</h2><p>Add one in Setup to plan this trip.</p><a class="btn" href="#setup">Open Setup</a></div>`;
    return;
  }
  const err = state.error ? `<p class="err small">${esc(state.error)}</p>` : "";
  if (!c) {
    $("board").innerHTML = err + `<div class="empty"><h2>${esc(name(state.who))} → ${placeLabel(d)}</h2><p>Tap <b>Check now</b> to get leave times, line status and the next trains.</p></div>`;
    return;
  }
  if (!c.journeys.length) { $("board").innerHTML = err + `<div class="empty"><h2>No routes found</h2><p>Try different transport modes in Setup.</p></div>`; return; }

  const sel = Math.min(state.sel, c.journeys.length - 1);
  const j = c.journeys[sel];
  const statusById = Object.fromEntries(c.status.map((s) => [s.id, s]));
  const leaveIn = minsUntil(j.start);
  const past = leaveIn < -1;
  const label = "Leave";
  const rail = firstRail(j);
  const routeLines = new Set(c.journeys.flatMap((x) => x.legs.map((l) => l.line)).filter(Boolean));
  const othersBad = c.status.filter((s) => s.sev !== 10 && !routeLines.has(s.id));

  const hero = `<article class="hero${past ? " past" : ""}">
    <p class="label">${label} · from ${esc(c.fromName)}${j.via ? " · " + esc(j.via) : ""}</p>
    <div class="hero-top">
      <div><div class="bigtime">${hhmm(j.start)}</div><div class="sub countdown">${past ? "This time has passed — check again" : relMins(leaveIn)}</div></div>
      <div class="hero-side"><p class="label">Arrive</p><div class="midtime">${hhmm(j.end)}</div><div class="sub">${j.duration} min</div></div>
    </div>
    ${strip(j)}
    <ul class="facts">${routeStatus(j, statusById)}</ul>
    ${renderBusyness(j)}
    ${rail ? renderLive(rail, c.live[liveKey(rail)]) : ""}
  </article>`;

  const alts = c.journeys.length > 1 ? `<div class="alts"><p class="label">Other options</p>` + c.journeys.map((x, i) => {
    if (i === sel) return "";
    // Second line: any disruption on this route's lines, then its busiest stop.
    const lines = [...new Set(railLegs(x).map((l) => l.line))].map((id) => statusById[id]).filter((st) => st && st.sev !== 10);
    const meta = lines.map((st) => `<span><span class="dot ${sevClass(st.sev)}"></span>${esc(st.name)}: ${esc(st.desc)}</span>`);
    if (x.via) meta.unshift(`<span class="alt-via">${esc(x.via)}</span>`);
    const peak = peakBusyness(x);
    const packedAt = railLegs(x).map((l) => ({ l, h: ownHistory(l) })).find(({ h }) => h && h.packed);
    if (packedAt) meta.push(`<span><span class="dot bad"></span>you: packed at ${esc(stationName(packedAt.l.from))} ${packedAt.h.packed}/${packedAt.h.n}</span>`);
    if (peak) meta.push(`<span><span class="dot ${typicalLabel(peak.v).level}"></span>${esc(stationName(peak.leg.from))} ${busyPhrase(peak.v)}</span>`);
    return `<button class="alt" type="button" data-sel="${i}"><span class="t">${hhmm(x.start)}</span>${strip(x, true)}<span class="d">${x.duration}m</span>${meta.length ? `<span class="alt-meta">${meta.join("")}</span>` : ""}</button>`;
  }).join("") + `</div>` : "";

  const others = othersBad.length
    ? `<details class="others"${state.othersOpen ? " open" : ""}><summary>${othersBad.length} other line${othersBad.length > 1 ? "s" : ""} disrupted</summary><ul class="facts">` +
      othersBad.map((s) => `<li class="fact ${sevClass(s.sev)}"><span class="dot"></span><span>${esc(s.name)}: ${esc(s.desc)}</span></li>`).join("") + `</ul></details>`
    : c.status.length ? `<p class="others">Good service on all other lines.</p>` : "";

  $("board").innerHTML = err + hero + alts + others;
}

// ---------- trip tracking (local only, no TfL calls) ----------
let tripTimer = null;
const activeTrip = () => store.get("active", null);

function startTrip() {
  // Ask the browser not to evict our storage (trips live only on this phone).
  navigator.storage?.persist?.().catch(() => {});
  const c = store.get(cacheKey(state.who, dir()), null);
  const j = c?.journeys?.[Math.min(state.sel, (c?.journeys?.length || 1) - 1)];
  store.set("active", { who: state.who, dir: dir(), start: Date.now(), route: j ? routeSummary(j) : "", planned: j?.duration || null, journey: j || null });
  renderToday();
}
function showTripView() {
  const a = activeTrip();
  document.body.classList.add("on-trip");
  $("view-today").classList.add("hidden");
  if (currentTab() === "today") $("view-trip").classList.remove("hidden");
  $("tripLabel").textContent = `On the way · ${name(a.who)} → ${placeLabel(a.dir)}`;
  $("tripMeta").textContent = [`Started ${hm(new Date(a.start))}`, a.planned ? `planned ${a.planned} min` : "", a.route].filter(Boolean).join(" · ");
  $("tripStrip").innerHTML = a.journey ? strip(a.journey) : "";
  clearInterval(tripTimer);
  const tick = () => {
    const s = Math.floor((Date.now() - a.start) / 1000);
    $("tripTimer").textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
    if (a.planned) {
      const frac = s / 60 / a.planned;
      $("tripBar").style.width = Math.min(100, frac * 100) + "%";
      $("tripBar").classList.toggle("over", frac > 1);
    }
  };
  tick(); tripTimer = setInterval(tick, 1000);
}
function endTrip(save) {
  const a = activeTrip(); if (!a) return;
  if (save && Date.now() - a.start < 2 * MIN) { toast("Under 2 min — not logged"); save = false; }
  if (save) {
    const end = Date.now();
    const { journey, ...rest } = a;
    // One entry per train you board, so busyness can be rated (and recalled) per station.
    const legs = journey ? railLegs(journey).map((l) => ({ line: l.line, name: legName(l), from: stationName(l.from), naptan: l.naptan, dep: l.dep })) : [];
    const log = store.get("log", []);
    const trip = { ...rest, id: tripId(a), legs, end, updatedAt: end, mins: Math.max(1, Math.round((end - a.start) / MIN)) };
    log.unshift(trip);
    saveLog(log.slice(0, 2000), [trip.id]);
  }
  store.del("active"); clearInterval(tripTimer);
  document.body.classList.remove("on-trip");
  renderToday();
  if (save) openRating(store.get("log", [])[0].start);
}

// ---------- how busy was it (your own data) ----------
// After a trip, rate each train: seat / standing / packed, and how many you let go.
const CROWD = [["seat", "Got a seat"], ["stand", "Standing"], ["packed", "Packed"]];
const CROWD_WORD = { seat: "seat", stand: "standing", packed: "packed" };
let rating = null; // { start, legs, draft: [{ crowd, skipped }] }

function openRating(start) {
  const t = store.get("log", []).find((x) => x.start === start);
  if (!t) return;
  const legs = t.legs?.length ? t.legs : [{ name: "The trip", ...t.overall }];
  rating = { start, legs, draft: legs.map((l) => ({ crowd: l.crowd || null, skipped: l.skipped ?? null })) };
  $("rateSub").textContent = `${name(t.who)} → ${placeLabel(t.dir)} · ${t.mins} min. Kept on this phone only.`;
  renderRating();
  $("rateSheet").classList.remove("hidden");
}
function renderRating() {
  $("rateLegs").innerHTML = rating.legs.map((l, i) => {
    const d = rating.draft[i];
    return `<div class="rate-leg" data-i="${i}">
      <p class="rate-name"><b>${esc(l.name)}</b>${l.from ? ` from ${esc(l.from)}` : ""}${l.dep ? ` <span class="mono muted">${hhmm(l.dep)}</span>` : ""}</p>
      <div class="seg rate-seg" role="group" aria-label="How busy">${CROWD.map(([v, lbl]) =>
        `<button type="button" data-crowd="${v}" class="${d.crowd === v ? "on" : ""}" aria-pressed="${d.crowd === v}">${lbl}</button>`).join("")}</div>
      <div class="rate-skip"><span class="muted small">Trains you let go</span><div class="seg" role="group" aria-label="Trains you let go">${[0, 1, 2, 3].map((n) =>
        `<button type="button" data-skip="${n}" class="${d.skipped === n ? "on" : ""}" aria-pressed="${d.skipped === n}">${n === 3 ? "3+" : n}</button>`).join("")}</div></div>
    </div>`;
  }).join("");
}
function closeRating() {
  $("rateSheet").classList.add("hidden"); rating = null;
  if (currentTab() === "trips") renderTrips();
}
$("rateLegs").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const d = rating.draft[+b.closest(".rate-leg").dataset.i];
  if (b.dataset.crowd) d.crowd = d.crowd === b.dataset.crowd ? null : b.dataset.crowd;
  if (b.dataset.skip) d.skipped = d.skipped === +b.dataset.skip ? null : +b.dataset.skip;
  renderRating();
};
$("rateSave").onclick = () => {
  const log = store.get("log", []), t = log.find((x) => x.start === rating.start);
  if (t) {
    if (t.legs?.length) t.legs = t.legs.map((l, k) => ({ ...l, ...rating.draft[k] }));
    else t.overall = rating.draft[0];
    t.updatedAt = Date.now();
    saveLog(log, [t.id]);
    toast("Saved");
  }
  closeRating();
};
$("rateSkip").onclick = closeRating;
$("rateSheet").onclick = (e) => { if (e.target === $("rateSheet")) closeRating(); };

const ratedLegs = (t) => (t.legs?.length ? t.legs : t.overall ? [{ name: "Trip", ...t.overall }] : []).filter((l) => l.crowd || l.skipped != null);
const ratingText = (l) => [CROWD_WORD[l.crowd], l.skipped == null ? "" : l.skipped ? `let ${l.skipped === 3 ? "3+" : l.skipped} go` : "first train"].filter(Boolean).join(", ");

// Your ratings for this station and line, on the same kind of day, within ±30 minutes.
function ownHistory(leg) {
  const lines = SAME_SERVICE[leg.line] || [leg.line];
  const at = new Date(leg.dep), mins = (d) => d.getHours() * 60 + d.getMinutes();
  const weekend = (d) => d.getDay() === 0 || d.getDay() === 6;
  const hits = store.get("log", []).flatMap((t) => t.legs || []).filter((x) => {
    if (x.naptan !== leg.naptan || !lines.includes(x.line) || (!x.crowd && x.skipped == null)) return false;
    const d = new Date(x.dep);
    return weekend(d) === weekend(at) && Math.abs(mins(d) - mins(at)) <= 30;
  });
  if (!hits.length) return null;
  const count = (c) => hits.filter((x) => x.crowd === c).length;
  const skips = hits.filter((x) => x.skipped != null);
  return { n: hits.length, packed: count("packed"), stand: count("stand"), seat: count("seat"), avgSkip: skips.length ? skips.reduce((a, x) => a + x.skipped, 0) / skips.length : null };
}
function ownHistoryText(h) {
  const bits = [];
  if (h.packed) bits.push(`packed ${h.packed} of ${h.n}`);
  if (h.stand) bits.push(`standing ${h.stand} of ${h.n}`);
  if (h.seat) bits.push(`seat ${h.seat} of ${h.n}`);
  if (h.avgSkip >= 0.5) bits.push(`usually let ${Math.round(h.avgSkip * 2) / 2} train${h.avgSkip >= 1.5 ? "s" : ""} go`);
  return bits.length ? bits.join(" · ") : `${h.n} trip${h.n > 1 ? "s" : ""}, no trouble boarding`;
}

// ---------- Trips ----------
function sparkline(trips) {
  // Oldest on the left. One bar per trip, dashed line at the average plan.
  const list = trips.slice(0, 20).reverse();
  const W = 300, H = 56, gap = 2;
  const max = Math.max(...list.map((t) => Math.max(t.mins, t.planned || 0))) * 1.1;
  const bw = Math.min(18, (W - gap * (list.length - 1)) / list.length);
  const plans = list.map((t) => t.planned).filter(Boolean);
  const plan = plans.length ? plans.reduce((a, b) => a + b, 0) / plans.length : null;
  const y = (v) => H - (v / max) * H;
  const bars = list.map((t, i) => {
    const x = i * (bw + gap), h = Math.max(4, H - y(t.mins));
    const tip = `${new Date(t.start).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ${t.mins} min${t.planned ? ` (planned ${t.planned})` : ""}`;
    return `<rect class="hit" x="${x - 1}" y="0" width="${bw + 2}" height="${H}" fill="transparent" tabindex="0"><title>${esc(tip)}</title></rect>` +
      `<path class="b${i === list.length - 1 ? " last" : ""}" d="M${x},${H} V${H - h + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${H} Z" pointer-events="none"/>`;
  }).join("");
  const planLine = plan ? `<line class="plan" x1="0" x2="${W}" y1="${y(plan)}" y2="${y(plan)}"/>` : "";
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Last ${list.length} trips in minutes">${bars}${planLine}<line class="base" x1="0" x2="${W}" y1="${H}" y2="${H}"/></svg>`;
}

function renderTrips() {
  const log = store.get("log", []);
  const last = device.backedUp ? new Date(device.backedUp) : null;
  const stale = log.length && (!last || Date.now() - last > 7 * 24 * 60 * MIN);
  $("backupNote").innerHTML = syncOn()
    ? `Trips sync to your Cloudflare database and both phones${device.sync.lastError ? ` — <span class="stale-note">last sync failed (${esc(device.sync.lastError)})</span>` : ""}. A backup file is an optional extra.`
    : `Trips are saved only in this browser on this phone — clearing Safari's website data deletes them. Connect sync in Setup, or back up now and then. ` +
      `<span class="${stale ? "stale-note" : ""}">${last ? `Last backup ${last.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}.` : log.length ? "Not backed up yet." : ""}</span>`;
  if (!log.length) {
    $("tiles").innerHTML = `<div class="empty"><h2>No trips yet</h2><p>Tap <b>Time this trip</b> when you head out and <b>Arrived</b> when you get there. Averages and a chart build up here, on this phone only.</p></div>`;
    $("tripList").innerHTML = ""; return;
  }
  const groups = {};
  log.forEach((t) => (groups[t.who + "|" + t.dir] ||= []).push(t));
  $("tiles").innerHTML = `<div class="tiles">` + Object.entries(groups).map(([k, trips]) => {
    const [who, d] = k.split("|");
    const m = trips.map((t) => t.mins);
    const avg = Math.round(m.reduce((a, b) => a + b, 0) / m.length);
    const withPlan = trips.filter((t) => t.planned);
    const vs = withPlan.length ? Math.round(withPlan.reduce((a, t) => a + t.mins - t.planned, 0) / withPlan.length) : null;
    const vsTxt = vs == null ? "" : `<b>${vs > 0 ? "+" : ""}${vs} min</b> vs plan · `;
    return `<div class="tile"><p class="label">${esc(name(who))} → ${placeLabel(d)}</p>
      <div class="tile-big">${avg}<small>min average</small></div>
      <div class="tile-sub">${vsTxt}best <b>${Math.min(...m)}</b> · worst <b>${Math.max(...m)}</b> · ${m.length} trip${m.length > 1 ? "s" : ""}</div>
      ${m.length > 1 ? sparkline(trips) : ""}</div>`;
  }).join("") + `</div>`;
  $("tripList").innerHTML = log.slice(0, 40).map((t, i) => {
    const d = new Date(t.start);
    const when = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + " · " + hm(d);
    const rated = ratedLegs(t);
    const busy = rated.length
      ? `<div class="rated">${rated.map((l) => `${esc(l.name)}: ${ratingText(l)}`).join(" · ")}</div>`
      : `<button type="button" class="rate-link" data-rate="${t.start}">Rate how busy it was</button>`;
    return `<li class="trip-row"><div class="main"><div class="when">${when}</div><div class="via">${esc(name(t.who))} → ${placeLabel(t.dir)}${t.route ? " · " + esc(t.route) : ""}</div>${busy}</div>
      <div class="mins">${t.mins}m${t.planned ? `<small>plan ${t.planned}</small>` : ""}</div>
      <button class="x" type="button" data-del="${i}" aria-label="Delete trip">×</button></li>`;
  }).join("");
}

$("tripList").onclick = (e) => {
  const r = e.target.closest("[data-rate]");
  if (r) { openRating(+r.dataset.rate); return; }
  const b = e.target.closest("[data-del]"); if (!b) return;
  const log = store.get("log", []);
  const [gone] = log.splice(+b.dataset.del, 1);
  saveLog(log, [], gone ? [gone.id] : []); renderTrips();
};
const download = (blob, filename) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("backupBtn").onclick = () => {
  const log = store.get("log", []);
  if (!log.length) { toast("No trips to back up yet"); return; }
  const body = JSON.stringify({ app: "home-tfl", v: 1, at: new Date().toISOString(), names: settings.names, log });
  download(new Blob([body], { type: "application/json" }), `commute-trips-${new Date().toISOString().slice(0, 10)}.json`);
  device.backedUp = Date.now(); saveDevice(); renderTrips();
};
$("restoreBtn").onclick = () => $("restoreFile").click();
$("restoreFile").onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "home-tfl" || !Array.isArray(data.log)) throw new Error("not a backup");
    // Merge: keep every trip once, newest first.
    const log = store.get("log", []), seen = new Set(log.map((t) => t.who + "|" + t.start));
    const added = data.log.filter((t) => t && t.start && !seen.has(t.who + "|" + t.start))
      .map((t) => ({ ...t, id: t.id || tripId(t), updatedAt: t.updatedAt || t.end || t.start }));
    saveLog(log.concat(added).sort((a, b) => b.start - a.start).slice(0, 2000), added.map((t) => t.id));
    toast(`Restored ${added.length} trip${added.length === 1 ? "" : "s"}`); renderTrips();
  } catch (err) { toast("That file isn't a trips backup"); }
};
$("exportCsv").onclick = () => {
  const log = store.get("log", []);
  if (!log.length) { toast("Nothing to export yet"); return; }
  const rows = [["who", "direction", "start", "end", "minutes", "planned_minutes", "route", "busyness"]]
    .concat(log.map((t) => [name(t.who), t.dir, new Date(t.start).toISOString(), new Date(t.end).toISOString(), t.mins, t.planned ?? "", t.route,
      ratedLegs(t).map((l) => `${l.name}${l.from ? " from " + l.from : ""}: ${ratingText(l)}`).join("; ")]));
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  download(new Blob([csv], { type: "text/csv" }), "commute-log.csv");
};
$("clearLog").onclick = () => {
  if (!confirm(syncOn() ? "Delete all logged trips on both phones and in your Cloudflare copy?" : "Delete all logged trips on this phone?")) return;
  saveLog([], [], store.get("log", []).map((t) => t.id)); renderTrips();
};

// ---------- Setup ----------

function segButtons(el, options, current, attr) {
  el.innerHTML = options.map(([v, l]) => `<button type="button" data-${attr}="${v}" class="${v === current ? "on" : ""}">${esc(l)}</button>`).join("");
}

function renderSetup() {
  $("s-name-a").value = settings.names.a; $("s-name-b").value = settings.names.b;
  $("s-home").value = settings.home; $("s-office-a").value = settings.office.a; $("s-office-b").value = settings.office.b;
  $("s-key").value = settings.key;
  $("l-office-a").textContent = (settings.names.a || "Your") + (settings.names.a ? "'s office" : " office");
  $("l-office-b").textContent = (settings.names.b ? settings.names.b + "'s" : "Partner's") + " office";
  segButtons($("s-self"), PEOPLE.map((p) => [p, settings.names[p] || (p === "a" ? "First name" : "Partner")]), device.self, "self");
  segButtons($("s-pref"), PREFS, settings.pref, "pref");
  segButtons($("s-theme"), [["system", "System"], ["dark", "Dark"], ["light", "Light"]], device.theme, "theme");
  $("s-modes").innerHTML = MODES.map((m) => `<button type="button" class="chip${settings.modes.includes(m.id) ? " on" : ""}" data-mode="${m.id}" aria-pressed="${settings.modes.includes(m.id)}" style="--c:${m.c}"><i></i>${m.label}</button>`).join("");
  renderRoutes();
  renderSyncStatus();
  renderStep();
}

// Saved routes per person, plus a small find-a-station flow for adding one.
let routeDraft = null; // { p, q, busy, results, pick }
function renderRoutes() {
  $("s-routes").innerHTML = PEOPLE.map((p) => {
    const draft = routeDraft?.p === p ? routeDraft : null;
    const rows = (settings.routes[p] || []).map((r, i) =>
      `<li><span>${esc(viaLabel(r))}</span><button type="button" class="x" data-route-del="${p}|${i}" aria-label="Remove route">×</button></li>`).join("");
    let add;
    if (draft?.pick) {
      const opts = [["", "any line"], ...RAIL_MODES.filter((m) => draft.pick.modes.includes(m.id)).map((m) => [m.id, m.label])];
      add = `<div class="route-pick"><span>Change at <b>${esc(draft.pick.name)}</b>, then take</span>
        <select data-route-then aria-label="Then take">${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select>
        <div class="row"><button class="btn btn-small btn-primary" type="button" data-route-add>Add route</button><button class="btn btn-small btn-ghost" type="button" data-route-cancel>Cancel</button></div></div>`;
    } else {
      const results = !draft?.results ? "" : draft.results.length
        ? draft.results.map((m, i) => `<button type="button" class="chip" data-route-pick="${i}">${esc(m.name)}</button>`).join("")
        : `<span class="muted small">No stations found</span>`;
      add = `<div class="inline"><input type="text" data-route-q placeholder="Change at… e.g. Paddington" value="${esc(draft?.q || "")}" autocomplete="off" aria-label="Station to change at">` +
        `<button class="btn btn-small" type="button" data-route-search ${draft?.busy ? "disabled" : ""}>${draft?.busy ? "…" : "Find"}</button></div>` +
        (results ? `<div class="chips route-results">${results}</div>` : "");
    }
    return `<div class="routes-person" data-p="${p}"><h3>${esc(name(p))}</h3>${rows ? `<ul class="saved-routes">${rows}</ul>` : ""}${add}</div>`;
  }).join("");
}
async function routeSearch(p) {
  const q = document.querySelector(`.routes-person[data-p="${p}"] [data-route-q]`).value.trim();
  if (!q) return;
  routeDraft = { p, q, busy: true }; renderRoutes();
  try { routeDraft = { p, q, results: await searchStations(q) }; }
  catch (e) { routeDraft = { p, q, results: [] }; toast("Couldn't reach TfL"); }
  renderRoutes();
}

function readTextFields() {
  settings.names = { a: $("s-name-a").value.trim(), b: $("s-name-b").value.trim() };
  settings.home = $("s-home").value.trim();
  settings.office = { a: $("s-office-a").value.trim(), b: $("s-office-b").value.trim() };
  settings.key = $("s-key").value.trim();
  saveSettings();
}

let savedFlash;
function saved() { clearTimeout(savedFlash); savedFlash = setTimeout(() => toast("Saved"), 400); }

$("view-setup").addEventListener("change", (e) => {
  if (e.target.matches("input[type=text]:not([data-route-q]):not([data-nosave]), input[type=password]:not([data-nosave])")) { readTextFields(); renderSetup(); saved(); }
});
$("view-setup").addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  const person = t.closest(".routes-person")?.dataset.p;
  if ("routeSearch" in t.dataset) routeSearch(person);
  else if (t.dataset.routePick) { routeDraft = { ...routeDraft, pick: routeDraft.results[+t.dataset.routePick] }; renderRoutes(); }
  else if ("routeCancel" in t.dataset) { routeDraft = null; renderRoutes(); }
  else if ("routeAdd" in t.dataset) {
    const pick = routeDraft.pick, then = document.querySelector("[data-route-then]").value;
    t.disabled = true;
    try {
      const id = await resolveStation(pick, then || pick.modes[0]);
      settings.routes[person] = [...(settings.routes[person] || []), { via: { id, name: pick.name }, then }];
      saveSettings(); routeDraft = null; renderRoutes(); toast("Route added — it's planned on every Check");
    } catch (err) { toast("Couldn't reach TfL"); t.disabled = false; }
  } else if (t.dataset.routeDel) {
    const [p, i] = t.dataset.routeDel.split("|");
    settings.routes[p].splice(+i, 1); saveSettings(); renderRoutes();
  } else if (t.dataset.self) { device.self = t.dataset.self; state.who = device.self; saveDevice(); renderSetup(); }
  else if (t.dataset.pref) { settings.pref = t.dataset.pref; saveSettings(); renderSetup(); saved(); }
  else if (t.dataset.theme) { device.theme = t.dataset.theme; saveDevice(); applyTheme(); renderSetup(); }
  else if (t.dataset.mode) {
    const m = t.dataset.mode, on = settings.modes.includes(m);
    if (on && settings.modes.length === 1) { toast("Keep at least one"); return; }
    settings.modes = on ? settings.modes.filter((x) => x !== m) : [...settings.modes, m];
    saveSettings(); renderSetup(); saved();
  } else if (t.dataset.geo) {
    const label = t.textContent; t.textContent = "…"; t.disabled = true;
    try { $(t.dataset.geo).value = await getLocation(); readTextFields(); renderSetup(); saved(); }
    catch (err) { toast("Couldn't get your location"); }
    t.textContent = label; t.disabled = false;
  }
});

// Onboarding: the first two groups, one at a time.
const STEPS = 2;
let step = 1;
function renderStep() {
  const on = !device.onboarded;
  document.body.classList.toggle("onboarding", on);
  $("stepDots").classList.toggle("hidden", !on);
  $("stepNav").classList.toggle("hidden", !on);
  $("setupTitle").textContent = on ? "Welcome" : "Setup";
  document.querySelectorAll("#view-setup .group").forEach((g) => g.classList.toggle("current", g.dataset.step === String(step)));
  [...$("stepDots").children].forEach((s, i) => s.classList.toggle("on", i < step));
  $("stepBack").disabled = step === 1;
  $("stepNext").textContent = step === STEPS ? "Done" : "Next";
}
$("view-setup").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("[data-route-q]")) { e.preventDefault(); routeSearch(e.target.closest(".routes-person").dataset.p); }
});
$("stepBack").onclick = () => { step = Math.max(1, step - 1); renderStep(); };
$("stepNext").onclick = () => {
  readTextFields();
  const missing = (ids) => ids.find((id) => !$(id).value.trim());
  const gap = step === 1 ? missing(["s-name-a", "s-name-b"]) : missing(["s-home", "s-office-a", "s-office-b"]);
  if (gap) { toast(step === 1 ? "Add both names" : "Add home and both offices"); $(gap).focus(); return; }
  if (step < STEPS) { step++; renderSetup(); window.scrollTo(0, 0); return; }
  device.onboarded = true; saveDevice(); renderStep();
  location.hash = "#today";
};

// Sharing: a code (base64 JSON) or a link that carries it in the hash (never sent to a server).
function shareCode() {
  const { key, ...shareable } = settings;
  const sync = syncOn() ? { url: device.sync.url, key: device.sync.key } : undefined;
  return btoa(unescape(encodeURIComponent(JSON.stringify({ v: 2, from: device.self, ...shareable, sync }))));
}
function importCode(code) {
  const data = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
  let incoming = data, sender = data.from;
  if (!data.v) {
    // Prototype format: {names:{me,partner}, office:{me,partner}, modes:"a,b"}
    incoming = {
      names: { a: data.names?.me || "", b: data.names?.partner || "" },
      home: data.home, office: { a: data.office?.me || "", b: data.office?.partner || "" },
      modes: String(data.modes || "").split(",").map((s) => s.trim()).filter((m) => m && m !== "walking")
    };
    sender = "a";
  }
  const { sync: link, ...shared } = incoming;
  settings = normaliseSettings({ ...settings, ...shared, key: settings.key });
  saveSettings();
  device.self = other(sender || "a"); device.onboarded = true; saveDevice();
  state.who = device.self;
  if (link?.url && link?.key) { connectSync(link.url, link.key); sync(); }
  return settings.names[sender] || "your partner";
}
$("syncNow").onclick = () => sync();
$("syncConnect").onclick = () => {
  const url = $("s-sync-url").value.trim(), key = $("s-sync-key").value.trim();
  if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url) || key.length < 16) { toast("Add the sync URL and household key"); return; }
  connectSync(url, key); $("s-sync-key").value = ""; sync();
};
$("syncDisconnect").onclick = () => {
  if (!confirm("Stop syncing on this phone? Trips already here stay here.")) return;
  device.sync = null; saveDevice(); renderSyncStatus();
};
$("copyCode").onclick = async () => {
  try { await navigator.clipboard.writeText(shareCode()); toast("Code copied"); }
  catch (e) { $("importInput").value = shareCode(); $("importInput").select(); toast("Copy the code above"); }
};
$("shareLink").onclick = async () => {
  const url = location.origin + location.pathname + "#import=" + encodeURIComponent(shareCode());
  if (navigator.share) { try { await navigator.share({ title: "Commute setup", url }); } catch (e) {} return; }
  try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch (e) { prompt("Copy this link", url); }
};
$("importBtn").onclick = () => {
  try { const who = importCode($("importInput").value); $("importInput").value = ""; renderSetup(); toast(`Imported from ${who}`); }
  catch (e) { toast("That code didn't work"); }
};
$("resetAll").onclick = () => {
  if (!confirm("Erase settings, trips and cached results on this phone?")) return;
  store.keys().forEach((k) => localStorage.removeItem(k));
  location.hash = ""; location.reload();
};

// ---------- Today interactions ----------
$("checkBtn").onclick = () => check();
$("leaveBtn").onclick = startTrip;
$("arrivedBtn").onclick = () => endTrip(true);
$("cancelTripBtn").onclick = () => { if (confirm("Cancel this trip without logging it?")) endTrip(false); };

// Switching person, direction or start point only shows that combination's last result.
// Fetching is always an explicit tap on Check now.
function changed() { state.sel = 0; state.error = ""; renderToday(); }
$("whoSeg").onclick = (e) => {
  const b = e.target.closest("[data-who]");
  if (!b || b.dataset.who === state.who) return;
  state.who = b.dataset.who; changed();
};
$("swapBtn").onclick = () => {
  state.dir = dir() === "work" ? "home" : "work";
  $("swapBtn").classList.toggle("flipped");
  changed();
};
$("fromBtn").onclick = () => { state.fromHere = !state.fromHere; changed(); };
$("board").addEventListener("click", (e) => {
  const alt = e.target.closest("[data-sel]");
  if (alt) { state.sel = +alt.dataset.sel; renderToday(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  if (e.target.closest("[data-refresh-trains]")) {
    const c = store.get(cacheKey(state.who, dir()), null);
    const j = c?.journeys?.[Math.min(state.sel, c.journeys.length - 1)];
    const leg = j && firstRail(j);
    if (leg) refreshTrains(leg);
  }
});
$("board").addEventListener("toggle", (e) => { if (e.target.matches(".others")) state.othersOpen = e.target.open; }, true);

// ---------- tabs, theme, boot ----------
const currentTab = () => { const t = (location.hash || "#today").slice(1); return ["today", "trips", "setup"].includes(t) ? t : "today"; };
function showTab() {
  if (location.hash.startsWith("#import=")) {
    const code = decodeURIComponent(location.hash.slice(8));
    history.replaceState(null, "", location.pathname + location.search + "#setup");
    try { const who = importCode(code); toast(`Imported from ${who}`); } catch (e) { toast("That link didn't work"); }
  }
  if (!device.onboarded && !configured() && currentTab() !== "setup") { location.hash = "#setup"; return; }
  if (configured() && !device.onboarded) { device.onboarded = true; saveDevice(); }
  const tab = currentTab();
  document.body.dataset.tab = tab;
  if (tab !== showTab.last) { window.scrollTo(0, 0); showTab.last = tab; }
  ["today", "trips", "setup"].forEach((t) => $("view-" + t).classList.toggle("hidden", t !== tab));
  $("view-trip").classList.add("hidden");
  document.querySelectorAll(".tabs [data-tab]").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  if (tab === "today") renderToday();
  if (tab === "trips") renderTrips();
  if (tab === "setup") renderSetup();
  renderHeader();
}
window.addEventListener("hashchange", showTab);

function applyTheme() {
  if (device.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = device.theme;
  const dark = device.theme === "dark" || (device.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0c0d0f" : "#f3f3f0";
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

// Coming back after a while (e.g. from the home screen) re-picks the direction by time of day.
// This only re-renders the last result; nothing is fetched.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  if (Date.now() - hiddenAt > 30 * MIN) { state.dir = null; state.sel = 0; }
  if (currentTab() === "today") renderToday();
  // Coming back after a while counts as opening the app: pick up the other phone's changes.
  if (Date.now() - (device.sync?.lastOk || 0) > 5 * MIN) sync();
});
// Keeps "in 12 min" labels honest. Local re-render only — no network.
setInterval(() => { if (document.visibilityState === "visible" && currentTab() === "today" && !activeTrip()) renderToday(); }, 30000);

applyTheme();
showTab();
sync(); // once on open (no-op when not connected)
