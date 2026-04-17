/* global L */

const MAX_ROWS = 250;
const MAX_LOG_LINES = 300;

const SENSOR_SCHEMA = [
  { key: "temp_BMP", label: "Temperatura BMP", unit: "°C", hint: "temp_BMP" },
  { key: "press_BMP", label: "Ciśnienie BMP", unit: "hPa", hint: "press_BMP" },
  { key: "altitude", label: "Wysokość z ciśnienia", unit: "m", hint: "press_BMP → wysokość" },
  { key: "temp_SHT", label: "Temperatura SHT", unit: "°C", hint: "temp_SHT" },
  { key: "hum_SHT", label: "Wilgotność SHT", unit: "%", hint: "hum_SHT" },
  { key: "co2_SCD", label: "CO₂ SCD", unit: "ppm", hint: "co2_SCD" },
  { key: "air_SPG", label: "air_SPG", unit: "", hint: "air_SPG" },
  { key: "foto", label: "Fotorezystor", unit: "", hint: "wart_fotorezystor" },
];

const state = {
  http: { baseUrl: null, timer: null, running: false, lastTimestamp: null },
  lastDt: null,
  lastGps: null,
  homeGps: null,
  status: 0,
  rows: [],
  logLines: [],
};

const el = {
  connStatus: document.getElementById("connStatus"),
  sourceMode: document.getElementById("sourceMode"),
  httpBaseUrl: document.getElementById("httpBaseUrl"),
  connect: document.getElementById("connect"),
  disconnect: document.getElementById("disconnect"),
  lastFrameTs: document.getElementById("lastFrameTs"),
  lastMillis: document.getElementById("lastMillis"),
  cards: document.getElementById("cards"),
  rows: document.getElementById("rows"),
  log: document.getElementById("log"),
  gpsText: document.getElementById("gpsText"),
  distanceText: document.getElementById("distanceText"),
  homeText: document.getElementById("homeText"),
  statusText: document.getElementById("statusText"),
  fileInput: document.getElementById("fileInput"),
  clear: document.getElementById("clear"),
};

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

function setConn(kind, label) {
  el.connStatus.dataset.kind = kind;
  el.connStatus.querySelector(".label").textContent = label;
}

function isNA(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return s === "" || s.toUpperCase() === "NA";
}

function fmtValue(v) {
  if (isNA(v)) return { text: "—", isNa: true };
  return { text: String(v).trim(), isNa: false };
}

