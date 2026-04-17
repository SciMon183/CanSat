<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('Access-Control-Allow-Origin: *');

$CONFIG = [
  'DB_HOST' => getenv('DB_HOST') ?: '127.0.0.1',
  'DB_PORT' => getenv('DB_PORT') ?: 3306,
  'DB_USER' => getenv('DB_USER') ?: 'cansat',
  'DB_PASSWORD' => getenv('DB_PASSWORD') ?: 'cansat',
  'DB_NAME' => getenv('DB_NAME') ?: 'cansat',
  'DT_TABLE' => 'DT',
  'GPS_TABLE' => 'GPS',
  'DTP_TABLE' => 'DTP',
  'LOGS_TABLE' => 'LOGS',
  'STATUS_TABLE' => 'STATUS',
  'HISTORY_DT_LIMIT' => 200,
  'HISTORY_GPS_LIMIT' => 50,
  'HISTORY_LOGS_LIMIT' => 100,
  'INCR_LIMIT_DT' => 200,
  'INCR_LIMIT_GPS' => 200,
  'INCR_LIMIT_LOGS' => 100,
];

function respond(int $code, array $payload): void {
  http_response_code($code);
  echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

function safeTableName(string $table): string {
  if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $table)) {
    throw new RuntimeException("Invalid table name: {$table}");
  }
  return $table;
}

function asNullableString(mixed $value): ?string {
  if ($value === null) {
    return null;
  }
  $text = trim((string)$value);
  return $text === '' ? null : $text;
}

function asNullableInt(mixed $value): ?int {
  if ($value === null || $value === '') {
    return null;
  }
  $int = filter_var($value, FILTER_VALIDATE_INT);
  return $int === false ? null : (int)$int;
}

function asNullableFloat(mixed $value): ?float {
  if ($value === null || $value === '') {
    return null;
  }
  $float = filter_var($value, FILTER_VALIDATE_FLOAT);
  return $float === false ? null : (float)$float;
}

function normalizeDtRow(array $row): array {
  return [
    'ts' => asNullableString($row['ts'] ?? null),
    'millis' => asNullableInt($row['millis'] ?? null),
    'temp_BMP' => asNullableFloat($row['temp_BMP'] ?? null),
    'press_BMP' => asNullableFloat($row['press_BMP'] ?? null),
    'temp_SHT' => asNullableFloat($row['temp_SHT'] ?? null),
    'hum_SHT' => asNullableFloat($row['hum_SHT'] ?? null),
    'co2_SCD' => asNullableInt($row['co2_SCD'] ?? null),
    'air_SPG' => asNullableFloat($row['air_SPG'] ?? null),
    'foto' => asNullableInt($row['foto'] ?? null),
  ];
}

function normalizeGpsRow(array $row): array {
  return [
    'ts' => asNullableString($row['ts'] ?? null),
    'latitude' => asNullableFloat($row['latitude'] ?? null),
    'longitude' => asNullableFloat($row['longitude'] ?? null),
    'distanceToHome' => asNullableInt($row['distanceToHome'] ?? null),
    'courseToHome' => asNullableFloat($row['courseToHome'] ?? null),
    'AGL' => asNullableFloat($row['AGL'] ?? null),
    'satellites' => asNullableInt($row['satellites'] ?? null),
  ];
}

function normalizeLogsRow(array $row): array {
  return [
    'ts' => asNullableString($row['ts'] ?? null),
    'logCONTENTS' => asNullableString($row['logCONTENTS'] ?? null),
  ];
}

function normalizeStatusRow(array $row): array {
  return [
    'ts' => asNullableString($row['ts'] ?? null),
    'value' => asNullableInt($row['value'] ?? null),
  ];
}

