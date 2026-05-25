# TrackFlow — Projekt zespołowy

> System skracania i śledzenia linków dla agencji marketingowej.
>
> **Status fazy projektowej:** ✅ **ZAKOŃCZONA I ZWERYFIKOWANA**. Wszystkie dokumenty architektoniczne, kontrakty, modele danych oraz konfiguracja infrastruktury zostały w 100% zdefiniowane i są gotowe na rozpoczęcie implementacji.

---

## Twoja rola

Jesteś **architektem i product ownerem**.
Claude Code jest seniorem, który implementuje system.

**Zasada:** Dokumentacja została napisana tak precyzyjnie, aby agent zbudował system bez zgadywania i pytań na czacie.

---

## Struktura projektu

Wszystkie pliki projektowe zostały w pełni uzupełnione:

```
trackflow/
├── docs/
│   ├── BRIEF.md                     ✅ gotowy — wymagania biznesowe i skrajne
│   ├── architecture/
│   │   ├── ARCHITECTURE.md          ✅ gotowy — analizy skali, C1, C2, przepływy i indeksy
│   │   ├── DECISIONS.md             ✅ gotowy — 5 zdefiniowanych decyzji ADR z alternatywami
│   │   └── DATA_MODEL.md            ✅ gotowy — kompletny schemat bazy PostgreSQL i podział cache
│   └── contracts/
│       ├── API.md                   ✅ gotowy — pełna specyfikacja JSON i endpointy REST API
│       ├── EVENTS.md                ✅ gotowy — routing RabbitMQ, payloady i deduplikacja alertów
│       └── WORKER.md                ✅ gotowy — biblioteki integrujące (geo, Puppeteer, SMTP) i testy
├── infra/
│   └── docker-compose.yml           ✅ gotowy — pełna konfiguracja Postgres, Redis, RabbitMQ, Mailhog, API, Worker
├── CLAUDE.md                        ✅ gotowy — instrukcje techniczne i 17-krokowy plan dla Claude Code
├── CHECKLIST.md                     ✅ gotowy — wszystkie punkty przygotowawcze odhaczone w 100%
└── README.md                        ✅ ten plik (zaktualizowany o status gotowości wdrożeniowej)
```

---

## Status kolejki prac (Kolejność pracy)

```
1.  [x] Przeczytaj docs/BRIEF.md
2.  [x] Zrób back-of-envelope math
3.  [x] Wypełnij docs/architecture/ARCHITECTURE.md
4.  [x] Wypełnij docs/architecture/DECISIONS.md  (min. 4 ADR)
5.  [x] Wypełnij docs/architecture/DATA_MODEL.md
6.  [x] Wypełnij docs/contracts/API.md
7.  [x] Wypełnij docs/contracts/EVENTS.md
8.  [x] Wypełnij docs/contracts/WORKER.md
9.  [x] Napisz CLAUDE.md
10. [x] Sprawdź CHECKLIST.md — odhacz każdy punkt w 100%
11. [ ] Uruchom agenta (Claude Code) za pomocą promptu poniżej!
```

---

## Stack technologiczny (Podsumowanie)

Zgodnie ze zdefiniowanymi decyzjami ADR, system opiera się na wydajnych technologiach open-source:
- **Język i Framework**: TypeScript (Node.js) z Fastify (czas redirectu z cache ~15ms, w pełni spełniający limit < 80ms).
- **Relacyjna baza danych**: PostgreSQL v15+ (transakcyjność ACID, optymalne klucze BIGINT dla kliknięć, indeksy kompozytowe).
- **Cache in-memory**: Redis (błyskawiczny odczyt linków w czasie < 2ms, blokady deduplikacyjne alertów z czasem TTL).
- **Kolejkowanie asynchroniczne**: RabbitMQ (exchange topic, trwale kolejki click/report/notification, manualne ACK, Dead-Letter Queue).
- **Worker w tle**: geolokalizacja offline (`geoip-lite`), parsowanie UA (`ua-parser-js`), bezpłatne generowanie PDF (`Puppeteer` Chromium), wysyłka SMTP (`nodemailer` + `Mailhog` w dev).

---

## Definicja "gotowe" dla fazy implementacji

Deweloper Claude Code ma za zadanie dostarczyć w pełni działający kod spełniający kryteria:
- [ ] `docker-compose up` odpala cały system bez błędów.
- [ ] Redirect GET `/:short_code` działa stabilnie i w czasie < 80ms (zmierzone lokalnie za pomocą curl).
- [ ] Kliknięcie pojawia się w statystykach w bazie i interfejsie w max 5 sekund.
- [ ] Worker bezproblemowo konsumuje eventy z kolejek RabbitMQ.
- [ ] Raport PDF generuje się prawidłowo, zapisuje na wolumenie i jest w pełni pobieralny przez przeglądarkę.
- [ ] Wszystkie obowiązkowe testy jednostkowe i integracyjne przechodzą bez błędów.

---

## Pierwszy prompt do Claude Code (Rozpoczęcie prac)

> Skopiuj poniższy prompt, otwórz terminal w katalogu projektu, wpisz `claude` (aby uruchomić dewelopera Claude Code) i wklej go, by rozpocząć automatyczną implementację systemu:

```
Jesteś seniorem TypeScript z Fastify.

Przeczytaj w tej kolejności:
1. docs/BRIEF.md
2. docs/architecture/ARCHITECTURE.md
3. docs/architecture/DECISIONS.md
4. docs/architecture/DATA_MODEL.md
5. docs/contracts/API.md
6. docs/contracts/EVENTS.md
7. docs/contracts/WORKER.md
8. CLAUDE.md

Po przeczytaniu odpowiedz na trzy pytania i czekaj na moją zgodę:
1. Jakie kontenery zbudujesz (lista z technologią każdego)?
2. Jak wygląda przepływ redirect — krok po kroku, z czasem każdego kroku?
3. Czy czegoś brakuje w dokumentach żebyś mógł zacząć?

Nie pisz żadnego kodu dopóki nie powiem "OK, zacznij od Kroku 1".
```