function toNumberMaybe(v) {
  if (isNA(v)) return null;
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function altitudeFromPressure(pressureHpa) {
  const p = toNumberMaybe(pressureHpa);
  if (p == null || p <= 0) return null;
  const P0 = 1013.25;
  return 44330 * (1 - Math.pow(p / P0, 1 / 5.255));
}

function altitudeText(pressureHpa) {
  const alt = altitudeFromPressure(pressureHpa);
  return alt == null ? "—" : alt.toFixed(1);
}

function splitPipes(line) {
  return line
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function parseGpsLine(line) {
  const parts = splitPipes(line);
  if (parts[0] !== "GPS") return null;

  let ts = null;
  let start = 1;
  const tsToken = parts[1] ? String(parts[1]) : "";
  const tsMatch = tsToken.match(/^ts\s*=\s*(.+)$/i);
  if (tsMatch) {
    ts = tsMatch[1].trim();
    start = 2;
  }

  const tryKeyed = () => {
    let lat = null;
    let lon = null;
    for (const p of parts.slice(start)) {
      const m = p.match(/^(lat|latitude)\s*=\s*(.+)$/i);
      if (m) lat = toNumberMaybe(m[2]);
      const m2 = p.match(/^(lon|lng|longitude)\s*=\s*(.+)$/i);
      if (m2) lon = toNumberMaybe(m2[2]);
    }
    if (lat == null || lon == null) return null;
    return { ts, lat, lon, raw: line };
  };

  const keyed = tryKeyed();
  if (keyed) return keyed;

  if (parts.length >= start + 2) {
    const lat = toNumberMaybe(parts[start]);
    const lon = toNumberMaybe(parts[start + 1]);
    if (lat != null && lon != null) return { lat, lon, raw: line };
  }

  return { ts, lat: null, lon: null, raw: line };
}

function parseDtLine(line) {
  const parts = splitPipes(line);
  if (parts[0] !== "DT") return null;
  let ts = null;
  let start = 1;
  const tsToken = parts[1] ? String(parts[1]) : "";
  const tsMatch = tsToken.match(/^ts\s*=\s*(.+)$/i);
  if (tsMatch) {
    ts = tsMatch[1].trim();
    start = 2;
  }

  const v = (i) => {
    if (parts.length <= i) return null;
    const raw = parts[i];
    return isNA(raw) ? null : raw;
  };

  const millis = v(start);

  return {
    type: "DT",
    ts,
    millis,
    temp_BMP: v(start + 1),
    press_BMP: v(start + 2),
    temp_SHT: v(start + 3),
    hum_SHT: v(start + 4),
    co2_SCD: v(start + 5),
    air_SPG: v(start + 6),
    foto: v(start + 7),
    raw: line,
  };
}

function parseLogLine(line) {
  const parts = splitPipes(line);
  if (parts[0] !== "LOG") return null;
  return { type: "LOG", message: parts.slice(1).join(" | ") || "", raw: line };
}

function parseStatusLine(line) {
  const parts = splitPipes(line);
  if (parts[0] !== "STATUS") return null;
  const value = toNumberMaybe(parts[1]);
  return { type: "STATUS", value, raw: line };
}

function parseLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return null;
  if (trimmed === "START" || trimmed.startsWith("START |")) return { type: "IGNORED", raw: trimmed };
  if (trimmed.startsWith("DT")) return parseDtLine(trimmed);
  if (trimmed.startsWith("GPS")) return { type: "GPS", ...parseGpsLine(trimmed) };
  if (trimmed.startsWith("STATUS")) return parseStatusLine(trimmed);
  if (trimmed.startsWith("LOG")) return parseLogLine(trimmed);
  return { type: "UNKNOWN", raw: trimmed };
}

function pushLog(kind, message) {
  const line = `[${nowStamp()}] ${kind}: ${message}`;
  state.logLines.push(line);
  if (state.logLines.length > MAX_LOG_LINES) state.logLines.splice(0, state.logLines.length - MAX_LOG_LINES);
  el.log.textContent = state.logLines.join("\n");
  el.log.scrollTop = el.log.scrollHeight;
}

function createCards() {
  el.cards.innerHTML = "";
  for (const s of SENSOR_SCHEMA) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.key = s.key;

    const label = document.createElement("div");
    label.className = "card__label";
    label.textContent = s.label;

    const value = document.createElement("div");
    value.className = "card__value";
    value.innerHTML = `<span class="na">—</span>${s.unit ? ` <span class="card__unit">${s.unit}</span>` : ""}`;

    const sub = document.createElement("div");
    sub.className = "card__sub";
    sub.textContent = s.hint;

    card.append(label, value, sub);
    el.cards.append(card);
  }
}

function setCardValue(key, rawValue, unit) {
  const card = el.cards.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
  if (!card) return;
  const valueEl = card.querySelector(".card__value");
  const { text, isNa: na } = fmtValue(rawValue);
  const unitText = unit ? ` <span class="card__unit">${unit}</span>` : "";
  valueEl.innerHTML = na ? `<span class="na">${text}</span>${unitText}` : `${text}${unitText}`;
}

