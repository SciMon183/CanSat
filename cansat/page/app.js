/* global L */

const MAX_ROWS = 250;
const MAX_LOG_LINES = 300;

const SENSOR_SCHEMA = [
  { key: "temp_BMP", label: "Temperatura BMP", unit: "°C", hint: "temp_BMP" },
  { key: "press_BMP", label: "Ciśnienie BMP", unit: "hPa", hint: "press_BMP" },
  { key: "temp_SHT", label: "Temperatura SHT", unit: "°C", hint: "temp_SHT" },
  { key: "hum_SHT", label: "Wilgotność SHT", unit: "%", hint: "hum_SHT" },
  { key: "co2_SCD", label: "CO₂ SCD", unit: "ppm", hint: "co2_SCD" },
  { key: "air_SPG", label: "air_SPG", unit: "", hint: "air_SPG" },
  { key: "foto", label: "Fotorezystor", unit: "", hint: "wart_fotorezystor" },
];

const state = {
  ws: null,
  http: { baseUrl: null, timer: null, running: false, lastId: null },
  lastDt: null,
  lastGps: null,
  rows: [],
  logLines: [],
};

const el = {
  connStatus: document.getElementById("connStatus"),
  sourceMode: document.getElementById("sourceMode"),
  wsUrl: document.getElementById("wsUrl"),
  httpBaseUrl: document.getElementById("httpBaseUrl"),
  connect: document.getElementById("connect"),
  disconnect: document.getElementById("disconnect"),
  lastFrameTs: document.getElementById("lastFrameTs"),
  lastMillis: document.getElementById("lastMillis"),
  cards: document.getElementById("cards"),
  rows: document.getElementById("rows"),
  log: document.getElementById("log"),
  gpsText: document.getElementById("gpsText"),
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

function splitPipes(line) {
  return line
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function parseGpsLine(line) {
  // Supported:
  // GPS | lat=50.1234 | lon=19.9876
  // GPS | 50.1234 | 19.9876
  const parts = splitPipes(line);
  if (parts[0] !== "GPS") return null;

  const tryKeyed = () => {
    let lat = null;
    let lon = null;
    for (const p of parts.slice(1)) {
      const m = p.match(/^(lat|latitude)\s*=\s*(.+)$/i);
      if (m) lat = toNumberMaybe(m[2]);
      const m2 = p.match(/^(lon|lng|longitude)\s*=\s*(.+)$/i);
      if (m2) lon = toNumberMaybe(m2[2]);
    }
    if (lat == null || lon == null) return null;
    return { lat, lon, raw: line };
  };

  const keyed = tryKeyed();
  if (keyed) return keyed;

  if (parts.length >= 3) {
    const lat = toNumberMaybe(parts[1]);
    const lon = toNumberMaybe(parts[2]);
    if (lat != null && lon != null) return { lat, lon, raw: line };
  }

  return { lat: null, lon: null, raw: line };
}

function parseDtLine(line) {
  const parts = splitPipes(line);
  if (parts[0] !== "DT") return null;
  // DT | millis() | temp_BMP | press_BMP | temp_SHT | hum_SHT | co2_SCD | air_SPG | foto
  const millis = parts[1] ?? null;
  const v = (i) => (parts.length > i ? parts[i] : null);

  return {
    type: "DT",
    millis,
    temp_BMP: v(2),
    press_BMP: v(3),
    temp_SHT: v(4),
    hum_SHT: v(5),
    co2_SCD: v(6),
    air_SPG: v(7),
    foto: v(8),
    raw: line,
  };
}

function parseLogLine(line) {
  const parts = splitPipes(line);
  if (parts[0] !== "LOG") return null;
  return { type: "LOG", message: parts.slice(1).join(" | ") || "", raw: line };
}

function parseLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return null;
  if (trimmed === "START" || trimmed.startsWith("START |")) return { type: "IGNORED", raw: trimmed };
  if (trimmed.startsWith("DT")) return parseDtLine(trimmed);
  if (trimmed.startsWith("GPS")) return { type: "GPS", ...parseGpsLine(trimmed) };
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
  } else {
    el.lastMillis.textContent = fmtValue(dt.millis).text;
    setCardValue("temp_BMP", dt.temp_BMP, "°C");
    setCardValue("press_BMP", dt.press_BMP, "hPa");
    setCardValue("temp_SHT", dt.temp_SHT, "°C");
    setCardValue("hum_SHT", dt.hum_SHT, "%");
    setCardValue("co2_SCD", dt.co2_SCD, "ppm");
    setCardValue("air_SPG", dt.air_SPG, "");
    setCardValue("foto", dt.foto, "");
  }

  const gps = state.lastGps;
  if (!gps) {
    el.gpsText.textContent = "—";
  } else if (gps.lat != null && gps.lon != null) {
    el.gpsText.textContent = `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}`;
  } else {
    el.gpsText.textContent = "Brak poprawnych współrzędnych";
  }
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

let map;
let marker;
let pathLine;
const pathLatLngs = [];

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([52.237049, 21.017532], 6); // PL default
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  marker = L.marker([52.237049, 21.017532], { draggable: false });
  marker.addTo(map);
  marker.bindPopup("Pozycja CanSat").openPopup();

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
}

