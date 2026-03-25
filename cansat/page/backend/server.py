#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# MariaDB / MySQL connection (read-only UI)
DB_HOST = os.environ.get("DB_HOST", "127.0.0.1")
DB_PORT = int(os.environ.get("DB_PORT", "3306"))
DB_USER = os.environ.get("DB_USER", "root")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")
DB_NAME = os.environ.get("DB_NAME", "")

DT_TABLE = os.environ.get("DT_TABLE", "DT")
GPS_TABLE = os.environ.get("GPS_TABLE", "GPS")
DTP_TABLE = os.environ.get("DTP_TABLE", "DTP")


def now_ts() -> str:
  return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def _ensure_driver():
  # Try common drivers. The UI will only work if one of these is installed.
  # Typical commands on target machine:
  #   pip3 install pymysql
  #   pip3 install mariadb
  #   pip3 install mysql-connector-python
  for mod in ("pymysql", "mariadb", "mysql.connector"):
    try:
      parts = mod.split(".")
      if len(parts) == 1:
        __import__(mod)
      else:
        __import__(parts[0])
      return mod
    except Exception:
      continue
  return None


def _format_ts(v) -> str | None:
  if v is None:
    return None
  if isinstance(v, datetime):
    return v.strftime("%Y-%m-%d %H:%M:%S")
  return str(v)


def _rows_to_dicts(cur, rows):
  # Different MariaDB/MySQL drivers return rows either as dict-like objects or tuples.
  if not rows:
    return []
  if isinstance(rows[0], dict):
    return rows
  desc = [c[0] for c in (cur.description or [])]
  out = []
  for r in rows:
    if isinstance(r, dict):
      out.append(r)
    else:
      out.append({desc[i]: r[i] for i in range(min(len(desc), len(r)))})
  return out


def db_connect():
  driver = _ensure_driver()
  if not driver:
    raise RuntimeError(
      "Brak sterownika do MariaDB w Pythonie. Zainstaluj np. `pymysql` albo `mariadb` albo `mysql-connector-python`."
    )

  if driver == "pymysql":
    import pymysql

    return pymysql.connect(
      host=DB_HOST,
      port=DB_PORT,
      user=DB_USER,
      password=DB_PASSWORD,
      database=DB_NAME,
      cursorclass=pymysql.cursors.DictCursor,
      autocommit=True,
    )

  if driver == "mariadb":
    import mariadb

    # mariadb-python-client zwraca mapy w zaleznosci od ustawien; najszybciej: DictCursor przez `cursor()`.
    conn = mariadb.connect(host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD, database=DB_NAME)
    return conn

  # mysql.connector
  import mysql.connector

  return mysql.connector.connect(host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD, database=DB_NAME)


def db_init() -> None:
  # Read-only UI: nie tworzymy nic w bazie.
  return


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
  conn = db_connect()
  try:
    # DT + DTP (ciśnienie z DTP dopięte do najbliższego poprzedniego timestampu DT).
    sql_dt = f"""
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
          FROM {DTP_TABLE} dtp
          WHERE dtp.TS <= dt.TS
          ORDER BY dtp.TS DESC
          LIMIT 1
        ) as press_BMP,
        (
          SELECT dtp.refTEMP
          FROM {DTP_TABLE} dtp
          WHERE dtp.TS <= dt.TS
          ORDER BY dtp.TS DESC
          LIMIT 1
        ) as refTEMP
      FROM {DT_TABLE} dt
      ORDER BY dt.TS DESC
      LIMIT 1
    """

    cur = conn.cursor()
    cur.execute(sql_dt)
    dt = cur.fetchone()
    if dt is not None and not isinstance(dt, dict):
      desc = [c[0] for c in (cur.description or [])]
      dt = {desc[i]: dt[i] for i in range(min(len(desc), len(dt)))}

    if dt:
      ref_tmp = dt.get("refTEMP")
      ref_msg = "" if ref_tmp is None else f"refTEMP={ref_tmp}"
      out["dt"] = {
        "ts": _format_ts(dt.get("ts")),
        "millis": dt.get("millis"),
        "temp_BMP": dt.get("temp_BMP"),
        "press_BMP": dt.get("press_BMP"),
        "temp_SHT": dt.get("temp_SHT"),
        "hum_SHT": dt.get("hum_SHT"),
        # UI oczekuje `co2_SCD`, a w Twojej bazie jest `cot_SCD`.
        "co2_SCD": dt.get("cot_SCD"),
        "air_SPG": dt.get("air_SPG"),
        "foto": dt.get("wartoscFotor"),
        "message": ref_msg,
        "raw": "",
      }

    sql_gps = f"""
      SELECT
        gps.TS as ts,
        gps.millis as millis,
        gps.latitude as latitude,
        gps.longitude as longitude
      FROM {GPS_TABLE} gps
      ORDER BY gps.TS DESC
      LIMIT 1
    """
    cur.execute(sql_gps)
    gps = cur.fetchone()
    if gps is not None and not isinstance(gps, dict):
      desc = [c[0] for c in (cur.description or [])]
      gps = {desc[i]: gps[i] for i in range(min(len(desc), len(gps)))}
    if gps:
      out["gps"] = {
        "ts": _format_ts(gps.get("ts")),
        "millis": gps.get("millis"),
        "lat": gps.get("latitude"),
        "lon": gps.get("longitude"),
        "raw": "",
      }
  finally:
    try:
      conn.close()
    except Exception:
      pass

  return out


