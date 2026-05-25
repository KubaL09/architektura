# Architecture Decision Records (ADR)

> ✅ Ten dokument został w pełni uzupełniony i zweryfikowany. Zawiera kluczowe decyzje architektoniczne dla systemu TrackFlow v1.0 wraz z analizą alternatyw, uzasadnieniem ekonomiczno-technicznym oraz konsekwencjami.
> Bez alternatyw to nie jest decyzja — to ogłoszenie.

---

## ADR-001 — Wybór języka i frameworka backendu

**Status:** Zaakceptowana

**Kontekst:**
Wymagania biznesowe narzucają czas reakcji przekierowania (redirect) poniżej **80ms** dla setek tysięcy kliknięć miesięcznie (docelowo 2M/miesięc za rok). Całość systemu musi działać na jednym serwerze VPS (8 vCPU, 32GB RAM) pod zarządzaniem Docker Compose i być utrzymywana przez **jednego developera** (brak DevOpsa).

**Problem:**
Jak zbudować API Server oraz Worker Service, aby zagwarantować czas redirectu < 80ms przy 10-krotnym wzroście skali, minimalizując jednocześnie próg wejścia i koszty utrzymania kodu?

**Opcje:**
- **Opcja A: TypeScript z Node.js + Fastify (dla API) oraz czysty Node.js (dla Workera).** Fastify to wysoce zoptymalizowany, ultradźwiękowy framework HTTP o minimalnym narzucie (overhead) z wbudowaną walidacją schematów JSON. TypeScript zapewnia bezpieczeństwo typów i pozwala na współdzielenie kodu/kontraktów między API, Workerem i frontendem.
- **Opcja B: Go z frameworkiem Gin.** Niezwykle szybki język kompilowany o minimalnym zużyciu zasobów (RAM/CPU). Wady: Brak dojrzałego ekosystemu do generowania PDF (Puppeteer nie ma natywnego, stabilnego odpowiednika w Go bez wywoływania Node.js w tle), dłuższy czas developmentu dla jednego programisty.
- **Opcja C: Python z FastAPI.** Bardzo szybki development i świetna dokumentacja. Wady: Niższa wydajność współbieżna Node.js/Fastify, brak bezpośredniego współdzielenia kodu typów z frontendem w TS.

**Decyzja:**
Wybieram **Opcję A (TypeScript z Node.js + Fastify dla API / Node.js dla Workera)**.

**Uzasadnienie:**
Fastify umożliwia obsługę zapytań HTTP w czasie pojedynczych milisekund. Zgodnie z wyliczeniami w ARCHITECTURE.md, czas przekierowania z użyciem cache wynosi ~15ms, co daje ogromny zapas do limitu 80ms. TypeScript pozwala jednemu programiście na błyskawiczne wdrażanie zmian w całym stacku (monorepo), a dojrzały ekosystem Node.js pozwala na bezproblemową integrację Puppeteera (generowanie PDF) i lokalnej geolokalizacji.

**Konsekwencje:**
- (+) Ekstremalnie niski czas przetwarzania żądań HTTP (< 5ms napowietrznego czasu frameworka).
- (+) Szybki rozwój oprogramowania (time-to-market) i łatwość utrzymania przez jednego dewelopera.
- (+) Pełne współdzielenie modeli danych i typów kontraktów w całym repozytorium.
- (-) Node.js jest jednowątkowy, co wymaga odpowiedniego klastrowania procesów na serwerze 8 vCPU (rozwiązane przez Docker Compose i skalowanie instancji kontenera).

**Kiedy zrewidować:**
Gdy ruch na platformie wzrośnie powyżej 100-krotności planowanej skali SaaS (ponad 200M kliknięć/miesiąc) i narzut wątku Node.js stanie się wąskim gardłem.

---

## ADR-002 — Wybór bazy danych

**Status:** Zaakceptowana

**Kontekst:**
System TrackFlow opiera swój model biznesowy na dokładności danych o kliknięciach ("Dane to nasz produkt, żadne nie mogą zginąć"). Szacujemy, że po roku baza danych kliknięć urośnie do **13.2M – 24M rekordów**, co przełoży się na ok. **6.6 GB – 12 GB** danych na dysku wraz z indeksami.

**Problem:**
Jaką bazę danych wybrać, aby zagwarantować 100% spójności danych, niezawodność zapisu oraz wydajne generowanie skomplikowanych raportów okresowych dla klientów agencji?

**Opcje:**
- **Opcja A: PostgreSQL (relacyjna baza danych).** Klasyczny, dojrzały silnik wspierający pełne transakcje ACID, z zaawansowanymi indeksami (B-Tree, indeksy kompozytowe) i potężnym silnikiem agregacji danych SQL.
- **Opcja B: MongoDB (baza dokumentowa NoSQL).** Zapewnia bardzo szybki zapis pojedynczych dokumentów kliknięć bez sztywnego schematu. Wady: Brak silnych relacji, słabsza wydajność przy skomplikowanych agregacjach raportów tygodniowych, większe zużycie przestrzeni dyskowej i pamięci RAM na VPS.

