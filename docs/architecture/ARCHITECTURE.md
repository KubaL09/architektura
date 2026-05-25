# Architektura systemu — TrackFlow

> ✅ Ten dokument został uzupełniony i zweryfikowany na podstawie BRIEF.md, CHECKLIST.md oraz README.md.

---

## 1. Back-of-envelope math

Dane z briefu: 200 000 kliknięć/miesiąc dziś → 2 000 000 za rok (10x wzrost)

```
Kliknięć / dzień (dziś):           ~6 667
Kliknięć / sekundę (dziś):         ~0.077 req/s (średnio), peak: ~0.77 req/s
Kliknięć / sekundę (za rok):       ~0.77 req/s (średnio), peak: ~7.7 req/s (zakładając piki 10x)
Rekordów w tabeli clicks po roku:  ~13 200 000 (przy liniowym wzroście) lub ~24 000 000 (rok przy pełnej skali SaaS)
Szacowana wielkość tabeli clicks:  ~6.6 GB (dla 13.2M rekordów) / ~12.0 GB (dla 24M rekordów) przy ~500B na wiersz z indeksami
Raporty PDF / tydzień:             40 (dziś dla beta) → 200 (za rok dla SaaS) raportów automatycznych + ok. 50-100 na żądanie
```

Wnioski:

```
Bottleneck #1 to generowanie raportów PDF w poniedziałek o 8:00 ponieważ proces ten jest wysoce zasobożerny (CPU-bound) i generowanie 200 raportów jednocześnie mogłoby zablokować serwer API oraz przekroczyć dopuszczalne opóźnienie 15 minut.
Bottleneck #2 to przetwarzanie geolokalizacji IP oraz parsowanie User-Agent przy nagłych pikach ruchu (np. wysyłka mailingu do 100 tys. użytkowników), co zajmuje zbyt dużo czasu i uniemożliwiłoby odpowiedź w < 80ms.
Redirect NIE może iść do bazy ponieważ bezpośrednie odpytywanie PostgreSQL przy każdym kliknięciu wiąże się z opóźnieniami I/O oraz ryzykiem wyczerpania puli połączeń przy pikach ruchu, co uniemożliwiłoby stabilną obsługę żądań w czasie < 80ms.
Cache jest potrzebny dla natychmiastowej obsługi redirectów (short_code -> original_url) i trzymam w nim aktywne linki jako pary klucz-wartość (klucz: short_code, wartość: JSON z danymi linku i datą wygaśnięcia).
Zapis kliknięcia jest asynchroniczny ponieważ geolokalizacja IP oraz parsowanie User-Agent trwają zbyt długo (nawet do kilkuset milisekund), podczas gdy wrzucenie prostego eventu do kolejki (np. RabbitMQ) zajmuje < 2ms, co pozwala utrzymać redirect poniżej 80ms.
```

---

## 2. C1 — Context Diagram

```
                                 +------------------+
                                 |  Osoba klikająca |
                                 +--------+---------+
                                          |
                                 klika skrócony link
                                 (HTTP GET /:code)
                                          |
                                          v
+------------------+             +--------+---------+             +-------------------+
|     Marketer     |------------>|     TrackFlow    |<------------|  Klient agencji   |
+------------------+  zarządza   +--------+---------+  przegląda  +-------------------+
                      linkami             |            statystyki
                      i raportami         |            (tylko odczyt)
                                          |
                        +-----------------+-----------------+
                        |                                   |
                wysyła raporty /                    geolokalizacja
                    alerty                              z IP
                        |                                   |
                        v                                   v
             +----------+----------+             +----------+----------+
             |    System e-mail    |             |    Biblioteka IP    |
             |      (Mailhog)      |             |    (geoip-lite)     |
             +---------------------+             +---------------------+
```

| Element | Typ | Co robi |
|---------|-----|---------|
| Marketer | Aktor | Tworzy i usuwa skrócone linki, przegląda zaawansowane statystyki, generuje raporty PDF na żądanie, otrzymuje powiadomienia o braku kliknięć w aktywnej kampanii. |
| Klient agencji | Aktor | Posiada dostęp tylko do odczytu dla własnych statystyk na dashboardzie oraz otrzymuje automatyczny tygodniowy raport PDF na e-mail w poniedziałki o 8:00. |
| Osoba klikająca | Aktor | Klika w skrócone linki (np. trckflw.io/xK9mP) i jest błyskawicznie przekierowywana (< 80ms) na oryginalny adres URL; jej dane są gromadzone w tle. |
| Biblioteka IP (geoip-lite) | System zewnętrzny | Lokalna biblioteka uruchamiana w kontenerze Workera służąca do offline-owej geolokalizacji adresów IP na poziom kraju i miasta (brak zewnętrznych zapytań HTTP). |
| System e-mail (Mailhog / SMTP) | System zewnętrzny | Zewnętrzny serwer SMTP (w środowisku dev Mailhog) używany do wysyłania powiadomień alertowych oraz cotygodniowych raportów PDF. |

