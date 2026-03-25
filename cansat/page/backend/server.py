#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DB_PATH = os.environ.get("TELEMETRY_DB", os.path.join(ROOT_DIR, "telemetry.db"))


def now_ts() -> str:
  return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def db_connect() -> sqlite3.Connection:
  conn = sqlite3.connect(DB_PATH)
  conn.row_factory = sqlite3.Row
  return conn


def db_init() -> None:
  # Read-only UI: zakładamy, że dane są już wrzucane do DB przez inny proces.
  # Ten backend tworzy tylko tabele, jeśli ich jeszcze nie ma.
  with db_connect() as conn:
    conn.execute(
      """
      CREATE TABLE IF NOT EXISTS DT (
        TS TIMESTAMP DEFAULT CURRENT_TIMESTAMP PRIMARY KEY,
        millis BIGINT,
        temp_BMP VARCHAR(16),
        temp_SHT VARCHAR(16),
        hum_SHT VARCHAR(16),
        cot_SCD VARCHAR(16),
        air_SPG VARCHAR(16),
        metan INT,
        wartoscFotor INT
      )
      """
    )
    conn.execute(
      """
      CREATE TABLE IF NOT EXISTS GPS (
        TS TIMESTAMP DEFAULT CURRENT_TIMESTAMP PRIMARY KEY,
        millis BIGINT,
        latitude DOUBLE,
        longitude DOUBLE,
        distanceToHome BIGINT,
        courseToHome DOUBLE,
        satellites INT
      )
      """
    )
    conn.execute(
      """
      CREATE TABLE IF NOT EXISTS DTP (
        TS TIMESTAMP DEFAULT CURRENT_TIMESTAMP PRIMARY KEY,
        refTEMP DOUBLE,
        press_BMP VARCHAR(16)
      )
      """
    )
    conn.commit()


def split_pipes(line: str) -> list[str]:
  return [p.strip() for p in line.split("|") if p.strip()]


def parse_line(line: str) -> dict | None:
  s = (line or "").strip()
  if not s:
    return None
  if s == "START" or s.startswith("START |"):
    return {"type": "IGNORED", "raw": s}

  parts = split_pipes(s)
  if not parts:
    return None

  t = parts[0]
  if t == "DT":
    # DT | millis | temp_BMP | press_BMP | temp_SHT | hum_SHT | co2_SCD | air_SPG | foto
    def v(i: int) -> str | None:
      return parts[i] if len(parts) > i else None

    return {
      "type": "DT",
      "millis": v(1),
      "temp_BMP": v(2),
      "press_BMP": v(3),
      "temp_SHT": v(4),
      "hum_SHT": v(5),
      "co2_SCD": v(6),
      "air_SPG": v(7),
      "foto": v(8),
      "raw": s,
    }

  if t == "LOG":
    return {"type": "LOG", "message": " | ".join(parts[1:]) if len(parts) > 1 else "", "raw": s}

  if t == "GPS":
    lat = None
    lon = None
    # keyed: lat=... lon=...
    for p in parts[1:]:
      pl = p.lower()
      if pl.startswith("lat=") or pl.startswith("latitude="):
        try:
          lat = float(p.split("=", 1)[1].strip().replace(",", "."))
        except Exception:
          lat = None
      if pl.startswith("lon=") or pl.startswith("lng=") or pl.startswith("longitude="):
        try:
          lon = float(p.split("=", 1)[1].strip().replace(",", "."))
        except Exception:
          lon = None
    # positional: GPS | <lat> | <lon>
    if lat is None and lon is None and len(parts) >= 3:
      try:
        lat = float(parts[1].replace(",", "."))
        lon = float(parts[2].replace(",", "."))
      except Exception:
        lat = None
        lon = None
    return {"type": "GPS", "lat": lat, "lon": lon, "raw": s}

  return {"type": "UNKNOWN", "raw": s}