function renderLatest() {
  const dt = state.lastDt;
  if (!dt) {
    el.lastMillis.textContent = "—";
    el.lastFrameTs.textContent = "—";
  } else {
    el.lastFrameTs.textContent = dt.ts ?? "—";
    el.lastMillis.textContent = fmtValue(dt.millis).text;
    setCardValue("temp_BMP", dt.temp_BMP, "°C");
    setCardValue("press_BMP", dt.press_BMP, "hPa");
    setCardValue("altitude", altitudeText(dt.press_BMP), "m");
    setCardValue("temp_SHT", dt.temp_SHT, "°C");
    setCardValue("hum_SHT", dt.hum_SHT, "%");
    setCardValue("co2_SCD", dt.co2_SCD, "ppm");
    setCardValue("air_SPG", dt.air_SPG, "");
    setCardValue("foto", dt.foto, "");
  }

  const gps = state.lastGps;
  if (!gps) {
    el.gpsText.textContent = "—";
    el.distanceText.textContent = "—";
  } else if (gps.lat != null && gps.lon != null) {
    el.gpsText.textContent = `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}`;
    if (state.homeGps) {
      const dist = haversineDistance(state.homeGps.lat, state.homeGps.lon, gps.lat, gps.lon);
      el.distanceText.textContent = `${dist.toFixed(2)} km`;
    } else {
      el.distanceText.textContent = "Brak pozycji domu";
    }
  } else {
    el.gpsText.textContent = "Brak poprawnych współrzędnych";
    el.distanceText.textContent = "—";
  }

  if (el.homeText) {
    el.homeText.textContent = state.homeGps
      ? `${state.homeGps.lat.toFixed(6)}, ${state.homeGps.lon.toFixed(6)}`
      : "—";
  }
  el.statusText.dataset.status = state.status;
  updateCompass();
}

function addRow(row) {
  state.rows.unshift(row);
  if (state.rows.length > MAX_ROWS) state.rows.pop();
  renderRows();
}

function td(text, cls) {
  const cell = document.createElement("td");
  if (cls) cell.className = cls;
  cell.textContent = text;
  return cell;
}

function tag(text, cls) {
  const s = document.createElement("span");
  s.className = `tag ${cls || ""}`.trim();
  s.textContent = text;
  return s;
}

function renderRows() {
  el.rows.innerHTML = "";
  for (const r of state.rows) {
    const tr = document.createElement("tr");

    const typeCell = document.createElement("td");
    if (r.type === "DT") typeCell.append(tag("DT", "tag--dt"));
    else if (r.type === "GPS") typeCell.append(tag("GPS", "tag--gps"));
    else if (r.type === "LOG") typeCell.append(tag("LOG", "tag--log"));
    else typeCell.append(tag(r.type, ""));
    tr.append(typeCell);

    tr.append(
      td(r.millis ?? "—"),
      td(r.temp_BMP ?? "—"),
      td(r.press_BMP ?? "—"),
      td(r.type === "DT" ? altitudeText(r.press_BMP) : "—"),
      td(r.temp_SHT ?? "—"),
      td(r.hum_SHT ?? "—"),
      td(r.co2_SCD ?? "—"),
      td(r.air_SPG ?? "—"),
      td(r.foto ?? "—"),
      td(r.lat == null ? "—" : String(r.lat)),
      td(r.lon == null ? "—" : String(r.lon)),
      td(r.message ?? r.raw ?? ""),
      td(r.ts ?? "—"),
    );

    el.rows.append(tr);
  }
}

