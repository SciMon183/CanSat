# Telemetria CanSat (podgląd)

Jasna, prosta strona do podglądu telemetrii: wartości czujników, tabela ramek, log zdarzeń oraz mapa z pozycją z GPS. **Brak sterowania**.

## Uruchomienie lokalne

Najprościej uruchomić mały serwer HTTP w katalogu projektu:

```bash
php -S localhost:8000
```

Potem wejdź w przeglądarce na `http://localhost:8000`.

## Uruchomienie na RPi / stacji (HTTP polling + baza)

W katalogu projektu uruchom serwer PHP (API działa jako zwykły endpoint HTTP):
- łączy się z bazą MariaDB/MySQL (odczyt tylko; nie tworzy tabel)

```bash
php -S 0.0.0.0:8080
```

Domyślnie startuje na `http://0.0.0.0:8080`.

W UI wybierz źródło **HTTP polling (PHP)** i wpisz np. `http://raspberrypi.local:8080`.

## Dane wejściowe

Strona obsługuje:
- **HTTP polling (PHP)**: wpisz adres (np. `http://localhost:8080`) i kliknij „Połącz”.
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

Jeśli masz program, który odbiera telemetrię (np. przez UART/radio), to backend odczytuje gotowe rekordy z tabel `DT`, `GPS` i `DTP` w MariaDB.

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