def fetch_recent(limit: int = 250) -> list[dict]:
  limit = max(1, min(2000, int(limit)))
  conn = db_connect()
  try:
    cur = conn.cursor()

    sql_dt = f"""
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
          FROM {DTP_TABLE} dtp
          WHERE dtp.TS <= dt.TS
          ORDER BY dtp.TS DESC
          LIMIT 1
        ) as press_BMP,
        (
          SELECT dtp.refTEMP
          FROM {DTP_TABLE} dtp
          WHERE dtp.TS <= dt.TS
          ORDER BY dtp.TS DESC
          LIMIT 1
        ) as refTEMP
      FROM {DT_TABLE} dt
      ORDER BY dt.TS DESC
      LIMIT {limit}
    """
    cur.execute(sql_dt)
    dt_rows = _rows_to_dicts(cur, cur.fetchall() or [])

    sql_gps = f"""
      SELECT
        gps.TS as ts,
        gps.millis as millis,
        gps.latitude as latitude,
        gps.longitude as longitude
      FROM {GPS_TABLE} gps
      ORDER BY gps.TS DESC
      LIMIT {limit}
    """
    cur.execute(sql_gps)
    gps_rows = _rows_to_dicts(cur, cur.fetchall() or [])

    rows: list[dict] = []
    for dt in dt_rows:
      ref_tmp = dt.get("refTEMP")
      ref_msg = "" if ref_tmp is None else f"refTEMP={ref_tmp}"
      rows.append(
        {
          "type": "DT",
          "ts": _format_ts(dt.get("ts")),
          "millis": dt.get("millis"),
          "temp_BMP": dt.get("temp_BMP"),
          "press_BMP": dt.get("press_BMP"),
          "temp_SHT": dt.get("temp_SHT"),
          "hum_SHT": dt.get("hum_SHT"),
          "co2_SCD": dt.get("cot_SCD"),
          "air_SPG": dt.get("air_SPG"),
          "foto": dt.get("wartoscFotor"),
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
          "ts": _format_ts(gps.get("ts")),
          "millis": gps.get("millis"),
          "lat": gps.get("latitude"),
          "lon": gps.get("longitude"),
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

    # Sortujemy po timestamp (string w formacie YYYY-MM-DD HH:MM:SS).
    rows.sort(key=lambda r: r.get("ts") or "", reverse=True)
    return rows[:limit]
  finally:
    try:
      conn.close()
    except Exception:
      pass


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
      self._send_json(
        {"ok": True, "ts": now_ts(), "db": f"{DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}", "tables": {"DT": DT_TABLE, "GPS": GPS_TABLE, "DTP": DTP_TABLE}}
      )
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
  print(f"Serving {ROOT_DIR} on http://{host}:{port}  (MariaDB: {DB_HOST}:{DB_PORT}/{DB_NAME})")
  httpd.serve_forever()


if __name__ == "__main__":
  main()

