# Model danych — TrackFlow

> ✅ Ten dokument został w pełni uzupełniony i zweryfikowany na podstawie wymagań BRIEF.md, CHECKLIST.md oraz projektu architektonicznego.
> Bądź precyzyjny — każde pole, każdy typ, każde ograniczenie.

---

## Zasady projektowe

- **Pola kluczy głównych (PK)**:
  - Tabela `users`, `links` oraz `reports` używają typu **UUID**. Zapobiega to atakom typu *enumeration* (zgadywanie kolejnych identyfikatorów zasobów w API) oraz ułatwia ewentualną dystrybucję baz danych.
  - Tabela `clicks` używa autoincrement **BIGINT (8 bajtów)**. Ponieważ kliknięć będą miliony (szacowane 24M po roku), BIGINT znacznie zmniejsza rozmiar indeksu PK w porównaniu do UUID (16 bajtów), oszczędzając pamięć RAM na VPS oraz przyspieszając operacje zapisu.
- **Czas i strefy czasowe**: Wszystkie pola czasu używają typu `timestamptz` (timestamp z informacją o strefie czasowej), aby uniknąć problemów z synchronizacją czasu między serwerami.
- **Usuwanie miękkie (Soft Delete)**: Zastosowane w tabeli `links` za pomocą kolumny `deleted_at`, aby zapobiec usuwaniu historycznych danych kliknięć powiązanych z usuniętym linkiem (integralność raportów).
- **Indeksy**: Pełny opis indeksów znajduje się w rozdziale 8 dokumentu ARCHITECTURE.md.

---

## Tabela: users

| Kolumna | Typ | Ograniczenia | Opis |
|---------|-----|--------------|------|
| id | uuid | PK, DEFAULT gen_random_uuid() | Unikalny identyfikator użytkownika. |
| email | text | UNIQUE, NOT NULL | Adres e-mail używany do logowania i powiadomień. |
| password_hash | text | NOT NULL | Zahaszowane hasło użytkownika (np. przy użyciu bcrypt). |
| role | text | NOT NULL, CHECK (role IN ('marketer', 'client')) | Rola w systemie decydująca o uprawnieniach. |
| created_at | timestamptz | NOT NULL, DEFAULT NOW() | Data utworzenia konta. |

---

## Tabela: links

| Kolumna | Typ | Ograniczenia | Opis |
|---------|-----|--------------|------|
| id | uuid | PK, DEFAULT gen_random_uuid() | Unikalny identyfikator linku w bazie. |
| short_code | varchar(10) | UNIQUE, NOT NULL | Skrócony kod w URL (np. `xK9mP`), używany do przekierowań. |
| original_url | text | NOT NULL | Pełny docelowy URL, na który następuje przekierowanie. |
| campaign_name | varchar(100) | NULL | Nazwa kampanii marketingowej przypisanej do linku. |
| client_id | uuid | FK → users.id, NULL | Klient agencji (użytkownik z rolą `client`), do którego należy link. |
| expires_at | timestamptz | NULL | Opcjonalna data wygaśnięcia linku (max 365 dni od utworzenia). |
| created_by | uuid | FK → users.id, NOT NULL | Marketer (użytkownik z rolą `marketer`), który utworzył link. |
| created_at | timestamptz | NOT NULL, DEFAULT NOW() | Data utworzenia linku. |
| updated_at | timestamptz | NOT NULL, DEFAULT NOW() | Data ostatniej modyfikacji linku. |
| deleted_at | timestamptz | NULL | Data usunięcia miękkiego (soft delete). |

---

## Tabela: clicks

