<?php
// Minimalny serwer WebSocket w PHP (bez bibliotek typu Ratchet).
// Czyta dane z MariaDB i wysyła je do przeglądarki jako linie tekstu,
// które `app.js` potrafi parsować (DT/GPS).

declare(strict_types=1);

// -------------------- Konfiguracja --------------------
$WS_HOST = getenv('WS_HOST') ?: '0.0.0.0';
$WS_PORT = (int)(getenv('WS_PORT') ?: '8080');
$POLL_INTERVAL_MS = (int)(getenv('POLL_INTERVAL_MS') ?: '1000');

$DB_HOST = getenv('DB_HOST') ?: '127.0.0.1';
$DB_PORT = (int)(getenv('DB_PORT') ?: '3306');
$DB_USER = getenv('DB_USER') ?: 'root';
$DB_PASSWORD = getenv('DB_PASSWORD') ?: '';
$DB_NAME = getenv('DB_NAME') ?: '';

$DT_TABLE = getenv('DT_TABLE') ?: 'DT';
$GPS_TABLE = getenv('GPS_TABLE') ?: 'GPS';
$DTP_TABLE = getenv('DTP_TABLE') ?: 'DTP';

$HISTORY_DT_LIMIT = (int)(getenv('HISTORY_DT_LIMIT') ?: '200');
$HISTORY_GPS_LIMIT = (int)(getenv('HISTORY_GPS_LIMIT') ?: '50');
$INCR_LIMIT = (int)(getenv('INCR_LIMIT') ?: '10');

if ($DB_NAME === '') {
  fwrite(STDERR, "Missing DB_NAME env var\n");
  exit(1);
}