function handleParsed(p) {
  if (!p) return;
  if (p.type === "IGNORED") return;

  const ts = nowStamp();
  el.lastFrameTs.textContent = ts;

  if (p.type === "DT") {
    state.lastDt = p;
    renderLatest();
    addRow({ ...p, ts, message: "" });
    return;
  }

  if (p.type === "GPS") {
    state.lastGps = { lat: p.lat, lon: p.lon, raw: p.raw };
    renderLatest();
    updateMapFromGps(state.lastGps);
    addRow({ type: "GPS", lat: p.lat, lon: p.lon, ts, raw: p.raw, message: "" });
    if (p.lat != null && p.lon != null) pushLog("GPS", `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`);
    else pushLog("GPS", "Odebrano dane GPS, ale bez poprawnych współrzędnych");
    return;
  }

  if (p.type === "LOG") {
    addRow({ type: "LOG", ts, message: p.message, raw: p.raw });
    pushLog("LOG", p.message || p.raw);
    return;
  }

  addRow({ type: p.type, ts, message: "", raw: p.raw });
  pushLog(p.type, p.raw);
}

function handleTextChunk(text) {
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) handleParsed(parseLine(line));
}

function connectWs(url) {
  try {
    disconnectHttp();
    const ws = new WebSocket(url);
    state.ws = ws;

    setConn("warn", "Łączenie…");
    el.connect.disabled = true;
    el.disconnect.disabled = false;

    ws.addEventListener("open", () => {
      setConn("ok", "Połączono");
      pushLog("WS", `Połączono: ${url}`);
    });

    ws.addEventListener("message", (ev) => {
      const data = ev.data;
      if (typeof data === "string") handleTextChunk(data);
      else if (data instanceof Blob) data.text().then(handleTextChunk).catch(() => {});
      else pushLog("WS", "Odebrano nieobsługiwany typ wiadomości");
    });

    ws.addEventListener("close", () => {
      if (state.ws === ws) state.ws = null;
      setConn("idle", "Brak połączenia");
      el.connect.disabled = false;
      el.disconnect.disabled = true;
      pushLog("WS", "Rozłączono");
    });

    ws.addEventListener("error", () => {
      setConn("bad", "Błąd połączenia");
      pushLog("WS", "Błąd WebSocket");
    });
  } catch (e) {
    setConn("bad", "Nieprawidłowy adres");
    pushLog("WS", `Nie udało się połączyć: ${String(e?.message || e)}`);
    el.connect.disabled = false;
    el.disconnect.disabled = true;
  }
}

function disconnectWs() {
  if (!state.ws) return;
  try {
    state.ws.close();
  } catch {
    // ignore
  } finally {
    state.ws = null;
    setConn("idle", "Brak połączenia");
    el.connect.disabled = false;
    el.disconnect.disabled = true;
  }
}