function bearingTo(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

function updateCompass() {
  const compassWrap = document.getElementById("compassWrap");
  const compassArrow = document.getElementById("compassArrow");
  const compassBearing = document.getElementById("compassBearing");
  const compassDist = document.getElementById("compassDist");
  if (!compassWrap) return;

  const cur = state.lastGps;
  const home = state.homeGps;

  if (!cur || cur.lat == null || cur.lon == null || !home) {
    compassBearing.textContent = "—";
    compassDist.textContent = home ? "Brak pozycji GPS" : "Brak pozycji domu";
    compassArrow.style.transform = "rotate(0deg)";
    compassWrap.dataset.active = "false";
    return;
  }

  const bearing = bearingTo(cur.lat, cur.lon, home.lat, home.lon);
  const dist = haversineDistance(home.lat, home.lon, cur.lat, cur.lon);
  const distText = dist < 1 ? `${(dist * 1000).toFixed(0)} m` : `${dist.toFixed(2)} km`;

  compassArrow.style.transform = `rotate(${bearing.toFixed(1)}deg)`;
  compassBearing.textContent = `${bearing.toFixed(0)}°`;
  compassDist.textContent = `Dom: ${distText}`;
  compassWrap.dataset.active = "true";
}

let map;
let marker;
let homeMarker;
let pathLine;
const pathLatLngs = [];

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([52.237049, 21.017532], 6);
  L.tileLayer("http://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  marker = L.marker([52.237049, 21.017532], { draggable: false });
  marker.addTo(map);
  marker.bindPopup("Pozycja CanSat").openPopup();

  const homeIcon = L.divIcon({
    className: "",
    html: '<div class="home-marker">🏠</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  homeMarker = L.marker([0, 0], { icon: homeIcon, draggable: false, interactive: false });

  pathLine = L.polyline([], { color: "#2563eb", weight: 3, opacity: 0.8 }).addTo(map);
}

function updateMapFromGps(gps) {
  if (!map || !gps) return;
  if (gps.lat == null || gps.lon == null) return;
  const ll = [gps.lat, gps.lon];
  marker.setLatLng(ll);
  pathLatLngs.push(ll);
  if (pathLatLngs.length > 2000) pathLatLngs.splice(0, pathLatLngs.length - 2000);
  pathLine.setLatLngs(pathLatLngs);
  map.setView(ll, Math.max(map.getZoom(), 14), { animate: true });

  // Place home marker the first time homeGps is known
  if (state.homeGps && !map.hasLayer(homeMarker)) {
    homeMarker.setLatLng([state.homeGps.lat, state.homeGps.lon]);
    homeMarker.addTo(map);
    homeMarker.bindPopup(`Dom: ${state.homeGps.lat.toFixed(6)}, ${state.homeGps.lon.toFixed(6)}`);
  }
}

function handleParsed(p) {
  if (!p) return;
  if (p.type === "IGNORED") return;

  const frameTs = p.ts ?? nowStamp();
  el.lastFrameTs.textContent = frameTs;

  if (p.type === "DT") {
    state.lastDt = { ...p, ts: frameTs };
    renderLatest();
    addRow({ ...p, ts: frameTs, message: "" });
    return;
  }

  if (p.type === "GPS") {
    state.lastGps = { lat: p.lat, lon: p.lon, raw: p.raw };
    if (!state.homeGps && p.lat != null && p.lon != null) {
      state.homeGps = { lat: p.lat, lon: p.lon };
      pushLog("GPS", "Ustawiono pozycję domu");
    }
    renderLatest();
    updateMapFromGps(state.lastGps);
    addRow({ type: "GPS", lat: p.lat, lon: p.lon, ts: frameTs, raw: p.raw, message: "" });
    if (p.lat != null && p.lon != null) pushLog("GPS", `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`);
    else pushLog("GPS", "Odebrano dane GPS, ale bez poprawnych współrzędnych");
    return;
  }

  if (p.type === "LOG") {
    addRow({ type: "LOG", ts: frameTs, message: p.message, raw: p.raw });
    pushLog("LOG", p.message || p.raw);
    return;
  }

  if (p.type === "STATUS") {
    state.status = p.value ?? 0;
    renderLatest();
    addRow({ type: "STATUS", ts: frameTs, message: `Status: ${state.status}`, raw: p.raw });
    pushLog("STATUS", `Status CanSat: ${state.status}`);
    return;
  }

  addRow({ type: p.type, ts: frameTs, message: "", raw: p.raw });
  pushLog(p.type, p.raw);
}

function handleTextChunk(text) {
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) handleParsed(parseLine(line));
}

function normalizeBaseUrl(u) {
  const s = String(u || "").trim();
  if (!s) return null;
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function httpFetchJson(query, { timeoutMs = 4000 } = {}) {
  const base = state.http.baseUrl;
  if (!base) throw new Error("Brak baseUrl");
  const apiUrl = base.toLowerCase().endsWith(".php") ? base : `${base}/backend/api.php`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiUrl}${query}`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function ingestPollData(data) {
  const dtArr = Array.isArray(data?.dt) ? data.dt : [];
  const gpsArr = Array.isArray(data?.gps) ? data.gps : [];

  // Handle STATUS from API
  if (data?.status != null) {
    const newStatus = Number(data.status);
    if (Number.isFinite(newStatus) && newStatus !== state.status) {
      state.status = newStatus;
      pushLog("STATUS", `Status CanSat: ${state.status}`);
    }
  }

  const cmpTs = (a, b) => String(a ?? "").localeCompare(String(b ?? ""));
  const toFiniteNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  dtArr.sort((x, y) => cmpTs(x.ts, y.ts));
  gpsArr.sort((x, y) => cmpTs(x.ts, y.ts));

  const newestDt = dtArr.length ? dtArr[dtArr.length - 1] : null;
  const newestGps = gpsArr.length ? gpsArr[gpsArr.length - 1] : null;

  let maxTs = state.http.lastTimestamp;
  for (const r of dtArr) if (r?.ts && (!maxTs || cmpTs(maxTs, r.ts) < 0)) maxTs = r.ts;
  for (const r of gpsArr) if (r?.ts && (!maxTs || cmpTs(maxTs, r.ts) < 0)) maxTs = r.ts;
  if (maxTs) state.http.lastTimestamp = maxTs;

  const events = [];
  for (const dt of dtArr) {
    events.push({
      type: "DT",
      ts: dt.ts,
      millis: dt.millis ?? null,
      temp_BMP: dt.temp_BMP ?? null,
      press_BMP: dt.press_BMP ?? null,
      temp_SHT: dt.temp_SHT ?? null,
      hum_SHT: dt.hum_SHT ?? null,
      co2_SCD: dt.co2_SCD ?? null,
      air_SPG: dt.air_SPG ?? null,
      foto: dt.foto ?? null,
      lat: null,
      lon: null,
      message: "",
      raw: "",
    });
  }
  for (const gps of gpsArr) {
    const lat = toFiniteNum(gps.latitude);
    const lon = toFiniteNum(gps.longitude);
    events.push({
      type: "GPS",
      ts: gps.ts,
      millis: gps.millis ?? null,
      temp_BMP: null,
      press_BMP: null,
      temp_SHT: null,
      hum_SHT: null,
      co2_SCD: null,
      air_SPG: null,
      foto: null,
      lat,
      lon,
      message: "",
      raw: "",
    });
  }

  events.sort((a, b) => cmpTs(a.ts, b.ts));
  for (const ev of events) {
    state.rows.unshift(ev);
    if (state.rows.length > MAX_ROWS) state.rows.pop();
  }
  renderRows();

  if (newestDt) {
    state.lastDt = {
      type: "DT",
      ts: newestDt.ts,
      millis: newestDt.millis ?? null,
      temp_BMP: newestDt.temp_BMP ?? null,
      press_BMP: newestDt.press_BMP ?? null,
      temp_SHT: newestDt.temp_SHT ?? null,
      hum_SHT: newestDt.hum_SHT ?? null,
      co2_SCD: newestDt.co2_SCD ?? null,
      air_SPG: newestDt.air_SPG ?? null,
      foto: newestDt.foto ?? null,
      raw: "",
      message: "",
    };
  }

  if (newestGps) {
    for (const gpsPoint of gpsArr) {
      const lat = toFiniteNum(gpsPoint.latitude);
      const lon = toFiniteNum(gpsPoint.longitude);
      if (!state.homeGps && lat != null && lon != null) {
        state.homeGps = { lat, lon };
        pushLog("GPS", `Ustawiono pozycję domu: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
      }
      const gpsForPath = {
        ts: gpsPoint.ts,
        lat,
        lon,
        raw: "",
      };
      updateMapFromGps(gpsForPath);
    }
    state.lastGps = {
      ts: newestGps.ts,
      lat: toFiniteNum(newestGps.latitude),
      lon: toFiniteNum(newestGps.longitude),
      raw: "",
    };
  }

  renderLatest();
}