$dsn = "mysql:host={$DB_HOST};port={$DB_PORT};dbname={$DB_NAME};charset=utf8mb4";
$pdo = new PDO($dsn, $DB_USER, $DB_PASSWORD, [
  PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
  PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);

// -------------------- WebSocket utils --------------------
function wsAcceptKey(string $clientKey): string {
  return base64_encode(sha1($clientKey . '258EAFA5-E914-47DA-95CA-C5AB0DC85B', true));
}

function wsBuildFrame(string $payload, int $opcode = 0x1): string {
  $finBit = 0x80; // FIN=1
  $firstByte = chr($finBit | ($opcode & 0x0F));
  $len = strlen($payload);

  // server-to-client frames are NOT masked
  if ($len <= 125) {
    return $firstByte . chr($len) . $payload;
  }
  if ($len <= 65535) {
    return $firstByte . chr(126) . chr(($len >> 8) & 0xFF) . chr($len & 0xFF) . $payload;
  }
  // Not expected for our payloads; clamp with smaller history.
  return $firstByte . chr(127) . str_repeat("\0", 8) . $payload;
}

function wsSendText($sock, string $text): void {
  $frame = wsBuildFrame($text, 0x1);
  @fwrite($sock, $frame);
}

function wsSendPong($sock, string $payload): void {
  $frame = wsBuildFrame($payload, 0xA); // pong opcode=0xA
  @fwrite($sock, $frame);
}

function wsParseAndHandleFrames($sock, string &$inbuf, array &$clients): void {
  // Only handle unfragmented text/binary/control frames (enough for browser pings/closes).
  while (strlen($inbuf) >= 2) {
    $b1 = ord($inbuf[0]);
    $b2 = ord($inbuf[1]);
    $opcode = $b1 & 0x0F;
    $masked = (($b2 & 0x80) !== 0);
    $payloadLen = $b2 & 0x7F;
    $pos = 2;

    if ($payloadLen === 126) {
      if (strlen($inbuf) < $pos + 2) return;
      $payloadLen = (ord($inbuf[$pos]) << 8) | ord($inbuf[$pos + 1]);
      $pos += 2;
    } elseif ($payloadLen === 127) {
      // We don't expect 64-bit lengths here
      return;
    }

    $mask = '';
    if ($masked) {
      if (strlen($inbuf) < $pos + 4) return;
      $mask = substr($inbuf, $pos, 4);
      $pos += 4;
    } else {
      // Client frames from browser should be masked; ignore if not.
      return;
    }

    if (strlen($inbuf) < $pos + $payloadLen) return;

    $payload = substr($inbuf, $pos, $payloadLen);
    $inbuf = substr($inbuf, $pos + $payloadLen);

    // Unmask
    $unmasked = '';
    for ($i = 0; $i < $payloadLen; $i++) {
      $unmasked .= $payload[$i] ^ $mask[$i % 4];
    }

    if ($opcode === 0x8) {
      // Close
      $id = (int)$sock;
      if (isset($clients[$id])) {
        @fclose($clients[$id]['sock']);
        unset($clients[$id]);
      }
      return;
    }
    if ($opcode === 0x9) {
      // Ping -> Pong
      wsSendPong($sock, $unmasked);
    }
  }
}

function parseHttpHeaders(string $buffer): array {
  $lines = preg_split("/\r\n/", $buffer);
  $headers = [];
  foreach ($lines as $line) {
    if (strpos($line, ':') === false) continue;
    [$k, $v] = explode(':', $line, 2);
    $headers[trim($k)] = trim($v);
  }
  return $headers;
}

// -------------------- DB queries --------------------
function dtRowToLine(array $r): string {
  $ts = $r['TS'];
  $millis = $r['millis'] ?? null;
  $tempBMP = $r['temp_BMP'] ?? null;
  $pressBMP = $r['press_BMP'] ?? null;
  $tempSHT = $r['temp_SHT'] ?? null;
  $humSHT = $r['hum_SHT'] ?? null;
  $co2SCD = $r['cot_SCD'] ?? null;
  $airSPG = $r['air_SPG'] ?? null;
  $foto = $r['wartoscFotor'] ?? null;

  // UI traktuje "NA" jak brak danych.
  $na = function ($v): string {
    if ($v === null || $v === '') return 'NA';
    return (string)$v;
  };

  return
    'DT | ts=' . $ts .
    ' | ' . $na($millis) .
    ' | ' . $na($tempBMP) .
    ' | ' . $na($pressBMP) .
    ' | ' . $na($tempSHT) .
    ' | ' . $na($humSHT) .
    ' | ' . $na($co2SCD) .
    ' | ' . $na($airSPG) .
    ' | ' . $na($foto);
}

function gpsRowToLine(array $r): string {
  $ts = $r['TS'];
  $lat = $r['latitude'] ?? null;
  $lon = $r['longitude'] ?? null;
  $na = function ($v): string {
    if ($v === null || $v === '') return 'NA';
    return (string)$v;
  };

  return 'GPS | ts=' . $ts . ' | lat=' . $na($lat) . ' | lon=' . $na($lon);
}

function fetchLatest(PDO $pdo, string $dtTable, string $gpsTable, string $dtpTable): array {
  $sqlDT = "
    SELECT
      dt.TS,
      dt.millis,
      dt.temp_BMP,
      dt.temp_SHT,
      dt.hum_SHT,
      dt.cot_SCD,
      dt.air_SPG,
      dt.wartoscFotor,
      (
        SELECT dtp.press_BMP
        FROM {$dtpTable} dtp
        WHERE dtp.TS <= dt.TS
        ORDER BY dtp.TS DESC
        LIMIT 1
      ) AS press_BMP
    FROM {$dtTable} dt
    ORDER BY dt.TS DESC
    LIMIT 1
  ";
  $sqlGPS = "SELECT TS, millis, latitude, longitude FROM {$gpsTable} ORDER BY TS DESC LIMIT 1";

  $dt = $pdo->query($sqlDT)->fetch();
  $gps = $pdo->query($sqlGPS)->fetch();
  return ['dt' => $dt ?: null, 'gps' => $gps ?: null];
}

function fetchHistory(PDO $pdo, string $dtTable, string $gpsTable, string $dtpTable, int $dtLimit, int $gpsLimit): array {
  $sqlDT = "
    SELECT
      dt.TS,
      dt.millis,
      dt.temp_BMP,
      dt.temp_SHT,
      dt.hum_SHT,
      dt.cot_SCD,
      dt.air_SPG,
      dt.wartoscFotor,
      (
        SELECT dtp.press_BMP
        FROM {$dtpTable} dtp
        WHERE dtp.TS <= dt.TS
        ORDER BY dtp.TS DESC
        LIMIT 1
      ) AS press_BMP
    FROM {$dtTable} dt
    ORDER BY dt.TS DESC
    LIMIT {$dtLimit}
  ";
  $sqlGPS = "SELECT TS, millis, latitude, longitude FROM {$gpsTable} ORDER BY TS DESC LIMIT {$gpsLimit}";

  $dtRows = $pdo->query($sqlDT)->fetchAll();
  $gpsRows = $pdo->query($sqlGPS)->fetchAll();

  // Reverse so that we send oldest -> newest (so UI with unshift shows newest on top).
  $dtRows = array_reverse($dtRows);
  $gpsRows = array_reverse($gpsRows);

  $combined = [];
  foreach ($dtRows as $r) {
    $combined[] = ['kind' => 'DT', 'TS' => $r['TS'], 'row' => $r];
  }
  foreach ($gpsRows as $r) {
    $combined[] = ['kind' => 'GPS', 'TS' => $r['TS'], 'row' => $r];
  }

  usort($combined, function ($a, $b) {
    // TS is in YYYY-MM-DD HH:MM:SS format => lexicographic compare works.
    return strcmp($a['TS'], $b['TS']);
  });

  return $combined;
}

function fetchNewDT(PDO $pdo, string $dtTable, string $dtpTable, ?string $sinceTs, int $limit): array {
  if ($sinceTs === null) return [];
  $sql = "
    SELECT
      dt.TS,
      dt.millis,
      dt.temp_BMP,
      dt.temp_SHT,
      dt.hum_SHT,
      dt.cot_SCD,
      dt.air_SPG,
      dt.wartoscFotor,
      (
        SELECT dtp.press_BMP
        FROM {$dtpTable} dtp
        WHERE dtp.TS <= dt.TS
        ORDER BY dtp.TS DESC
        LIMIT 1
      ) AS press_BMP
    FROM {$dtTable} dt
    WHERE dt.TS > ?
    ORDER BY dt.TS ASC
    LIMIT {$limit}
  ";
  $stmt = $pdo->prepare($sql);
  $stmt->execute([$sinceTs]);
  return $stmt->fetchAll();
}

function fetchNewGPS(PDO $pdo, string $gpsTable, ?string $sinceTs, int $limit): array {
  if ($sinceTs === null) return [];
  $sql = "SELECT TS, millis, latitude, longitude FROM {$gpsTable} WHERE TS > ? ORDER BY TS ASC LIMIT {$limit}";
  $stmt = $pdo->prepare($sql);
  $stmt->execute([$sinceTs]);
  return $stmt->fetchAll();
}

// -------------------- Server loop --------------------
$server = @stream_socket_server("tcp://{$WS_HOST}:{$WS_PORT}", $errno, $errstr);
if (!$server) {
  fwrite(STDERR, "Failed to bind ws server: {$errstr}\n");
  exit(1);
}
stream_set_blocking($server, false);

fwrite(STDERR, "WS server listening on ws://{$WS_HOST}:{$WS_PORT}\n");

$clients = []; // id(int) => ['sock'=>resource,'handshake'=>bool,'buffer'=>string,'inbuf'=>string]

$initial = fetchLatest($pdo, $DT_TABLE, $GPS_TABLE, $DTP_TABLE);
$lastSentDT = $initial['dt']['TS'] ?? null;
$lastSentGPS = $initial['gps']['TS'] ?? null;

$nextPoll = microtime(true);
$pollStep = max(1, $POLL_INTERVAL_MS) / 1000.0;

while (true) {
  // Wait for readable sockets (non-blocking).
  $read = [$server];
  foreach ($clients as $c) {
    $read[] = $c['sock'];
  }

  $write = [];
  $except = [];
  // small timeout; loop also polls separately
  @stream_select($read, $write, $except, 0, 200000);

  foreach ($read as $sock) {
    if ($sock === $server) {
      $client = @stream_socket_accept($server, 0);
      if ($client) {
        stream_set_blocking($client, false);
        $id = (int)$client;
        $clients[$id] = [
          'sock' => $client,
          'handshake' => false,
          'buffer' => '',
          'inbuf' => '',
        ];
      }
      continue;
    }

    $id = (int)$sock;
    if (!isset($clients[$id])) continue;

    $chunk = @fread($sock, 8192);
    if ($chunk === '' || $chunk === false) {
      if (feof($sock)) {
        @fclose($sock);
        unset($clients[$id]);
      }
      continue;
    }

    if (!$clients[$id]['handshake']) {
      $clients[$id]['buffer'] .= $chunk;
      if (strpos($clients[$id]['buffer'], "\r\n\r\n") === false) continue;

      $headers = parseHttpHeaders($clients[$id]['buffer']);
      $key = $headers['Sec-WebSocket-Key'] ?? null;
      if (!$key) {
        @fclose($sock);
        unset($clients[$id]);
        continue;
      }

      $accept = wsAcceptKey($key);
      $resp =
        "HTTP/1.1 101 Switching Protocols\r\n" .
        "Upgrade: websocket\r\n" .
        "Connection: Upgrade\r\n" .
        "Sec-WebSocket-Accept: {$accept}\r\n\r\n";
      @fwrite($sock, $resp);
      $clients[$id]['handshake'] = true;

      // Send history for this client only.
      try {
        $history = fetchHistory($pdo, $DT_TABLE, $GPS_TABLE, $DTP_TABLE, $HISTORY_DT_LIMIT, $HISTORY_GPS_LIMIT);
        $lines = [];
        foreach ($history as $item) {
          if ($item['kind'] === 'DT') $lines[] = dtRowToLine($item['row']);
          if ($item['kind'] === 'GPS') $lines[] = gpsRowToLine($item['row']);
        }
        if ($lines) {
          wsSendText($sock, implode("\n", $lines) . "\n");
        }
      } catch (Throwable $e) {
        wsSendText($sock, "LOG | DB error: " . $e->getMessage() . "\n");
      }

      $clients[$id]['buffer'] = '';
      $clients[$id]['inbuf'] = '';
      continue;
    }

    // Handle frames after handshake (ping/pong/close).
    $clients[$id]['inbuf'] .= $chunk;
    wsParseAndHandleFrames($sock, $clients[$id]['inbuf'], $clients);
  }

  // Poll DB and broadcast new rows.
  $now = microtime(true);
  if ($now >= $nextPoll) {
    try {
      $newDT = fetchNewDT($pdo, $DT_TABLE, $DTP_TABLE, $lastSentDT, $INCR_LIMIT);
      foreach ($newDT as $row) {
        $line = dtRowToLine($row);
        foreach ($clients as $c) {
          wsSendText($c['sock'], $line . "\n");
        }
        $lastSentDT = $row['TS'];
      }

      $newGPS = fetchNewGPS($pdo, $GPS_TABLE, $lastSentGPS, $INCR_LIMIT);
      foreach ($newGPS as $row) {
        $line = gpsRowToLine($row);
        foreach ($clients as $c) {
          wsSendText($c['sock'], $line . "\n");
        }
        $lastSentGPS = $row['TS'];
      }
    } catch (Throwable $e) {
      fwrite(STDERR, "DB poll error: " . $e->getMessage() . "\n");
    }
    $nextPoll = $now + $pollStep;
  }
}