**Decyzja:**
Wybieram **Opcję A (PostgreSQL v15+)**.

**Uzasadnienie:**
Gwarancja transakcyjności ACID jest kluczowa dla zachowania spójności relacji użytkownik-link-kliknięcie. Odpowiednie indeksy kompozytowe (np. na kolumnach `link_id, clicked_at`) sprawiają, że PostgreSQL agreguje miliony kliknięć pod raporty PDF w ułamku sekundy. Przy prognozowanym rozmiarze bazy danych wynoszącym maksymalnie 12 GB po roku, cała baza mieści się w pamięci RAM serwera VPS (32GB RAM), co eliminuje opóźnienia I/O na dysku.

**Konsekwencje:**
- (+) 100% spójności danych (brak sierocych kliknięć bez przypisania do linku).
- (+) Zaawansowane możliwości optymalizacji zapytań agregujących poprzez indeksy i partycjonowanie.
- (+) Stabilność i łatwe tworzenie kopii zapasowych (backup) bazy danych przez jednego dewelopera.
- (-) PostgreSQL wymaga starannego projektowania indeksów i migracji przy rosnącej skali.

**Kiedy zrewidować:**
Jeśli baza danych przekroczy 500 GB i konieczne będzie wdrożenie zaawansowanego sharding-u lub przejście na rozproszone bazy NewSQL (np. CockroachDB).

---

## ADR-003 — Strategia cache dla redirectu

**Status:** Zaakceptowana

**Kontekst:**
Każde kliknięcie w link skrócony wymaga błyskawicznej odpowiedzi HTTP 302 z czasem odpowiedzi do klikającego **< 80ms**. Bezpośrednie odpytywanie bazy danych PostgreSQL przy każdym żądaniu przekierowania zniweczyłoby ten cel przy nagłych pikach ruchu.

**Problem:**
Jak zaimplementować warstwę cache dla skróconych linków, aby odciążyć bazę danych i zapewnić czas dostępu do oryginalnego URL na poziomie pojedynczych milisekund?

**Opcje:**
- **Opcja A: Cache w pamięci lokalnej procesu serwera API (np. lru-cache w Node.js).** Najszybsza możliwa opcja (brak narzutu sieciowego). Wady: Trudna synchronizacja i inwalidacja danych przy wielu kontenerach API, utrata całego cache po restarcie aplikacji.
- **Opcja B: Cache w zewnętrznej bazie Redis (in-memory).** Dane przechowywane w pamięci RAM z czasem wygasania (TTL) i możliwością bezpośredniej inwalidacji przez API Server podczas modyfikacji lub usunięcia linku przez marketera.

**Decyzja:**
Wybieram **Opcję B (Redis jako rozproszony cache)**.

**Uzasadnienie:**
Odczyt z Redis trwa średnio **< 2ms**, co bez problemu pozwala utrzymać redirect w granicach ~15ms. 5000 aktywnych linków w skali SaaS zajmie w pamięci Redis zaledwie kilka megabajtów, co stanowi ułamek dostępnych 32GB RAM na VPS. Zapewnia to pełną niezależność od restartów serwera API, a marketerzy mogą natychmiastowo inwalidować cache w momencie modyfikacji linku (np. zmiana oryginalnego URL).

**Konsekwencje:**
- (+) Sub-milisekundowe opóźnienie odczytu na krytycznej ścieżce redirectów.
- (+) Niezależność stanu cache od kontenerów API i łatwa inwalidacja kluczy.
- (+) Możliwość rozszerzenia użycia Redisa o przechowywanie sesji, rate-limiting oraz JWT blacklist.
- (-) Konieczność zarządzania dodatkowym kontenerem w Docker Compose.

**Kiedy zrewidować:**
Nie przewiduje się potrzeby rewizji tej decyzji — Redis jest standardem branżowym dla tej skali.

---

## ADR-004 — Wybór brokera kolejki

**Status:** Zaakceptowana

**Kontekst:**
Proces przekierowania użytkownika nie może czekać na powolne operacje zapisu do bazy danych, parsowania User-Agent oraz geolokalizacji IP. Zapis musi odbywać się w 100% asynchronicznie, przy jednoczesnym bezwzględnym zakazie utraty danych kliknięć ("żadne dane nie mogą zginąć").

**Problem:**
Jakiego brokera kolejki komunikatów wybrać, aby zagwarantować niezawodne dostarczanie wiadomości typu at-least-once i skutecznie odseparować API od Workera?