---

## 3. C2 — Container Diagram

| Kontener | Technologia | Odpowiedzialność |
|----------|-------------|-----------------|
| **Frontend App** | React + Vite (SPA) + Nginx | Interfejs użytkownika dla marketerów oraz klientów agencji. Wyświetla statystyki, listę linków i pozwala na zlecanie raportów. |
| **API Server** | Node.js (TypeScript) + Fastify | Obsługa zapytań HTTP REST (auth, CRUD linków, statystyki, pobieranie raportów) oraz krytyczna ścieżka przekierowań (GET /:short_code) korzystająca z cache. Publikuje eventy. |
| **Cache Store** | Redis | Szybki in-memory store przechowujący mapowania `short_code -> original_url` dla natychmiastowego redirectu oraz dane sesyjne / blokady. |
| **Message Broker** | RabbitMQ | Niezawodny broker wiadomości obsługujący trwale kolejki (`clicks`, `reports`, `notifications`) z gwarancją at-least-once. |
| **Worker Service** | Node.js (TypeScript) + Cron | Konsumpcja eventów w tle (parsowanie UA, geolokalizacja IP, zapis do DB, generowanie PDF przez Puppeteer, wysyłka e-maili) oraz wykonywanie harmonogramów cyklicznych (cron). |
| **Database** | PostgreSQL | Trwałe źródło prawdy dla systemu. Przechowuje dane użytkowników, linków, kliknięć (tabela clicks) oraz statusów raportów. |

```
Diagram połączeń (z protokołami):

                                         +------------------+
                                         |  Web Browser     |
                                         |  (Frontend SPA)  |
                                         +--------+---------+
                                                  |
                                             HTTPS| (REST API / JWT)
                                                  v
   +------------------+  HTTP GET        +--------+---------+
   | Osoba klikająca  |----------------->|    API Server    |
   +------------------+  (redirect <80ms)| (Fastify / Node) |
                                         +---+----+----+----+
                                             |    |    |
                              Redis Protocol |    |    | AMQP (publish click.recorded)
                          (short_code cache) |    |    +--------------------------+
                                             v    |                               |
                                         +---+----+    | PostgreSQL Protocol      |
                                         |  Redis |    | (read/write fallback)    |
                                         +--------+    v                          v
                                                   +---+----+             +-------+--------+
                                                   | Postgres |           |    RabbitMQ    |
                                                   +--------+             +-------+--------+
                                                       ^                          ^
                                                       |                          |
                                  PostgreSQL Protocol  |                          | AMQP
                                  (read/write clicks)  |                          | (consume events)
                                                       +-------------+------------+
                                                                     |
                                                                     v
                                                          +----------+----------+
                                                          |    Worker Service   |
                                                          |   (Node.js + Cron)  |
                                                          +-----+-----------+---+
                                                                |           |
                                                  Local library |           | SMTP
                                                                v           v
                                                          +-----+----+ +----+----+
                                                          | geoip &  | | Mailhog |
                                                          | parser UA| |  (SMTP) |
                                                          +----------+ +---------+
```

> Dlaczego Worker jest osobnym kontenerem?
> Worker izoluje ciężkie zadania (CPU-bound) takie jak generowanie plików PDF za pomocą Puppeteera oraz parsowanie metadanych kliknięć (IP, User-Agent) od serwera API. Dzięki temu serwer API zachowuje pełną responsywność na krytycznej ścieżce redirectów, a awaria lub wyciek pamięci w Workerze nie wpływa na stabilność i czas działania przekierowań. Kontenery można także niezależnie skalować.

> Dlaczego kliknięcie nie idzie od razu do bazy?
> Bezpośredni, synchroniczny zapis do bazy danych PostgreSQL podczas redirectu zablokowałby odpowiedź HTTP do klienta na czas operacji I/O oraz transakcji DB. Przy pikach ruchu baza mogłaby szybko wyczerpać pulę połączeń, drastycznie podnosząc czas odpowiedzi powyżej wymaganych 80ms. Przesłanie wiadomości do RabbitMQ trwa poniżej 2ms, co eliminuje ten problem.

