# Kontrakt Workera

> ✅ Ten dokument definiuje specyfikację techniczną, biblioteki i integracje dla Worker Service w systemie TrackFlow v1.0.

---

## Odpowiedzialności

- [x] Consumer: `click.recorded` (rejestracja kliknięć w tle)
- [x] Consumer: `report.requested` (generowanie PDF w tle)
- [x] Consumer: `notification.send` (wysyłka e-maili)
- [x] Cron: `weekly-report` (generowanie raportów tygodniowych w poniedziałki o 8:00)
- [x] Cron: `alert-no-clicks` (monitorowanie braku aktywności co 15 minut)

---

## Integracje i biblioteki

### 1. Geolokalizacja IP
```
Biblioteka:  geoip-lite (lokalna baza danych IP załadowana do pamięci RAM procesu)
Timeout:     max 100ms (dla bezpieczeństwa wywołania lokalnego)
Przy timeout: zapisz country = null, city = null (nie przerywaj zapisu i wyślij ACK)
```

### 2. Parser User-Agent
```
Biblioteka:  ua-parser-js
Pola:        device_type (CHECK: 'mobile' | 'desktop' | 'tablet', fallback: 'desktop'), browser, os
```

### 3. Generowanie PDF
```
Biblioteka:       Puppeteer (bezgłowy Chromium sterowany z Node.js)
Gdzie zapisujesz: Współdzielony wolumen Docker Compose w ścieżce: /app/storage/reports/
Format nazwy:     report_{report_id}.pdf (np. report_ac6a3d93-3ea7-4f6c-b4be-5ff6fbbf05ab.pdf)
Po wygenerowaniu: 
  1. Aktualizacja PostgreSQL: status = 'done', completed_at = NOW(), file_path = '/app/storage/reports/report_{report_id}.pdf'
  2. Jeśli zlecenie posiadało pole recipient_email: opublikuj event `notification.send`
```

### 4. Wysyłanie e-maili
```
Dev (Local): Mailhog — lokalny serwer SMTP, interfejs web UI dostępny pod: http://localhost:8025
Prod:        Nodemailer z autoryzacją SMTP (lub Resend API / SendGrid SMTP)
From:        TrackFlow <noreply@trackflow.io>
```

---

## Zmienne środowiskowe (Environment Variables)

Poniższe zmienne środowiskowe muszą być zaimplementowane w kontenerze Workera:

```env
# Konfiguracja bazy danych
DATABASE_URL=postgresql://postgres:postgres_password@postgres:5432/trackflow?schema=public

# Konfiguracja brokera kolejki (RabbitMQ)
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672/

# Konfiguracja cache (Redis)
REDIS_URL=redis://redis:6379/0

# Konfiguracja serwera SMTP
SMTP_HOST=mailhog
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
SMTP_FROM=TrackFlow <noreply@trackflow.io>

# Konfiguracja systemu plików dla PDF
PDF_STORAGE_PATH=/app/storage/reports
```

---

## Testy które agent musi napisać

### Jednostkowe (Unit Tests)
- [ ] **Parser UA**: iPhone User-Agent → device_type: "mobile", os: "iOS", browser: "Safari"
- [ ] **Parser UA**: nieznany User-Agent → device_type: "desktop" (fallback), os: null, browser: null (bez zgłaszania wyjątków)
- [ ] **Idempotentność**: podwójne odebranie eventu z tym samym `event_id` → drugi event jest ignorowany (wywoływany jest ACK bez zapisu w DB)
- [ ] **Geolokalizacja**: timeout lub błędne IP → zwraca `{ country: null, city: null }` i kontynuuje zapis

### Integracyjne (Integration Tests)
- [ ] **click.recorded** → wysłanie eventu skutkuje poprawnym utworzeniem rekordu w tabeli `clicks` w PostgreSQL z poprawnymi danymi UA/GeoIP.
- [ ] **Deduplikacja kliknięć** → wysłanie tego samego eventu kliknięcia dwukrotnie skutkuje dokładnie jednym rekordem w tabeli `clicks`.
- [ ] **report.requested** → poprawna agregacja danych, wygenerowanie pliku PDF na wolumenie oraz aktualizacja statusu na `done` w bazie danych.
- [ ] **weekly-report (Cron)** → poprawny start crona o 8:00, wygenerowanie zleceń raportów dla klientów i wysłanie maili widocznych w Mailhogu.
