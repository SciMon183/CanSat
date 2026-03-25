<?php
declare(strict_types=1);

// Stateless HTTP endpoint.
// Returns: { "dt": [...], "gps": [...] }
// Only rows newer than GET parameter `since_ts` are returned.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('Access-Control-Allow-Origin: *');

function respond(int $code, array $payload): void {
  http_response_code($code);
  echo json_encode($payload, JSON_UNESCAPED_UNICODE);
  exit;
}

try {
  $sinceTs = isset($_GET['since_ts']) && trim((string)$_GET['since_ts']) !== '' ? (string)$_GET['since_ts'] : null;

  $DB_HOST = getenv('DB_HOST') ?: '127.0.0.1';
  $DB_PORT = (int)(getenv('DB_PORT') ?: '3306');
  $DB_USER = getenv('DB_USER') ?: 'cansat';
  $DB_PASSWORD = getenv('DB_PASSWORD') ?: 'haslo';
  $DB_NAME = getenv('DB_NAME') ?: 'cansat';

  $DT_TABLE = getenv('DT_TABLE') ?: 'DT';
  $GPS_TABLE = getenv('GPS_TABLE') ?: 'GPS';
  $DTP_TABLE = getenv('DTP_TABLE') ?: 'DTP';

  $HISTORY_DT_LIMIT = (int)(getenv('HISTORY_DT_LIMIT') ?: '200');
  $HISTORY_GPS_LIMIT = (int)(getenv('HISTORY_GPS_LIMIT') ?: '50');
  $INCR_LIMIT_DT = (int)(getenv('INCR_LIMIT_DT') ?: '200');
  $INCR_LIMIT_GPS = (int)(getenv('INCR_LIMIT_GPS') ?: '200');

  if ($DB_NAME === '') {
    respond(500, ['error' => 'Missing DB_NAME env var']);
  }

  $dsn = "mysql:host={$DB_HOST};port={$DB_PORT};dbname={$DB_NAME};charset=utf8mb4";
  $pdo = new PDO($dsn, $DB_USER, $DB_PASSWORD, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);

  $sqlDTSelect = "
    SELECT
      dt.TS as ts,
      dt.millis as millis,
      dt.temp_BMP as temp_BMP,
      dt.temp_SHT as temp_SHT,
      dt.hum_SHT as hum_SHT,
      dt.cot_SCD as co2_SCD,
      dt.air_SPG as air_SPG,
      dt.wartoscFotor as foto,
      (
        SELECT dtp.press_BMP
        FROM {$DTP_TABLE} dtp
        WHERE dtp.TS <= dt.TS
        ORDER BY dtp.TS DESC
        LIMIT 1
      ) as press_BMP
    FROM {$DT_TABLE} dt
  ";

  $sqlGPSSelect = "
    SELECT
      gps.TS as ts,
      gps.millis as millis,
      gps.latitude as latitude,
      gps.longitude as longitude
    FROM {$GPS_TABLE} gps
  ";

  if ($sinceTs === null) {
    // Initial load: return last N rows (newest first in DB, then reverse to oldest->newest).
    $stmtDT = $pdo->query($sqlDTSelect . " ORDER BY dt.TS DESC LIMIT {$HISTORY_DT_LIMIT}");
    $dtRows = $stmtDT->fetchAll();
    $dtRows = array_reverse($dtRows);

    $stmtGPS = $pdo->query($sqlGPSSelect . " ORDER BY gps.TS DESC LIMIT {$HISTORY_GPS_LIMIT}");
    $gpsRows = $stmtGPS->fetchAll();
    $gpsRows = array_reverse($gpsRows);
  } else {
    // Incremental load.
    $stmtDT = $pdo->prepare($sqlDTSelect . " WHERE dt.TS > ? ORDER BY dt.TS ASC LIMIT {$INCR_LIMIT_DT}");
    $stmtDT->execute([$sinceTs]);
    $dtRows = $stmtDT->fetchAll();

    $stmtGPS = $pdo->prepare($sqlGPSSelect . " WHERE gps.TS > ? ORDER BY gps.TS ASC LIMIT {$INCR_LIMIT_GPS}");
    $stmtGPS->execute([$sinceTs]);
    $gpsRows = $stmtGPS->fetchAll();
  }

  respond(200, ['dt' => $dtRows, 'gps' => $gpsRows]);
} catch (Throwable $e) {
  respond(500, ['error' => $e->getMessage()]);
}