function normalizeBaseUrl(u) {
  const s = String(u || "").trim();
  if (!s) return null;
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function httpFetchJson(path, { timeoutMs = 4000 } = {}) {
  const base = state.http.baseUrl;
  if (!base) throw new Error("Brak baseUrl");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function ingestRecordFromApi(rec) {
  // API returns already-normalized records compatible with table fields.
  if (!rec || !rec.type) return;
  if (rec.type === "DT") {
    state.lastDt = {
      type: "DT",
      millis: rec.millis ?? null,
      temp_BMP: rec.temp_BMP ?? null,
      press_BMP: rec.press_BMP ?? null,
      temp_SHT: rec.temp_SHT ?? null,
      hum_SHT: rec.hum_SHT ?? null,
      co2_SCD: rec.co2_SCD ?? null,
      air_SPG: rec.air_SPG ?? null,
      foto: rec.foto ?? null,
      raw: rec.raw ?? "",
    };
    renderLatest();
    addRow({ ...state.lastDt, ts: rec.ts || nowStamp(), message: "" });
    return;
  }
  if (rec.type === "GPS") {
    const lat = rec.lat == null ? null : Number(rec.lat);
    const lon = rec.lon == null ? null : Number(rec.lon);
    state.lastGps = { lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null, raw: rec.raw ?? "" };
    renderLatest();
    updateMapFromGps(state.lastGps);
    addRow({ type: "GPS", lat: state.lastGps.lat, lon: state.lastGps.lon, ts: rec.ts || nowStamp(), raw: rec.raw ?? "", message: "" });
    return;
  }
  if (rec.type === "LOG") {
    addRow({ type: "LOG", ts: rec.ts || nowStamp(), message: rec.message ?? "", raw: rec.raw ?? "" });
    pushLog("LOG", rec.message ?? rec.raw ?? "");
    return;
  }
  addRow({ type: rec.type, ts: rec.ts || nowStamp(), message: rec.message ?? "", raw: rec.raw ?? "" });
}

async function httpPollOnce() {
  const latest = await httpFetchJson("/api/latest");
  if (latest?.dt) ingestRecordFromApi({ ...latest.dt, type: "DT" });
  if (latest?.gps) ingestRecordFromApi({ ...latest.gps, type: "GPS" });

  if (Array.isArray(latest?.logs)) {
    for (const l of latest.logs) ingestRecordFromApi({ ...l, type: "LOG" });
  }
}

function connectHttp(baseUrl) {
  disconnectWs();
  disconnectHttp();
  state.http.baseUrl = normalizeBaseUrl(baseUrl);
  if (!state.http.baseUrl) {
    setConn("bad", "Brak adresu HTTP");
    return;
  }

  setConn("warn", "Łączenie…");
  el.connect.disabled = true;
  el.disconnect.disabled = false;
  state.http.running = true;
  pushLog("HTTP", `Ustawiono API: ${state.http.baseUrl}`);

  const tick = async () => {
    if (!state.http.running) return;
    try {
      await httpPollOnce();
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
}

function clearAll() {
  state.lastDt = null;
  state.lastGps = null;
  state.rows = [];
  state.logLines = [];
  el.lastFrameTs.textContent = "—";
  el.lastMillis.textContent = "—";
  el.gpsText.textContent = "—";
  el.rows.innerHTML = "";
  el.log.textContent = "";
  pathLatLngs.splice(0, pathLatLngs.length);
  if (pathLine) pathLine.setLatLngs([]);
  renderLatest();
  pushLog("SYS", "Wyczyszczono dane");
}

function wireUi() {
  const savedMode = localStorage.getItem("telemetry.sourceMode");
  el.sourceMode.value = savedMode || "ws";

  const savedWs = localStorage.getItem("telemetry.wsUrl");
  el.wsUrl.value = savedWs || "ws://localhost:8080";

  const savedHttp = localStorage.getItem("telemetry.httpBaseUrl");
  el.httpBaseUrl.value = savedHttp || "http://raspberrypi.local:8081";

  el.sourceMode.addEventListener("change", () => {
    localStorage.setItem("telemetry.sourceMode", el.sourceMode.value);
  });

  el.connect.addEventListener("click", () => {
    const mode = el.sourceMode.value;
    if (mode === "ws") {
      const url = el.wsUrl.value.trim();
      if (!url) return;
      localStorage.setItem("telemetry.wsUrl", url);
      connectWs(url);
      return;
    }
    if (mode === "http") {
      const base = el.httpBaseUrl.value.trim();
      if (!base) return;
      localStorage.setItem("telemetry.httpBaseUrl", base);
      connectHttp(base);
    }
  });

  el.disconnect.addEventListener("click", () => {
    disconnectWs();
    disconnectHttp();
    setConn("idle", "Brak połączenia");
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

  // drag & drop on whole page
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

function seedExample() {
  // Minimalny przykład na start (żeby UI nie było puste)
  handleTextChunk("LOG | OtwarciePlikuNaKarcieSD\nDT | 24637 | NA | NA | NA | NA | 1103 | 0 | 0\nGPS | lat=52.237049 | lon=21.017532\nSTART");
}

createCards();
initMap();
wireUi();
seedExample();
setConn("idle", "Brak połączenia");
