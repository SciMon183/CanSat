# Telemetria CanSat (podgląd)

Jasna, prosta strona do podglądu telemetrii: wartości czujników, tabela ramek, log zdarzeń oraz mapa z pozycją z GPS. **Brak sterowania**.

## Uruchomienie lokalne

Najprościej uruchomić mały serwer HTTP w katalogu projektu:

```bash
python -m http.server 8000
```

Potem wejdź w przeglądarce na `http://localhost:8000`.

## Uruchomienie na RPi / stacji (API + baza)

W katalogu projektu uruchom backend, który:
- trzyma dane w SQLite (`telemetry.db`)
- udostępnia API: `GET /api/latest`, `GET /api/recent` (tryb odczytu z bazy; `POST /api/ingest` wyłączone)
- serwuje też pliki strony (`index.html`, itd.)

```bash
python3 backend/server.py
```

Domyślnie startuje na `http://0.0.0.0:8081`.

W UI wybierz źródło **HTTP API** i wpisz np. `http://raspberrypi.local:8081`.

## Dane wejściowe

Strona obsługuje:
- **WebSocket**: wpisz adres (np. `ws://localhost:8080`) i kliknij „Połącz”.
- **Plik**: wczytaj log przez przycisk lub przeciągnij i upuść plik na stronę.
- **HTTP API (RPi / stacja)**: wybierz „HTTP API” i podaj adres backendu.

### Rozpoznawane linie

- `DT | millis() | temp_BMP | press_BMP | temp_SHT | hum_SHT | co2_SCD | air_SPG | wart_fotorezystor`
  - `NA` → traktowane jako brak danych i wyświetlane jako `—`
- `LOG | <tekst>`
- `GPS | lat=50.1234 | lon=19.9876`
  - albo `GPS | 50.1234 | 19.9876`
- `START` / `START | ...` → ignorowane

## Integracja z nadajnikiem/odbiornikiem

Jeśli masz program, który odbiera telemetrię (np. przez UART/radio) i wystawia WebSocket, wystarczy wysyłać **tekstowe linie** dokładnie takie jak w logu – po jednej na wiersz.

### Wrzucanie danych do bazy

Backend jest do odczytu: dane muszą być już zapisane w SQLite jako tabele `DT`, `GPS` i `DTP` (np. przez osobny skrypt/proces, który odbiera telemetrię).
