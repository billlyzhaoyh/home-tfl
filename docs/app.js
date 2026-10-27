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
const DIRS = ["work", "home"];
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

const defaultCommute = () => ({
  work: { time: "09:00", timeIs: "Arriving", days: [1, 2, 3, 4, 5] },
  home: { time: "18:00", timeIs: "Departing", days: [1, 2, 3, 4, 5] }
});

function normaliseSettings(s = {}) {
  const d = defaultCommute();
  return {
    names: { a: "", b: "", ...s.names },
    home: s.home || "",
    office: { a: "", b: "", ...s.office },
    commute: Object.fromEntries(PEOPLE.map((p) => [p, {
      work: { ...d.work, ...s.commute?.[p]?.work },
      home: { ...d.home, ...s.commute?.[p]?.home }
    }])),
    modes: Array.isArray(s.modes) && s.modes.length ? s.modes : ["tube", "elizabeth-line", "dlr", "overground"],
    pref: s.pref || "leasttime",
    key: s.key || ""
  };
}

let settings = normaliseSettings(store.get("settings", {}));
let device = { self: "a", theme: "system", onboarded: false, ...store.get("device", {}) };
const saveSettings = () => store.set("settings", settings);
const saveDevice = () => store.set("device", device);

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const MIN = 60000;

// ?now=08:05 fakes the clock (for testing the commute-window rules).
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
const atTime = (str, base = now()) => { const [h, m] = str.split(":").map(Number); const d = new Date(base); d.setHours(h, m, 0, 0); return d; };
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