> Co trzymasz w cache i dlaczego?
> W cache Redis trzymamy aktywne skrócone linki (klucz: `link:short_code`, wartość: JSON zawierający `id`, `original_url`, `expires_at`). Pozwala to na natychmiastowy odczyt w czasie < 2ms bezpośrednio z pamięci RAM podczas obsługi redirectu, całkowicie omijając bazę danych PostgreSQL na krytycznej ścieżce.

---

## 4. Przepływ — Redirect (< 80ms)

| Krok | Opis | Czas (ms) |
|------|------|-----------|
| 1 | Osoba klikająca wysyła żądanie `GET /:short_code` do API Server | ~5 ms |
| 2 | API Server sprawdza obecność kodu w cache Redis (`GET link:short_code`) - cache hit | ~2 ms |
| 3 | API Server weryfikuje warunek wygaśnięcia linku i generuje odpowiedź HTTP 302 z nagłówkiem `Location` | ~3 ms |
| 4 | Klient otrzymuje odpowiedź i przeglądarka rozpoczyna przekierowanie | ~5 ms |
| 5 | Po wysłaniu odpowiedzi 302, API Server asynchronicznie publikuje event `click.recorded` do RabbitMQ (w tle, poza krytyczną ścieżką) | ~2 ms (tło) |
| **Suma** | **Czas od requestu do otrzymania odpowiedzi 302 (odczuwalny dla użytkownika)** | **~15 ms** |

```
Co przy cache miss:      API Server odpytuje PostgreSQL. Jeśli link istnieje i jest aktywny, zapisuje go do Redis z odpowiednim TTL, a następnie wykonuje redirect. Trwa to około ~30ms, co wciąż mieści się w limicie 80ms. Kolejne kliknięcia będą już obsługiwane bezpośrednio z Redis.
Co gdy Redis jest down:  API Server płynnie przełącza się w tryb awaryjny (graceful degradation) i odpytuje bezpośrednio bazę PostgreSQL o każdy redirect. Czas odpowiedzi wzrasta do ~35-50ms, ale system zachowuje pełną sprawność.
```

---

## 5. Przepływ — Przetwarzanie kliknięcia (max 5s)

| Krok | Opis | Kto |
|------|------|-----|
| 1 | API Server asynchronicznie wysyła event `click.recorded` do exchange w RabbitMQ | API Server |
| 2 | RabbitMQ routuje wiadomość do kolejki `trackflow.clicks`, która jest natychmiast pobierana przez wolnego Workera | RabbitMQ |
| 3 | Worker sprawdza czy `event_id` (UUID) istnieje już w bazie danych w celu uniknięcia duplikatu (idempotency check) | Worker |
| 4 | Worker parsowuje User-Agent (ua-parser-js) na system/urządzenie/przeglądarkę oraz geolokalizuje IP za pomocą lokalnej bazy (geoip-lite) | Worker |
| 5 | Worker zapisuje przetworzone kliknięcie do tabeli `clicks` w PostgreSQL i wysyła potwierdzenie (ACK) do brokera | Worker |

```
Co gwarantuje że dane nie zginą:   Trwałość kolejki (durable) i wiadomości (persistent) w RabbitMQ, brak auto-ACK (potwierdzenie manualne dopiero po udanym zapisie do PostgreSQL) oraz mechanizm ponawiania prób (retry 3x -> DLQ).
Jak zapewniasz idempotentność:     Każdy event kliknięcia generuje unikalne `event_id` (UUID) na etapie API. Tabela `clicks` ma nałożony klucz UNIQUE na kolumnę `event_id`. Przed zapisem Worker sprawdza obecność tego ID w bazie danych i natychmiast wysyła ACK dla duplikatów bez ich ponownego zapisu.
```

---

## 6. Przepływ — Generowanie raportu PDF

| Krok | Opis |
|------|------|
| 1 | Marketer klika "Generuj raport" w interfejsie frontendowym |
| 2 | API Server tworzy rekord w tabeli `reports` ze statusem `pending` i wysyła event `report.requested` do RabbitMQ |
| 3 | API Server natychmiast zwraca status 202 Accepted z `report_id`. Frontend rozpoczyna odpytywanie (polling) co 3 sekundy |
| 4 | Worker pobiera zadanie, zmienia status w bazie na `processing`, agreguje dane statystyczne i generuje dokument PDF (Puppeteer) |
| 5 | Worker zapisuje plik PDF na współdzielonym wolumenie dockerowym, zmienia status na `done` i uzupełnia pole `file_path` |
| 6 | Frontend przy kolejnym zapytaniu pollingowym pobiera gotowy status `done` i wyświetla marketerowi link do pobrania pliku |