try {
  $sinceTsRaw = isset($_GET['since_ts']) ? trim((string)$_GET['since_ts']) : '';
  $sinceTs = $sinceTsRaw === '' ? null : $sinceTsRaw;

  $DB_HOST = trim((string)$CONFIG['DB_HOST']);
  $DB_PORT = max(1, (int)$CONFIG['DB_PORT']);
  $DB_USER = trim((string)$CONFIG['DB_USER']);
  $DB_PASSWORD = (string)$CONFIG['DB_PASSWORD'];
  $DB_NAME = trim((string)$CONFIG['DB_NAME']);

  $DT_TABLE = safeTableName(trim((string)$CONFIG['DT_TABLE']));
  $GPS_TABLE = safeTableName(trim((string)$CONFIG['GPS_TABLE']));
  $DTP_TABLE = safeTableName(trim((string)$CONFIG['DTP_TABLE']));
  $LOGS_TABLE = safeTableName(trim((string)$CONFIG['LOGS_TABLE']));
  $STATUS_TABLE = safeTableName(trim((string)$CONFIG['STATUS_TABLE']));

  $HISTORY_DT_LIMIT = max(1, min(2000, (int)$CONFIG['HISTORY_DT_LIMIT']));
  $HISTORY_GPS_LIMIT = max(1, min(2000, (int)$CONFIG['HISTORY_GPS_LIMIT']));
  $HISTORY_LOGS_LIMIT = max(1, min(2000, (int)$CONFIG['HISTORY_LOGS_LIMIT']));
  $INCR_LIMIT_DT = max(1, min(2000, (int)$CONFIG['INCR_LIMIT_DT']));
  $INCR_LIMIT_GPS = max(1, min(2000, (int)$CONFIG['INCR_LIMIT_GPS']));
  $INCR_LIMIT_LOGS = max(1, min(2000, (int)$CONFIG['INCR_LIMIT_LOGS']));

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
      gps.latitude as latitude,
      gps.longitude as longitude,
      gps.distanceToHome as distanceToHome,
      gps.courseToHome as courseToHome,
      gps.AGL as AGL,
      gps.satellites as satellites
    FROM {$GPS_TABLE} gps
  ";

  $sqlLogsSelect = "
    SELECT
      logs.TS as ts,
      logs.logCONTENTS as logCONTENTS
    FROM {$LOGS_TABLE} logs
  ";

  $sqlStatusSelect = "
    SELECT
      s.TS as ts,
      s.value as value
    FROM {$STATUS_TABLE} s
  ";

  $dtRows = [];
  $gpsRows = [];
  $logsRows = [];
  $statusRows = [];
  $warnings = [];

  if ($sinceTs === null) {
    try {
      $stmtDT = $pdo->query($sqlDTSelect . " ORDER BY dt.TS DESC LIMIT {$HISTORY_DT_LIMIT}");
      $dtRows = array_map('normalizeDtRow', array_reverse($stmtDT->fetchAll()));
    } catch (Throwable $e) {
      $warnings[] = 'DT query failed: ' . $e->getMessage();
    }

    try {
      $stmtGPS = $pdo->query($sqlGPSSelect . " ORDER BY gps.TS DESC LIMIT {$HISTORY_GPS_LIMIT}");
      $gpsRows = array_map('normalizeGpsRow', array_reverse($stmtGPS->fetchAll()));
    } catch (Throwable $e) {
      $warnings[] = 'GPS query failed: ' . $e->getMessage();
    }

    try {
      $stmtLogs = $pdo->query($sqlLogsSelect . " ORDER BY logs.TS DESC LIMIT {$HISTORY_LOGS_LIMIT}");
      $logsRows = array_map('normalizeLogsRow', array_reverse($stmtLogs->fetchAll()));
    } catch (Throwable $e) {
      $warnings[] = 'LOGS query failed: ' . $e->getMessage();
    }

    try {
      $stmtStatus = $pdo->query($sqlStatusSelect . " ORDER BY s.TS DESC LIMIT 1");
      $statusRows = array_map('normalizeStatusRow', $stmtStatus->fetchAll());
    } catch (Throwable $e) {
      $warnings[] = 'STATUS query failed: ' . $e->getMessage();
    }
  } else {
    try {
      $stmtDT = $pdo->prepare($sqlDTSelect . " WHERE dt.TS > ? ORDER BY dt.TS ASC LIMIT {$INCR_LIMIT_DT}");
      $stmtDT->execute([$sinceTs]);
      $dtRows = array_map('normalizeDtRow', $stmtDT->fetchAll());
    } catch (Throwable $e) {
      $warnings[] = 'DT query failed: ' . $e->getMessage();
    }

    try {
      $stmtGPS = $pdo->prepare($sqlGPSSelect . " WHERE gps.TS > ? ORDER BY gps.TS ASC LIMIT {$INCR_LIMIT_GPS}");
      $stmtGPS->execute([$sinceTs]);
      $gpsRows = array_map('normalizeGpsRow', $stmtGPS->fetchAll());
    } catch (Throwable $e) {
      $warnings[] = 'GPS query failed: ' . $e->getMessage();
    }

    try {
      $stmtLogs = $pdo->prepare($sqlLogsSelect . " WHERE logs.TS > ? ORDER BY logs.TS ASC LIMIT {$INCR_LIMIT_LOGS}");
      $stmtLogs->execute([$sinceTs]);
      $logsRows = array_map('normalizeLogsRow', $stmtLogs->fetchAll());
    } catch (Throwable $e) {
      $warnings[] = 'LOGS query failed: ' . $e->getMessage();
    }

    try {
      $stmtStatus = $pdo->prepare($sqlStatusSelect . " WHERE s.TS > ? ORDER BY s.TS DESC LIMIT 1");
      $stmtStatus->execute([$sinceTs]);
      $statusRows = array_map('normalizeStatusRow', $stmtStatus->fetchAll());
    } catch (Throwable $e) {
      $warnings[] = 'STATUS query failed: ' . $e->getMessage();
    }
  }

  $payload = ['dt' => $dtRows, 'gps' => $gpsRows, 'logs' => $logsRows];
  if (count($statusRows) > 0 && $statusRows[count($statusRows) - 1]['value'] !== null) {
    $payload['status'] = $statusRows[count($statusRows) - 1]['value'];
  }
  if (count($warnings) > 0) {
    $payload['warnings'] = $warnings;
  }
  respond(200, $payload);
} catch (Throwable $e) {
  respond(500, ['error' => $e->getMessage()]);
}