**Opcje:**
- **Opcja A: RabbitMQ (dedykowany broker AMQP).** Dojrzały i wysoce niezawodny broker. Wspiera trwałe kolejki (durable), trwałe wiadomości (persistent), zaawansowany routing, manualne potwierdzenia (manual ACK) oraz Dead Letter Exchanges (DLX) do automatycznego odkładania błędnych komunikatów.
- **Opcja B: BullMQ (kolejka oparta o Redis).** Wykorzystuje Redis jako silnik kolejki. Zaleta: Mniej kontenerów w stacku (używamy tego samego Redisa co do cache). Wady: Redis staje się pojedynczym punktem awarii (SPOF) dla obu warstw. Ryzyko utraty komunikatów w kolejce przy nagłej awarii pamięci RAM Redisa, jeśli nie ma włączonej agresywnej persystencji na dysku (co z kolei spowalnia cache).
- **Opcja C: Apache Kafka.** Potężna platforma strumieniowania. Wady: Ogromny overengineering dla skali 7.7 kliknięć/s, bardzo wysokie zużycie pamięci i skomplikowane zarządzanie na jednym VPS.

**Decyzja:**
Wybieram **Opcję A (RabbitMQ)**.

**Uzasadnienie:**
Gwarancja "dane nie mogą zginąć" w połączeniu z chęcią separacji pamięci podręcznej (Redis) od kolejki komunikatów przesądza na korzyść RabbitMQ. Dedykowany broker chroni nas przed utratą danych przy awarii cache. Dzięki trwałym kolejkom komunikat z kliknięciem zostanie zapisany na dysk i będzie czekał na manualny ACK od Workera. W przypadku awarii bazy danych lub Workera, wiadomości bezpiecznie gromadzą się w RabbitMQ i zostaną przetworzone po usunięciu awarii. Narzut pamięciowy RabbitMQ (~100-200MB) jest znikomy dla naszego serwera VPS.

**Konsekwencje:**
- (+) Pełne bezpieczeństwo komunikatów (gwarancja dostarczenia at-least-once).
- (+) Dedykowane, łatwe w obsłudze UI do monitorowania kolejek (RabbitMQ Management).
- (+) Łatwa obsługa błędów dzięki Dead Letter Queue (DLQ).
- (-) Konieczność konfiguracji i utrzymywania osobnego kontenera RabbitMQ.

**Kiedy zrewidować:**
Nie przewiduje się potrzeby rewizji w dającej się przewidzieć przyszłości.

---

## ADR-005 — Geolokalizacja IP oraz generowanie raportów PDF w tle

**Status:** Zaakceptowana

**Kontekst:**
Wymagania narzucają geolokalizację każdego kliknięcia na poziom kraju i miasta oraz automatyczne generowanie i wysyłanie raportów PDF w poniedziałki o 8:00 (opóźnienie max 15 minut). System musi realizować te zadania bez ponoszenia dodatkowych kosztów licencyjnych i abonamentowych za zewnętrzne API.

**Problem:**
Jak realizować geolokalizację adresów IP w tle oraz generować pliki PDF bez polegania na płatnych, limitowanych zewnętrznych usługach SaaS?

**Opcje:**
- **Opcja A: Zewnętrzne API (np. ip-api.com dla geolokalizacji / PDFShift dla generowania PDF).** Wady: Koszty abonamentowe, opóźnienia sieciowe, ryzyko awarii zewnętrznego serwisu (SPOF) i wyczerpania limitów żądań.
- **Opcja B: Lokalne komponenty w kontenerze Workera — biblioteka `geoip-lite` do geolokalizacji oraz `Puppeteer` do generowania PDF.** Geolokalizacja opiera się na lokalnym pliku bazy danych IP wczytanym do pamięci Workera. Generowanie PDF odbywa się poprzez renderowanie HTML przez bezgłową przeglądarkę Chromium kontrolowaną przez Puppeteera.

**Decyzja:**
Wybieram **Opcję B (lokalne biblioteki geoip-lite i Puppeteer w kontenerze Workera)**.

**Uzasadnienie:**
Lokalna baza `geoip-lite` umożliwia błyskawiczne (poniżej 1ms) określenie lokalizacji IP bez zapytań sieciowych. Wykorzystanie Puppeteera pozwala na pełną kontrolę nad wyglądem raportów PDF przy użyciu standardowych technologii webowych (HTML/CSS) i ich bezpłatne generowanie w dowolnej ilości. Przeniesienie tych operacji do asynchronicznego Workera całkowicie eliminuje ich wpływ na działanie API Server.

**Konsekwencje:**
- (+) Całkowity brak kosztów operacyjnych i licencyjnych w fazie beta i SaaS.
- (+) Maksymalna stabilność i odporność na awarie sieci zewnętrzne.
- (+) Łatwe wdrażanie poprawek wizualnych w raportach za pomocą standardowego CSS.
- (-) Rozmiar kontenera Workera rośnie o około 300MB z powodu instalacji Chromium (akceptowalne).

**Kiedy zrewidować:**
Jeśli w fazie SaaS wymagana będzie precyzja lokalizacji IP na poziomie ulic (wtedy przejdziemy na bazę MaxMind GeoIP2) lub gdy wolumen generowanych raportów PDF przekroczy możliwości procesora na pojedynczym VPS (wtedy wydzielimy dedykowany mikroserwis PDF).
