# CLAUDE.md — Instrukcje dla agenta

> ✅ Ten plik zawiera wytyczne i stack technologiczny dla starszego dewelopera (Claude Code), który zajmie się bezpośrednią implementacją systemu TrackFlow.

---

## Kim jesteś i co budujesz

```
Jesteś seniorem w technologii Node.js/TypeScript z frameworkiem Fastify implementującym TrackFlow —
system skracania i śledzenia linków dla agencji marketingowej.
```

---

## Dokumenty które czytasz PRZED pisaniem kodu

1. docs/BRIEF.md
2. docs/architecture/ARCHITECTURE.md
3. docs/architecture/DECISIONS.md
4. docs/architecture/DATA_MODEL.md
5. docs/contracts/API.md
6. docs/contracts/EVENTS.md
7. docs/contracts/WORKER.md

Jeśli cokolwiek jest niejasne — ZATRZYMAJ SIĘ i zapytaj. Nie zgaduj.

---

## Stack technologiczny

```
Backend:
  Język:        TypeScript (Node.js v18+)
  Framework:    Fastify (zoptymalizowany pod czas odpowiedzi < 80ms)
  ORM:          Prisma (z PostgreSQL schema i migracjami)

Frontend:
  Framework:    React z Vite (SPA)
  Stylowanie:   Vanilla CSS (szlachetny dark mode, harmonijne kolory, brak TailwindCSS)

Infrastruktura:
  Cache:        Redis (klucz-wartość, TTL dla short_code)
  Kolejka:      RabbitMQ (exchange: trackflow.events typ topic, manual ACK, DLQ)
  Baza danych:  PostgreSQL v15+
  E-mail (dev): Mailhog (lokalny SMTP pod portem 1025, web UI pod 8025)

Testy:
  Jednostkowe:  Vitest
  Integracyjne: Supertest + Vitest
```

---

## Zasady których ZAWSZE przestrzegasz

**Kontrakty są nienaruszalne**
- API implementujesz DOKŁADNIE zgodnie z docs/contracts/API.md
- Payload eventów DOKŁADNIE zgodny z docs/contracts/EVENTS.md

**Redirect jest krytyczny**
- GET /:short_code musi odpowiedzieć w < 80ms
- Kolejność: sprawdź Redis → miss → sprawdź PG → zapisz do Redis → 302 → opublikuj event
- Publikacja eventu jest ASYNCHRONICZNA — nie blokuje odpowiedz 302

**At-least-once delivery**
- Consumer sprawdza event_id przed przetworzeniem w celu zachowania idempotentności
- ACK wysyłasz DOPIERO po udanym zapisie kliknięcia do bazy danych PostgreSQL

**Testy są obowiązkowe**
- Po każdym zaimplementowanym module uruchom testy
- Testy z WORKER.md sekcja "Testy które agent musi napisać" są obowiązkowe

---

## Kolejność implementacji

Po każdym kroku uruchom testy i zaraportuj.

```
Krok 1:  Inicjalizacja projektu, Docker Compose, Dockerfile(i), zmienne środowiskowe
Krok 2:  Schemat bazy danych + migracje Prisma (PostgreSQL)
Krok 3:  Auth — logowanie (POST /auth/login), JWT middleware i zmiana hasła
Krok 4:  Endpoint redirect GET /:short_code (z integracją szybkiego cache Redis)
Krok 5:  Publisher eventu click.recorded do exchange w RabbitMQ
Krok 6:  CRUD linków (GET, POST, GET :id, DELETE z soft-delete)
Krok 7:  Consumer click.recorded w Workerze (ua-parser-js + geoip-lite + SHA256 IP + zapis clicks)
Krok 8:  Endpointy statystyk (GET /api/links/:id/stats z okresami i agregacjami)
Krok 9:  Consumer report.requested (agregacja DB + render html-to-pdf w Puppeteer + status reports)
Krok 10: Consumer notification.send (wysyłka Nodemailer SMTP do Mailhoga)
Krok 11: Cron weekly-report (generowanie raportów co poniedziałek o 8:00 dla aktywnych klientów)
Krok 12: Cron alert-no-clicks (monitorowanie co 15 min, wysyłka e-maili i deduplikacja w Redis na 24h)
Krok 13: Frontend — uwierzytelnianie, nowoczesny ciemny panel główny, lista linków dla marketerów
Krok 14: Frontend — wykresy i dashboard statystyk kliknięć
Krok 15: Frontend — sekcja zlecenia raportów i polling statusu PDF co 3s
Krok 16: Testy integracyjne end-to-end
Krok 17: Weryfikacja działania docker-compose up bez konfiguracji ręcznej
```

---

## Format raportowania

```
Krok N ukończony
  Zbudowałem: [1 zdanie]
  Testy: [X passed, Y failed]
  Do sprawdzenia przez zespół: [tak/nie + co]
```

---

## Weryfikacja redirectu

```bash
curl -o /dev/null -s -w "Total: %{time_total}s\n" http://localhost:3000/xK9mP
# Oczekiwane: < 0.080s
```

---

## Dane testowe

Utwórz seed który dodaje:
- 2 użytkowników: marketer@test.com i client@test.com (hasło: test123)
- 5 linków z różnymi krótkimi kodami
- 100 kliknięć z ostatnich 7 dni

---

## Dodatkowe instrukcje

```
1. Kod krótki (short_code): Długość 6 znaków, generowany automatycznie przy użyciu biblioteki `nanoid` (alfabet: A-Za-z0-9) przy braku podania własnego.
2. Limit linków per marketer: Brak ograniczeń w wersji v1.0.
3. Wygląd interfejsu (React): Nowoczesny ciemny motyw (Premium Dark Mode), z harmonijnymi kolorami HSL, zaokrąglonymi kartami, czytelnymi wykresami (Chart.js / Recharts) i dynamicznymi efektami hover. Brak surowych domyślnych styli przeglądarki.
4. Biblioteki zewnętrzne: Używaj lokalnych bibliotek (`geoip-lite` do geolokalizacji oraz `ua-parser-js` do parsowania User-Agenta). Nie wykonuj zewnętrznych zapytań HTTP w procesie rejestracji kliknięć.
```