async function fetchData() {
  const since = state.http.lastTimestamp;
  const sinceParam = since ? `?since_ts=${encodeURIComponent(since)}` : "";
  const data = await httpFetchJson(`${sinceParam}`);
  ingestPollData(data || {});
}

function connectHttp(baseUrl) {
  disconnectHttp();
  state.http.baseUrl = normalizeBaseUrl(baseUrl);
  if (!state.http.baseUrl) {
    setConn("bad", "Brak adresu HTTP");
    return;
  }

  clearAll();

  setConn("warn", "Łączenie…");
  el.connect.disabled = true;
  el.disconnect.disabled = false;
  state.http.running = true;
  state.http.lastTimestamp = null;
  pushLog("HTTP", `Ustawiono API: ${state.http.baseUrl}`);

  const tick = async () => {
    if (!state.http.running) return;
    try {
      await fetchData();
      setConn("ok", "Połączono (HTTP)");
    } catch (e) {
      setConn("bad", "Błąd HTTP");
      pushLog("HTTP", `Błąd: ${String(e?.message || e)}`);
    }
  };

  tick();
  state.http.timer = setInterval(tick, 1000);
}

function disconnectHttp() {
  state.http.running = false;
  if (state.http.timer) clearInterval(state.http.timer);
  state.http.timer = null;
  state.http.baseUrl = null;
  state.http.lastTimestamp = null;
  el.connect.disabled = false;
  el.disconnect.disabled = true;
}