def insert_records(lines: list[str]) -> int:
  records = []
  for ln in lines:
    rec = parse_line(ln)
    if not rec or rec.get("type") == "IGNORED":
      continue
    rec["ts"] = now_ts()
    records.append(rec)

  if not records:
    return 0

  with db_connect() as conn:
    for r in records:
      conn.execute(
        """
        INSERT INTO telemetry(
          ts, type, millis, temp_BMP, press_BMP, temp_SHT, hum_SHT, co2_SCD, air_SPG, foto,
          lat, lon, message, raw
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
          r.get("ts"),
          r.get("type"),
          r.get("millis"),
          r.get("temp_BMP"),
          r.get("press_BMP"),
          r.get("temp_SHT"),
          r.get("hum_SHT"),
          r.get("co2_SCD"),
          r.get("air_SPG"),
          r.get("foto"),
          r.get("lat"),
          r.get("lon"),
          r.get("message"),
          r.get("raw"),
        ),
      )
    conn.commit()
  return len(records)


def fetch_latest() -> dict:
  out: dict = {"dt": None, "gps": None, "logs": []}
  with db_connect() as conn:
    # DT + DTP (ciśnienie z DTP dopięte do najbliższego poprzedniego timestampu DT).
    dt = conn.execute(
      """
      SELECT
        dt.TS as ts,
        dt.millis as millis,
        dt.temp_BMP as temp_BMP,
        dt.temp_SHT as temp_SHT,
        dt.hum_SHT as hum_SHT,
        dt.cot_SCD as cot_SCD,
        dt.air_SPG as air_SPG,
        dt.wartoscFotor as wartoscFotor,
        (
          SELECT dtp.press_BMP
          FROM DTP dtp
          WHERE dtp.TS <= dt.TS
          ORDER BY dtp.TS DESC
          LIMIT 1
        ) as press_BMP,
        (
          SELECT dtp.refTEMP
          FROM DTP dtp
          WHERE dtp.TS <= dt.TS
          ORDER BY dtp.TS DESC
          LIMIT 1
        ) as refTEMP
      FROM DT dt
      ORDER BY dt.TS DESC
      LIMIT 1
      """
    ).fetchone()

    if dt:
      ref_tmp = dt["refTEMP"]
      ref_msg = "" if ref_tmp is None else f"refTEMP={ref_tmp}"
      out["dt"] = {
        "ts": dt["ts"],
        "millis": dt["millis"],
        "temp_BMP": dt["temp_BMP"],
        "press_BMP": dt["press_BMP"],
        "temp_SHT": dt["temp_SHT"],
        "hum_SHT": dt["hum_SHT"],
        # UI oczekuje `co2_SCD`, a w Twojej bazie jest `cot_SCD`.
        "co2_SCD": dt["cot_SCD"],
        "air_SPG": dt["air_SPG"],
        "foto": dt["wartoscFotor"],
        "message": ref_msg,
        "raw": "",
      }

    gps = conn.execute(
      """
      SELECT
        gps.TS as ts,
        gps.millis as millis,
        gps.latitude as latitude,
        gps.longitude as longitude
      FROM GPS gps
      ORDER BY gps.TS DESC
      LIMIT 1
      """
    ).fetchone()
    if gps:
      out["gps"] = {
        "ts": gps["ts"],
        "millis": gps["millis"],
        "lat": gps["latitude"],
        "lon": gps["longitude"],
        "raw": "",
      }

  return out


def fetch_recent(limit: int = 250) -> list[dict]:
  limit = max(1, min(2000, int(limit)))
  with db_connect() as conn:
    # Historia: DT + GPS (ciśnienie dopięte z DTP do każdego wiersza DT).
    dt_rows = conn.execute(
      """
      SELECT
        dt.TS as ts,
        dt.millis as millis,
        dt.temp_BMP as temp_BMP,
        dt.temp_SHT as temp_SHT,
        dt.hum_SHT as hum_SHT,
        dt.cot_SCD as cot_SCD,
        dt.air_SPG as air_SPG,
        dt.wartoscFotor as wartoscFotor,
        (
          SELECT dtp.press_BMP
          FROM DTP dtp
          WHERE dtp.TS <= dt.TS
          ORDER BY dtp.TS DESC
          LIMIT 1
        ) as press_BMP,
        (
          SELECT dtp.refTEMP
          FROM DTP dtp
          WHERE dtp.TS <= dt.TS
          ORDER BY dtp.TS DESC
          LIMIT 1
        ) as refTEMP
      FROM DT dt
      ORDER BY dt.TS DESC
      LIMIT ?
      """,
      (limit,),
    ).fetchall()

    gps_rows = conn.execute(
      """
      SELECT
        gps.TS as ts,
        gps.millis as millis,
        gps.latitude as latitude,
        gps.longitude as longitude
      FROM GPS gps
      ORDER BY gps.TS DESC
      LIMIT ?
      """,
      (limit,),
    ).fetchall()

    rows: list[dict] = []
    for dt in dt_rows:
      ref_tmp = dt["refTEMP"]
      ref_msg = "" if ref_tmp is None else f"refTEMP={ref_tmp}"
      rows.append(
        {
          "type": "DT",
          "ts": dt["ts"],
          "millis": dt["millis"],
          "temp_BMP": dt["temp_BMP"],
          "press_BMP": dt["press_BMP"],
          "temp_SHT": dt["temp_SHT"],
          "hum_SHT": dt["hum_SHT"],
          "co2_SCD": dt["cot_SCD"],
          "air_SPG": dt["air_SPG"],
          "foto": dt["wartoscFotor"],
          "message": ref_msg,
          "raw": "",
          "lat": None,
          "lon": None,
        }
      )

    for gps in gps_rows:
      rows.append(
        {
          "type": "GPS",
          "ts": gps["ts"],
          "millis": gps["millis"],
          "lat": gps["latitude"],
          "lon": gps["longitude"],
          "message": "",
          "raw": "",
          "temp_BMP": None,
          "press_BMP": None,
          "temp_SHT": None,
          "hum_SHT": None,
          "co2_SCD": None,
          "air_SPG": None,
          "foto": None,
        }
      )

    rows.sort(key=lambda r: r.get("ts") or "", reverse=True)
    return rows[:limit]


class Handler(SimpleHTTPRequestHandler):
  def __init__(self, *args, **kwargs):
    super().__init__(*args, directory=ROOT_DIR, **kwargs)

  def _send_json(self, obj: object, code: int = 200) -> None:
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    self.send_response(code)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Cache-Control", "no-store")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.end_headers()
    self.wfile.write(data)

  def _send_text(self, text: str, code: int = 200) -> None:
    data = text.encode("utf-8")
    self.send_response(code)
    self.send_header("Content-Type", "text/plain; charset=utf-8")
    self.send_header("Cache-Control", "no-store")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.end_headers()
    self.wfile.write(data)

  def do_OPTIONS(self):
    self.send_response(204)
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    self.send_header("Access-Control-Allow-Headers", "Content-Type")
    self.end_headers()

  def do_GET(self):
    u = urlparse(self.path)
    if u.path == "/api/health":
      self._send_json({"ok": True, "ts": now_ts(), "db": DB_PATH})
      return
    if u.path == "/api/latest":
      self._send_json(fetch_latest())
      return
    if u.path == "/api/recent":
      qs = parse_qs(u.query or "")
      limit = qs.get("limit", ["250"])[0]
      self._send_json(fetch_recent(limit=int(limit)))
      return
    return super().do_GET()

  def do_POST(self):
    u = urlparse(self.path)
    if u.path == "/api/ingest":
      # UI ma wyłącznie czytać dane z bazy i je pokazywać.
      self._send_text("POST /api/ingest disabled (read-only UI)", code=405)
      return
    self._send_text("Not found", code=404)


def main() -> None:
  db_init()
  host = os.environ.get("HOST", "0.0.0.0")
  port = int(os.environ.get("PORT", "8081"))
  httpd = ThreadingHTTPServer((host, port), Handler)
  print(f"Serving {ROOT_DIR} on http://{host}:{port}  (DB: {DB_PATH})")
  httpd.serve_forever()


if __name__ == "__main__":
  main()