```
Dlaczego async:                    Generowanie PDF (agregacja milionów wierszy + renderowanie HTML przez Puppeteera) to proces trwający od kilku do kilkunastu sekund. Gdyby był synchroniczny, zablokowałby wątek serwera API i doprowadziłby do timeoutu HTTP u klienta.
Gdzie jest przechowywany PDF:      Na współdzielonym wolumenie Docker Compose (np. /app/storage/reports), do którego dostęp do zapisu ma Worker, a dostęp do odczytu ma API Server w celu serwowania plików.
Jak marketer dostaje info:         Przez automatyczny polling (odpytywanie co 3s) statusu raportu na dedykowanym endpoincie API (`GET /api/reports/:id`) oraz za pomocą powiadomienia e-mail (event `notification.send`), jeśli raport był generowany okresowo.
```

---

## 7. Failure scenarios

| Komponent pada | Co robi system | Dane bezpieczne? |
|---------------|----------------|-----------------|
| Redis | System przełącza się na odpytywanie PostgreSQL o oryginalne adresy URL przy każdym redirectu. Czas odpowiedzi rośnie (~40ms), ale przekierowania działają stabilnie. | **TAK**. PostgreSQL jest ostatecznym źródłem prawdy dla definicji linków. |
| Broker kolejki | API Server loguje błąd publikacji eventu i zapisuje informacje o kliknięciu lokalnie (np. do pliku logu/bufora pamięciowego), aby nie przerywać redirectu. Po przywróceniu brokera eventy są retransmitowane. | **TAK**. Awaria kolejki nie powoduje odrzucenia kliknięcia, a jedynie opóźnienie w pojawieniu się go w statystykach. |
| Worker | Wiadomości o kliknięciach i zleceniach raportów bezpiecznie gromadzą się w trwałych kolejkach RabbitMQ. Po podniesieniu Workera są one przetwarzane w kolejności przybycia. | **TAK**. Kolejki przechowują wiadomości w pamięci/dysku do czasu otrzymania manualnego ACK od podniesionego Workera. |
| PostgreSQL | API Server obsługuje redirecty dla linków obecnych w cache Redis (hit). Wszelkie operacje zapisu (tworzenie linków, logowanie) oraz statystyki zwracają błąd 503 Service Unavailable. Worker nie przetwarza eventów (brak ACK, czekają w kolejce). | **TAK**. Dane historyczne są bezpieczne na dysku, a nowe eventy kliknięć czekają nienaruszone w kolejce RabbitMQ do momentu przywrócenia bazy. |
| API geo / UA | Worker w przypadku niepowodzenia parsowania lub geolokalizacji (np. nieznany zakres IP lub błąd biblioteki) zapisuje wartość `Unknown` lub `null` w odpowiednich kolumnach i poprawnie zapisuje kliknięcie do bazy. | **TAK**. Błędy metadanych nie przerywają głównego przepływu rejestracji kliknięcia. |

---

## 8. Indeksy bazy danych

| Tabela | Kolumna(y) | Uzasadnienie |
|--------|-----------|--------------|
| **links** | `short_code` | PK / UNIQUE. Krytyczny dla natychmiastowego wyszukiwania oryginalnego adresu URL w przypadku cache miss. |
| **links** | `created_by` | FK. Przyspiesza listowanie i filtrowanie linków należących do zalogowanego marketera. |
| **clicks** | `event_id` | UNIQUE. Kluczowy dla błyskawicznego sprawdzania warunku idempotencji przed zapisaniem kliknięcia przez Workera. |
| **clicks** | `link_id, clicked_at` | Indeks kompozytowy. Niezbędny do szybkiego generowania statystyk dla dashboardu i raportów w określonych przedziałach czasowych (wykresy kliknięć). |
| **clicks** | `clicked_at` | Umożliwia szybkie przeszukiwanie kliknięć dla zadań cron (np. sprawdzanie braku kliknięć w ostatnich 24 godzinach). |
| **reports** | `requested_by, created_at` | FK + Timestamp. Przyspiesza pobieranie historii raportów wygenerowanych przez danego użytkownika posortowanych od najnowszych. |