function clearAll() {
  state.lastDt = null;
  state.lastGps = null;
  state.homeGps = null;
  state.http.lastTimestamp = null;
  state.rows = [];
  state.logLines = [];
  el.lastFrameTs.textContent = "—";
  el.lastMillis.textContent = "—";
  el.gpsText.textContent = "—";
  el.distanceText.textContent = "—";
  if (el.homeText) el.homeText.textContent = "—";
  el.rows.innerHTML = "";
  el.log.textContent = "";
  pathLatLngs.splice(0, pathLatLngs.length);
  if (pathLine) pathLine.setLatLngs([]);
  if (homeMarker && map && map.hasLayer(homeMarker)) homeMarker.remove();
  renderLatest();
  pushLog("SYS", "Wyczyszczono dane");
}

function wireUi() {
  const savedHttp = localStorage.getItem("telemetry.httpBaseUrl");
  el.sourceMode.value = "http";
  el.httpBaseUrl.value = savedHttp || `${window.location.origin}`;

  el.connect.addEventListener("click", () => {
    const base = el.httpBaseUrl.value.trim();
    if (!base) return;
    localStorage.setItem("telemetry.httpBaseUrl", base);
    connectHttp(base);
  });

  el.disconnect.addEventListener("click", () => {
    disconnectHttp();
    setConn("idle", "Brak połączenia");
    pushLog("HTTP", "Rozłączono");
  });

  el.fileInput.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    pushLog("FILE", `Wczytano plik: ${file.name} (${file.size} B)`);
    handleTextChunk(text);
    ev.target.value = "";
  });

  el.clear.addEventListener("click", () => clearAll());

  document.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const text = await file.text();
    pushLog("FILE", `Wczytano plik (D&D): ${file.name} (${file.size} B)`);
    handleTextChunk(text);
  });
}

createCards();
initMap();
wireUi();
setConn("idle", "Brak połączenia");
if (el.httpBaseUrl.value) {
  connectHttp(el.httpBaseUrl.value);
}
