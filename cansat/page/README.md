# Telemetria CanSat (podgląd)

Jasna, prosta strona do podglądu telemetrii: wartości czujników, tabela ramek, log zdarzeń oraz mapa z pozycją z GPS. **Brak sterowania**.

## Uruchomienie lokalne

Najprościej uruchomić mały serwer HTTP w katalogu projektu:

```bash
php -S localhost:8000
```

Potem wejdź w przeglądarce na `http://localhost:8000`.

## Uruchomienie na RPi / stacji (WebSocket + baza)

W katalogu projektu uruchom backend WebSocket, który:
- łączy się z bazą MariaDB/MySQL (odczyt tylko; nie tworzy tabel)
- wysyła dane z tabel `DT` i `GPS` do przeglądarki (tryb WebSocket)

```bash
php backend/ws.php
```

Domyślnie startuje na `ws://0.0.0.0:8080` (zmienisz przez `WS_PORT`).

W UI wybierz źródło **WebSocket** i wpisz np. `ws://raspberrypi.local:8080`.

## Dane wejściowe

Strona obsługuje:
- **WebSocket**: wpisz adres (np. `ws://localhost:8080`) i kliknij „Połącz”.
- **Plik**: wczytaj log przez przycisk lub przeciągnij i upuść plik na stronę.

### Rozpoznawane linie

- `DT | millis() | temp_BMP | press_BMP | temp_SHT | hum_SHT | co2_SCD | air_SPG | wart_fotorezystor`
  - (lub z timestampem: `DT | ts=YYYY-MM-DD HH:MM:SS | millis() | ...`)
  - `NA` → traktowane jako brak danych i wyświetlane jako `—`
- `LOG | <tekst>`
- `GPS | lat=50.1234 | lon=19.9876`
  - albo `GPS | 50.1234 | 19.9876`
  - (lub z timestampem: `GPS | ts=YYYY-MM-DD HH:MM:SS | lat=... | lon=...`)
- `START` / `START | ...` → ignorowane

## Integracja z nadajnikiem/odbiornikiem

Jeśli masz program, który odbiera telemetrię (np. przez UART/radio) i wystawia WebSocket, wystarczy wysyłać **tekstowe linie** dokładnie takie jak w logu – po jednej na wiersz.

### Konfiguracja MariaDB

Ustaw zmienne środowiskowe przed uruchomieniem backendu:

```bash
DB_HOST="IP/host"
DB_PORT="3306"
DB_USER="uzytkownik"
DB_PASSWORD="haslo"
DB_NAME="nazwa_bazy"

# opcjonalnie jeśli Twoje tabele mają inne nazwy:
DT_TABLE="DT"
GPS_TABLE="GPS"
DTP_TABLE="DTP"
```

Backend potrzebuje PHP z rozszerzeniem `pdo_mysql` (PDO MySQL).

### Dane w bazie

Backend zakłada, że w bazie istnieją tabele `DT`, `GPS` i `DTP` i tylko je czyta.