| Kolumna | Typ | Ograniczenia | Opis |
|---------|-----|--------------|------|
| id | bigint | PK, GENERATED ALWAYS AS IDENTITY | Klucz główny typu auto-increment (BIGINT dla oszczędności RAM). |
| link_id | uuid | FK → links.id, NOT NULL, ON DELETE CASCADE | Powiązany link skrócony. |
| clicked_at | timestamptz | NOT NULL | Czas kliknięcia otrzymany z API podczas redirectu. |
| country | varchar(50) | NULL | Nazwa lub kod kraju określony na podstawie IP (np. `PL`). |
| city | varchar(100) | NULL | Nazwa miasta określona na podstawie IP (np. `Warsaw`). |
| device_type | varchar(20) | NULL, CHECK (device_type IN ('mobile', 'desktop', 'tablet')) | Typ urządzenia określony z User-Agent. |
| browser | varchar(50) | NULL | Nazwa przeglądarki określona z User-Agent (np. `Chrome`). |
| os | varchar(50) | NULL | System operacyjny określony z User-Agent (np. `Windows`). |
| referrer | text | NULL | Adres strony odsyłającej (np. `instagram.com`). |
| ip_hash | varchar(64) | NULL | Zanonimizowany skrót SHA-256 z adresu IP klienta (ochrona RODO). |
| event_id | uuid | UNIQUE, NOT NULL | Unikalny klucz idempotencji generowany przez API dla każdego kliknięcia. |
| created_at | timestamptz | NOT NULL, DEFAULT NOW() | Czas fizycznego zapisu rekordu w bazie danych przez Workera. |

---

## Tabela: reports

| Kolumna | Typ | Ograniczenia | Opis |
|---------|-----|--------------|------|
| id | uuid | PK, DEFAULT gen_random_uuid() | Unikalny identyfikator raportu. |
| status | varchar(20) | NOT NULL, CHECK (status IN ('pending', 'processing', 'done', 'failed')) | Aktualny status przetwarzania raportu. |
| requested_by | uuid | FK → users.id, NOT NULL | Marketer zlecający raport lub powiązany klient (dla autogenerowanych). |
| date_from | timestamptz | NOT NULL | Początek okresu raportowanego. |
| date_to | timestamptz | NOT NULL | Koniec okresu raportowanego. |
| file_path | text | NULL | Ścieżka do zapisanego pliku PDF na wolumenie (np. `/reports/report_id.pdf`). |
| error_message | text | NULL | Treść błędu w przypadku niepowodzenia generowania raportu. |
| created_at | timestamptz | NOT NULL, DEFAULT NOW() | Data zlecenia raportu. |
| completed_at | timestamptz | NULL | Data ukończenia generowania pliku PDF. |

---

## Relacje

```
users     1--* links       (Marketer tworzy wiele linków; klucz: links.created_by)
users     1--* links       (Klient agencji ma przypisane wiele linków; klucz: links.client_id)
users     1--* reports     (Marketer lub klient ma przypisane wiele raportów; klucz: reports.requested_by)
links     1--* clicks      (Link skrócony posiada wiele powiązanych kliknięć; klucz: clicks.link_id)
```

---

## Co NIE idzie do PostgreSQL

| Co | Gdzie | Dlaczego nie w PG |
|----|-------|-------------------|
| **Cache redirectu (short_code → URL)** | Redis | Szybki odczyt in-memory (< 2ms) w celu zapewnienia czasu przekierowania < 80ms. Odpytywanie PostgreSQL o każdy kod przy pikach ruchu przeciążyłoby bazę danych i wydłużyłoby czas reakcji. |
| **Mechanizm kolejkowania zadań (BullMQ / RabbitMQ)** | Redis / RabbitMQ | Kolejkowanie wiadomości o kliknięciach i zleceniach PDF wymaga ekstremalnie szybkich zapisów i odczytów o charakterze tymczasowym. Wykorzystanie PostgreSQL do kolejek prowadzi do fragmentacji tabel (bloat) i spowolnienia bazy. |
| **Blokady deduplikacyjne alertów** | Redis | Zadanie cron sprawdzające brak kliknięć w kampanii (`alert-no-clicks`) co 15 minut musi wiedzieć, czy alert dla danego linku nie został już wysłany w ciągu ostatnich 24h. Redis jest idealny do przechowywania takich flag z czasem wygasania (TTL). |
| **Metadane sesji i blacklisty tokenów JWT** | Redis | Przechowywanie aktywnych sesji i unieważnionych tokenów JWT wymaga częstego odpytywania przy każdym requestu API. Przechowywanie ich w Redis z automatycznym TTL odciąża główną bazę danych. |