// Pick the arrivals for this leg's direction: keep platforms where at least one train
// heads to one of the leg's listed destinations. Falls back to every platform.
function pickArrivals(arrivals, leg) {
  const onLine = arrivals.filter((a) => !leg.line || a.lineId === leg.line);
  const dirs = leg.directions.map(norm).filter(Boolean);
  const byPlatform = {};
  onLine.forEach((a) => (byPlatform[a.platformName || "?"] ||= []).push(a));
  const matches = (a) => dirs.some((d) => {
    const dest = norm(a.destinationName), tow = norm(a.towards);
    return (dest && (dest.includes(d) || d.includes(dest))) || (tow && tow.includes(d));
  });
  let platforms = Object.entries(byPlatform).filter(([, list]) => list.some(matches));
  const matched = platforms.length > 0;
  if (!matched) platforms = Object.entries(byPlatform);
  return {
    matched,
    platforms: platforms.slice(0, 2).map(([name, list]) => ({
      name, trains: list.sort((a, b) => a.timeToStation - b.timeToStation).slice(0, 4)
    }))
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

function crowdLabel(v) {
  if (v == null) return null;
  const pct = v <= 3 ? v * 100 : v; // API value may be a fraction of baseline
  const lvl = pct < 60 ? ["ok", "quiet"] : pct < 100 ? ["ok", "normal"] : pct < 130 ? ["warn", "busy"] : ["bad", "very busy"];
  return { pct: Math.round(pct), level: lvl[0], text: lvl[1] };
}

// ---------- commute windows ----------
// A window is the stretch of time in which opening the app checks TfL once.
// Leave time = the set time (Departing), or the set time minus a typical trip (Arriving).
function typicalMins(who, dir) {
  const c = store.get(cacheKey(who, dir), null);
  if (c?.journeys?.[0]) return c.journeys[0].duration;
  const log = store.get("log", []).filter((t) => t.who === who && t.dir === dir).slice(0, 10);
  return log.length ? Math.round(log.reduce((a, t) => a + t.mins, 0) / log.length) : 45;
}
function commuteWindow(who, dir, at = now()) {
  const c = settings.commute[who]?.[dir];
  if (!c?.time || !c.days?.includes(at.getDay())) return null;
  const target = atTime(c.time, at);
  const leave = c.timeIs === "Arriving" ? new Date(target - typicalMins(who, dir) * MIN) : target;
  return { leave, target, start: new Date(leave - 45 * MIN), end: new Date(+leave + 15 * MIN), c };
}
const inWindow = (w, at = now()) => Boolean(w && at >= w.start && at <= w.end);

function autoDir(who) {
  const t = now();
  for (const d of DIRS) if (inWindow(commuteWindow(who, d, t), t)) return d;
  const w = commuteWindow(who, "work", t);
  if (w) return t < w.end ? "work" : "home";
  return t.getHours() < 13 ? "work" : "home";
}
// Plan for the set commute time while it's still ahead; otherwise plan for leaving now.
function autoPlan(who, dir) {
  const w = commuteWindow(who, dir);
  return w && now() < new Date(w.leave - 2 * MIN) ? "planned" : "now";
}

// ---------- view state ----------
const state = { who: device.self, dir: null, plan: null, fromHere: false, sel: 0, busy: false, liveBusy: false, othersOpen: false, error: "" };
const dir = () => state.dir || autoDir(state.who);
const plan = () => {
  const p = state.plan || autoPlan(state.who, dir());
  return p === "planned" && !commuteWindow(state.who, dir()) ? "now" : p;
};
const cacheKey = (who, d) => `cache.${who}.${d}`;
const ctxKey = () => [state.who, dir(), plan(), state.fromHere ? "here" : "base"].join("|");

function endpoints(who, d) {
  return d === "work"
    ? { from: settings.home, to: settings.office[who], fromName: "home" }
    : { from: settings.office[who], to: settings.home, fromName: "office" };
}

function journeyParams(who, d, p) {
  const c = settings.commute[who][d];
  const at = p === "planned" ? atTime(c.time) : now();
  return {
    mode: [...settings.modes, "walking"].join(","),
    journeyPreference: settings.pref,
    date: `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`,
    time: pad(at.getHours()) + pad(at.getMinutes()),
    timeIs: p === "planned" ? c.timeIs : "Departing"
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
function rank(journeys, timeIs) {
  const js = journeys.slice();
  // Arrive-by: the latest departure that still makes it. Otherwise: the earliest arrival.
  if (timeIs === "Arriving") js.sort((a, b) => b.start.localeCompare(a.start) || a.duration - b.duration);
  else js.sort((a, b) => a.end.localeCompare(b.end) || a.duration - b.duration);
  return js.slice(0, 4);
}
const firstRail = (j) => j.legs.find((l) => RAIL.has(l.mode) && l.naptan);
const liveKey = (leg) => leg.naptan + "|" + leg.line;
// Live trains only matter close to departure; skip them for a plan an hour out.
const dueSoon = (leg) => { const m = minsUntil(leg.dep); return m >= -2 && m <= 30; };
const stationName = (s) => String(s || "").replace(/ (Underground|Rail|DLR|Overground) Station$/, "").replace(/ Station$/, "");

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

// ---------- checking TfL (the only places that fetch) ----------
async function check() {
  if (state.busy) return;
  const who = state.who, d = dir(), p = plan(), key = ctxKey();
  const ends = endpoints(who, d);
  if (!ends.from || !ends.to) { renderToday(); return; }
  state.busy = true; state.error = ""; renderToday();
  try {
    let from = ends.from, fromName = ends.fromName;
    if (state.fromHere) {
      try { from = await getLocation(); fromName = "your location"; }
      catch (e) { toast(`Location unavailable — using ${ends.fromName}`); }
    }
    const params = journeyParams(who, d, p);
    const jr = await planJourney(from, ends.to, params);
    const journeys = rank((jr.journeys || []).map(slim), params.timeIs);
    const liveLegs = {};
    journeys.forEach((j) => { const l = firstRail(j); if (l && dueSoon(l)) liveLegs[liveKey(l)] = l; });
    const [lines, live] = await Promise.all([
      tfl(`/Line/Mode/${STATUS_MODES}/Status`).catch(() => []),
      loadLiveFor(Object.values(liveLegs))
    ]);
    const status = lines.map((l) => {
      const s = l.lineStatuses?.[0] || {};
      return { id: l.id, name: l.name, sev: s.statusSeverity, desc: s.statusSeverityDescription, reason: (s.reason || "").replace(/^.*?:\s*/, "").slice(0, 200) };
    });
    store.set(cacheKey(who, d), { at: nowMs(), key, plan: p, timeIs: params.timeIs, fromName, journeys, status, live });
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

// Opening the app inside a commute window checks once, unless a fresh result exists.
function maybeAutoCheck() {
  if (!configured() || activeTrip() || state.busy) return;
  const w = commuteWindow(state.who, dir());
  if (!inWindow(w)) return;
  const c = store.get(cacheKey(state.who, dir()), null);
  if (c && c.key === ctxKey() && nowMs() - c.at < 10 * MIN) return;
  check();
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
  const head = `<div class="live-head"><p class="label">Next trains · ${station}</p>${btn}</div>`;
  if (!live || !fresh) {
    const msg = m > 30 ? `Live trains appear 30 min before you leave (${relMins(m)}).` : live ? "Live trains are out of date." : "No live trains loaded.";
    return `<div class="live">${head}<p class="hint">${msg}</p></div>`;
  }
  const crowd = live.crowd ? `<p class="fact ${live.crowd.level} note"><span class="dot"></span><span>${station} is ${live.crowd.text} right now (${live.crowd.pct}% of usual)</span></p>` : "";
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
function renderHeader() {
  const t = now();
  $("date").textContent = t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
  const solo = !settings.names[other(device.self)] && !settings.office[other(device.self)];
  $("whoPill").textContent = name(state.who);
  $("whoPill").disabled = solo;
  $("dirPill").textContent = "→ " + (dir() === "work" ? "Office" : "Home");
}

function renderControls() {
  const w = commuteWindow(state.who, dir());
  const p = plan();
  let html = "";
  if (w) {
    const lbl = (w.c.timeIs === "Arriving" ? "Arrive by " : "Leave at ") + w.c.time;
    html += `<div class="seg" role="group" aria-label="When">
      <button type="button" data-plan="now" class="${p === "now" ? "on" : ""}">Leave now</button>
      <button type="button" data-plan="planned" class="${p === "planned" ? "on" : ""}">${esc(lbl)}</button></div>`;
  }
  html += `<button type="button" class="toggle${state.fromHere ? " on" : ""}" data-fromhere aria-pressed="${state.fromHere}">From here</button>`;
  $("controls").innerHTML = configured() ? html : "";
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
  // Tell people when the app will (and won't) fetch by itself.
  const w = commuteWindow(state.who, dir());
  if (inWindow(w)) bits.push(`Auto-checks on open until ${hm(w.end)}`);
  else {
    const next = DIRS.map((d) => commuteWindow(state.who, d)).filter((x) => x && x.start > now()).sort((a, b) => a.start - b.start)[0];
    bits.push(next ? `Next auto-check from ${hm(next.start)}` : "Fetches only when you tap Check");
  }
  $("statusline").innerHTML = bits.map((b) => `<span>${b}</span>`).join('<span aria-hidden="true">·</span>');
}

function renderToday() {
  renderHeader();
  if (activeTrip()) { showTripView(); return; }
  $("view-trip").classList.add("hidden");
  if (currentTab() === "today") $("view-today").classList.remove("hidden");
  renderControls();
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
  const label = c.timeIs === "Arriving" ? "Leave by" : "Leave";
  const rail = firstRail(j);
  const routeLines = new Set(c.journeys.flatMap((x) => x.legs.map((l) => l.line)).filter(Boolean));
  const othersBad = c.status.filter((s) => s.sev !== 10 && !routeLines.has(s.id));

  const hero = `<article class="hero${past ? " past" : ""}">
    <p class="label">${label} · from ${esc(c.fromName)}</p>
    <div class="hero-top">
      <div><div class="bigtime">${hhmm(j.start)}</div><div class="sub countdown">${past ? "This time has passed — check again" : relMins(leaveIn)}</div></div>
      <div class="hero-side"><p class="label">Arrive</p><div class="midtime">${hhmm(j.end)}</div><div class="sub">${j.duration} min</div></div>
    </div>
    ${strip(j)}
    <ul class="facts">${routeStatus(j, statusById)}</ul>
    ${rail ? renderLive(rail, c.live[liveKey(rail)]) : ""}
  </article>`;

  const alts = c.journeys.length > 1 ? `<div class="alts"><p class="label">Other options</p>` + c.journeys.map((x, i) => {
    if (i === sel) return "";
    const worst = Math.min(...x.legs.map((l) => statusById[l.line]?.sev ?? 10));
    const flag = worst !== 10 ? `<span class="dot flag ${sevClass(worst)}" title="Disruption on this route"></span>` : "";
    return `<button class="alt" type="button" data-sel="${i}"><span class="t">${hhmm(x.start)}</span>${strip(x, true)}${flag}<span class="d">${x.duration}m</span></button>`;
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
    const log = store.get("log", []);
    log.unshift({ ...rest, end, mins: Math.max(1, Math.round((end - a.start) / MIN)) });
    store.set("log", log.slice(0, 500));
    toast(`Logged ${Math.round((end - a.start) / MIN)} min`);
  }
  store.del("active"); clearInterval(tripTimer);
  document.body.classList.remove("on-trip");
  renderToday();
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
  if (!log.length) {
    $("tiles").innerHTML = `<div class="empty"><h2>No trips yet</h2><p>Tap <b>I'm leaving</b> when you head out and <b>Arrived</b> when you get there. Averages and a chart build up here.</p></div>`;
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
    return `<li class="trip-row"><div class="main"><div class="when">${when}</div><div class="via">${esc(name(t.who))} → ${placeLabel(t.dir)}${t.route ? " · " + esc(t.route) : ""}</div></div>
      <div class="mins">${t.mins}m${t.planned ? `<small>plan ${t.planned}</small>` : ""}</div>
      <button class="x" type="button" data-del="${i}" aria-label="Delete trip">×</button></li>`;
  }).join("");
}

$("tripList").onclick = (e) => {
  const b = e.target.closest("[data-del]"); if (!b) return;
  const log = store.get("log", []); log.splice(+b.dataset.del, 1); store.set("log", log); renderTrips();
};
$("exportCsv").onclick = () => {
  const log = store.get("log", []);
  if (!log.length) { toast("Nothing to export yet"); return; }
  const rows = [["who", "direction", "start", "end", "minutes", "planned_minutes", "route"]]
    .concat(log.map((t) => [name(t.who), t.dir, new Date(t.start).toISOString(), new Date(t.end).toISOString(), t.mins, t.planned ?? "", t.route]));
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "commute-log.csv"; a.click();
};
$("clearLog").onclick = () => { if (confirm("Delete all logged trips on this phone?")) { store.set("log", []); renderTrips(); } };

// ---------- Setup ----------
const DAY_LETTERS = [[1, "M"], [2, "T"], [3, "W"], [4, "T"], [5, "F"], [6, "S"], [0, "S"]];

function segButtons(el, options, current, attr) {
  el.innerHTML = options.map(([v, l]) => `<button type="button" data-${attr}="${v}" class="${v === current ? "on" : ""}">${esc(l)}</button>`).join("");
}

function renderSetup() {
  $("s-name-a").value = settings.names.a; $("s-name-b").value = settings.names.b;
  $("s-home").value = settings.home; $("s-office-a").value = settings.office.a; $("s-office-b").value = settings.office.b;
  $("s-key").value = settings.key;
  $("l-office-a").textContent = (settings.names.a || "Your") + (settings.names.a ? "'s office" : " office");
  $("l-office-b").textContent = (settings.names.b ? settings.names.b + "'s" : "Partner's") + " office (optional)";
  segButtons($("s-self"), PEOPLE.map((p) => [p, settings.names[p] || (p === "a" ? "First name" : "Partner")]), device.self, "self");
  segButtons($("s-pref"), PREFS, settings.pref, "pref");
  segButtons($("s-theme"), [["system", "System"], ["dark", "Dark"], ["light", "Light"]], device.theme, "theme");
  $("s-modes").innerHTML = MODES.map((m) => `<button type="button" class="chip${settings.modes.includes(m.id) ? " on" : ""}" data-mode="${m.id}" aria-pressed="${settings.modes.includes(m.id)}" style="--c:${m.c}"><i></i>${m.label}</button>`).join("");
  const people = [device.self, other(device.self)].filter((p) => settings.office[p] || p === device.self);
  $("s-commute").innerHTML = people.map((p) => `<div class="commute-person"><h3>${esc(settings.names[p] || (p === device.self ? "You" : "Partner"))}</h3>` +
    DIRS.map((d) => {
      const c = settings.commute[p][d];
      return `<div class="commute-row" data-p="${p}" data-d="${d}">
        <span class="what">To ${placeLabel(d)}</span>
        <span class="ctl">
          <span class="seg"><button type="button" data-timeis="Departing" class="${c.timeIs === "Departing" ? "on" : ""}">Leave</button><button type="button" data-timeis="Arriving" class="${c.timeIs === "Arriving" ? "on" : ""}">Arrive</button></span>
          <input type="time" value="${esc(c.time)}" data-time aria-label="${placeLabel(d)} time">
        </span>
        <div class="days">${DAY_LETTERS.map(([n, l]) => `<button type="button" class="day${c.days.includes(n) ? " on" : ""}" data-day="${n}" aria-pressed="${c.days.includes(n)}">${l}</button>`).join("")}</div>
      </div>`;
    }).join("") + `</div>`).join("");
  renderStep();
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
  if (e.target.matches("input[type=text], input[type=password]")) { readTextFields(); renderSetup(); saved(); }
  if (e.target.matches("[data-time]")) {
    const row = e.target.closest(".commute-row");
    settings.commute[row.dataset.p][row.dataset.d].time = e.target.value || settings.commute[row.dataset.p][row.dataset.d].time;
    saveSettings(); saved();
  }
});
$("view-setup").addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  const row = t.closest(".commute-row");
  if (t.dataset.self) { device.self = t.dataset.self; state.who = device.self; saveDevice(); renderSetup(); }
  else if (t.dataset.pref) { settings.pref = t.dataset.pref; saveSettings(); renderSetup(); saved(); }
  else if (t.dataset.theme) { device.theme = t.dataset.theme; saveDevice(); applyTheme(); renderSetup(); }
  else if (t.dataset.mode) {
    const m = t.dataset.mode, on = settings.modes.includes(m);
    if (on && settings.modes.length === 1) { toast("Keep at least one"); return; }
    settings.modes = on ? settings.modes.filter((x) => x !== m) : [...settings.modes, m];
    saveSettings(); renderSetup(); saved();
  } else if (row && t.dataset.timeis) {
    settings.commute[row.dataset.p][row.dataset.d].timeIs = t.dataset.timeis; saveSettings(); renderSetup(); saved();
  } else if (row && t.dataset.day) {
    const c = settings.commute[row.dataset.p][row.dataset.d], n = +t.dataset.day;
    c.days = c.days.includes(n) ? c.days.filter((x) => x !== n) : [...c.days, n];
    saveSettings(); renderSetup(); saved();
  } else if (t.dataset.geo) {
    const label = t.textContent; t.textContent = "…"; t.disabled = true;
    try { $(t.dataset.geo).value = await getLocation(); readTextFields(); renderSetup(); saved(); }
    catch (err) { toast("Couldn't get your location"); }
    t.textContent = label; t.disabled = false;
  }
});

// Onboarding: the first three groups, one at a time.
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
  $("stepNext").textContent = step === 3 ? "Done" : "Next";
}
$("stepBack").onclick = () => { step = Math.max(1, step - 1); renderStep(); };
$("stepNext").onclick = () => {
  readTextFields();
  if (step === 1 && !settings.names[device.self]) { toast("Add your name"); $("s-name-" + device.self).focus(); return; }
  if (step === 2 && (!settings.home || !settings.office[device.self])) { toast("Add home and your office"); return; }
  if (step < 3) { step++; renderSetup(); window.scrollTo(0, 0); return; }
  device.onboarded = true; saveDevice(); renderStep();
  state.checkOnShow = true;
  location.hash = "#today";
};

// Sharing: a code (base64 JSON) or a link that carries it in the hash (never sent to a server).
function shareCode() {
  const { key, ...shareable } = settings;
  return btoa(unescape(encodeURIComponent(JSON.stringify({ v: 2, from: device.self, ...shareable }))));
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
  settings = normaliseSettings({ ...settings, ...incoming, key: settings.key });
  saveSettings();
  device.self = other(sender || "a"); device.onboarded = true; saveDevice();
  state.who = device.self;
  return settings.names[sender] || "your partner";
}
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

// Changing who/direction/plan shows that combination's last result and fetches only if it's missing or stale.
function changed() {
  state.sel = 0; state.error = "";
  const c = store.get(cacheKey(state.who, dir()), null);
  if (configured() && endpoints(state.who, dir()).to && (!c || c.key !== ctxKey() || nowMs() - c.at > 10 * MIN)) check();
  else renderToday();
}
$("whoPill").onclick = () => { state.who = other(state.who); changed(); };
$("dirPill").onclick = () => { state.dir = dir() === "work" ? "home" : "work"; state.plan = null; changed(); };
$("controls").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.plan) { if (b.dataset.plan === plan()) return; state.plan = b.dataset.plan; }
  if ("fromhere" in b.dataset) state.fromHere = !state.fromHere;
  changed();
};
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
  if (tab !== showTab.last) { window.scrollTo(0, 0); showTab.last = tab; }
  ["today", "trips", "setup"].forEach((t) => $("view-" + t).classList.toggle("hidden", t !== tab));
  $("view-trip").classList.add("hidden");
  document.querySelectorAll(".tabs [data-tab]").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  if (tab === "today") {
    renderToday();
    if (state.checkOnShow) { state.checkOnShow = false; check(); } else maybeAutoCheck();
  }
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

// Coming back to the app (e.g. from the home screen) counts as opening it: re-evaluate
// the direction and run the same once-per-window rule. Nothing fetches while hidden.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  if (Date.now() - hiddenAt > 30 * MIN) { state.dir = null; state.plan = null; state.sel = 0; }
  if (currentTab() === "today") { renderToday(); maybeAutoCheck(); }
});
// Keeps "in 12 min" labels honest. Local re-render only — no network.
setInterval(() => { if (document.visibilityState === "visible" && currentTab() === "today" && !activeTrip()) renderToday(); }, 30000);

applyTheme();
showTab();
