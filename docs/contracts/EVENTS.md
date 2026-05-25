# Kontrakt eventów — kolejka wiadomości

> ✅ Ten dokument definiuje pełny kontrakt wiadomości, kolejki oraz zadań cyklicznych (cron) obsługiwanych przez system kolejkowania. Agent implementuje wydawców (publishers) i odbiorców (consumers) zgodnie z poniższą specyfikacją.

---

## Konfiguracja Brokera (RabbitMQ)

Zgodnie z decyzją architektoniczną w **ADR-004**, system korzysta z dedykowanego brokera **RabbitMQ**.

- **Exchange**: `trackflow.events` (typ: `topic`, trwały - `durable: true`)
- **DLQ Exchange**: `trackflow.dead` (typ: `direct`, trwały)
- **Kolejki i Routing Keys**:

| Kolejka (Queue) | Routing Key | Typ komunikatów | Powiązany Consumer |
|-----------------|-------------|-----------------|-------------------|
| `trackflow.clicks` | `click.recorded` | Rejestracja kliknięć w linki | Worker (Zapis statystyk) |
| `trackflow.reports` | `report.requested` | Zlecenia wygenerowania raportów PDF | Worker (Generowanie PDF) |
| `trackflow.notifications` | `notification.send` | Zlecenia wysyłki powiadomień e-mail | Worker (Wysyłka SMTP) |
| `trackflow.dead-letter` | `#` (z DLQ Exchange) | Wszystkie nieprzetworzone/błędne komunikaty | DLQ Monitor |

*Uwaga: Każda kolejka ma skonfigurowany parametr `x-dead-letter-exchange` ustawiony na `trackflow.dead`.*

---

## Format koperty (Envelope)

Wszystkie eventy przesyłane przez broker są opakowane w standardową kopertę zawierającą metadane przydatne do routingu, wersjonowania oraz weryfikacji idempotencji.

```json
{
  "event_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "event_type": "click.recorded",
  "version": "1.0",
  "timestamp": "2026-05-25T12:00:00.000Z",
  "payload": {}
}
```

---

## 1. EVENT: click.recorded

- **Publisher**: API Server (asynchronicznie po wysłaniu odpowiedzi HTTP 302 w `/:short_code`)
- **Consumer**: Worker Service
- **Routing Key**: `click.recorded`
- **Gwarancja**: at-least-once
- **Idempotentność**: Odbiorca musi sprawdzić, czy `event_id` nie został już zapisany w bazie danych przed wykonaniem zapisu.

**Payload**:
```json
{
  "link_id": "e9cb2026-c2cf-4bc6-8d19-ee7c74070a7b",
  "short_code": "xK9mP",
  "clicked_at": "2026-05-25T12:00:00.000Z",
  "ip_address": "89.64.12.34",
  "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
  "referrer": "https://instagram.com/"
}
```

**Kroki consumera**:
```
1. Sprawdź, czy event_id (z koperty) istnieje w kolumnie event_id tabeli `clicks` (idempotency check)
   --> TAK: wyślij manualne ACK i zakończ przetwarzanie (duplikat).
   --> NIE: kontynuuj przetwarzanie.
2. Parsuj nagłówek user_agent za pomocą biblioteki `ua-parser-js` w celu określenia:
   - device_type (CHECK: 'mobile' | 'desktop' | 'tablet', fallback: 'desktop')
   - browser (np. 'Safari')
   - os (np. 'iOS')
3. Określ geolokalizację na podstawie ip_address za pomocą lokalnej bazy `geoip-lite`:
   - country (np. 'PL')
   - city (np. 'Warsaw')
   - Przy braku dopasowania lub błędzie: ustaw pola na null (nie przerywaj zapisu).
4. Zanonimizuj adres ip_address poprzez wygenerowanie skrótu SHA-256 (ip_hash), aby zachować zgodność z RODO.
5. Zapisz nowy rekord w tabeli `clicks` (PostgreSQL) z przypisanym link_id, event_id i sparsowanymi metadanymi.
6. Wyślij manualne ACK (potwierdzenie) do RabbitMQ.

W przypadku błędu zapisu do PostgreSQL (np. timeout DB):
--> Nie wysyłaj ACK (wyślij NACK lub pozwól na automatyczne ponowienie przez broker).
```

**Retry**: Maksymalnie 3 próby ponowienia zapisu. Interwały opóźnień (backoff): 1s → 5s → 30s. Po 3 nieudanych próbach wiadomość trafia do DLQ (`trackflow.dead-letter`).

---

## 2. EVENT: report.requested

- **Publisher**: API Server (asynchronicznie po otrzymaniu żądania w `POST /api/reports`) lub zadanie Cron (`weekly-report`)
- **Consumer**: Worker Service
- **Routing Key**: `report.requested`

**Payload**:
```json
{
  "report_id": "ac6a3d93-3ea7-4f6c-b4be-5ff6fbbf05ab",
  "requested_by": "7a26fcd1-59ff-4e94-94b2-c0e816a1b241",
  "date_from": "2026-05-18T00:00:00.000Z",
  "date_to": "2026-05-24T23:59:59.000Z",
  "client_id": "8f8f2b73-04d8-4c8d-8fe5-f9f6e729ea89",
  "link_id": null,
  "recipient_email": "client@test.com"
}
```
*(Uwaga: pole `recipient_email` jest opcjonalne — jeśli jest podane, po wygenerowaniu raportu system wyśle go automatycznie e-mailem).*

**Kroki consumera**:
```
1. Zaktualizuj status w tabeli `reports` dla danego report_id na 'processing'.
2. Pobierz z PostgreSQL zagregowane statystyki kliknięć dla zadanego okresu (date_from - date_to), przefiltrowane opcjonalnie po client_id lub link_id:
   - Łączna i unikalna liczba kliknięć
   - Kliknięcia w czasie (wykres)
   - Statystyki po krajach, urządzeniach, referrerach
3. Wygeneruj dynamiczny plik HTML z wyrenderowanymi statystykami i wykresami (np. za pomocą szablonu EJS/Handlebars).
4. Uruchom bibliotekę `Puppeteer` w celu wyrenderowania kodu HTML i wyeksportowania go do pliku PDF.
5. Zapisz plik PDF na współdzielonym wolumenie w ścieżce `/app/storage/reports/report_{report_id}.pdf`.
6. Zaktualizuj status rekordu w tabeli `reports`:
   - Ustaw status = 'done', completed_at = NOW(), file_path = '/app/storage/reports/report_{report_id}.pdf'.
7. Jeśli w payloudzie podano `recipient_email`, opublikuj event `notification.send` do kolejki powiadomień w celu wysyłki raportu e-mailem.
8. Wyślij ACK do RabbitMQ.

W przypadku dowolnego błędu podczas generowania (np. błąd zapisu pliku):
--> Ustaw status = 'failed', completed_at = NOW(), error_message = "Opis błędu".
--> Wyślij ACK (nie chcemy nieskończenie ponawiać uszkodzonego raportu, który wygenerował błąd logiczny).
```

---

## 3. EVENT: notification.send

- **Publisher**: Worker Service (po ukończeniu generowania raportu lub wykryciu alertu)
- **Consumer**: Worker Service (dedykowana kolejka `trackflow.notifications`)
- **Routing Key**: `notification.send`

**Payload**:
```json
{
  "type": "report_ready | alert_no_clicks | weekly_report",
  "recipient_email": "client@test.com",
  "subject": "Twój raport tygodniowy TrackFlow",
  "template_data": {
    "user_name": "Jan Kowalski",
    "link_code": "xK9mP",
    "campaign_name": "Summer Promotion",
    "download_url": "http://localhost:3000/api/reports/ac6a3d93-3ea7-4f6c-b4be-5ff6fbbf05ab/download",
    "period_start": "2026-05-18",
    "period_end": "2026-05-24",
    "file_path": "/app/storage/reports/report_ac6a3d93-3ea7-4f6c-b4be-5ff6fbbf05ab.pdf"
  }
}
```

**Kroki consumera**:
```
1. Wybierz odpowiedni szablon wiadomości e-mail w oparciu o pole `type` i uzupełnij go danymi z `template_data`.
2. Przygotuj załącznik (attachment), jeśli `type` to 'weekly_report' i w `template_data.file_path` podano lokalizację pliku.
3. Wyślij wiadomość za pomocą biblioteki `nodemailer` przez serwer SMTP (w środowisku dev Mailhog, w prod zewnętrzny provider).
4. Wyślij ACK do RabbitMQ.
```

---

## Zadania cykliczne (Cron w Workerze)

Zadania cron są uruchamiane przez wbudowany harmonogram w procesie Workera. Nie generują one bezpośredniego ruchu HTTP, lecz komunikują się poprzez publikację eventów do kolejki.

### 1. Zadanie: `weekly-report`

- **Harmonogram**: `0 8 * * 1` (Każdy poniedziałek o godzinie 8:00 rano)
- **Maksymalne opóźnienie**: 15 minut (biznesowo krytyczne)

**Kroki wykonania**:
```
1. Pobierz z PostgreSQL listę wszystkich użytkowników z rolą `client` (klienci agencji), którzy posiadają przynajmniej jeden przypisany, aktywny link skrócony.
2. Dla każdego klienta:
   - Utwórz unikalny identyfikator raportu (report_id - UUID).
   - Zapisz rekord w tabeli `reports` ze statusem 'pending', typem 'weekly_report' i zakresem dat z ostatniego pełnego tygodnia (od poniedziałku 00:00:00 do niedzieli 23:59:59).
   - Opublikuj event `report.requested` do exchange `trackflow.events` z odpowiednim report_id, zakresem dat, przypisanym client_id oraz uzupełnionym polem `recipient_email` (adres e-mail klienta).
```

### 2. Zadanie: `alert-no-clicks`

- **Harmonogram**: `*/15 * * * *` (Co 15 minut)

**Kroki wykonania**:
```
1. Pobierz z bazy danych PostgreSQL listę wszystkich aktywnych, niewygasłych i nieusuniętych linków (links.deleted_at IS NULL oraz links.expires_at > NOW()).
2. Dla każdego linku sprawdź datę ostatniego zapisanego kliknięcia w tabeli `clicks`:
   - Jeśli ostatnie kliknięcie miało miejsce > 24 godziny temu (lub link nie ma żadnych kliknięć, a został utworzony ponad 24 godziny temu): link kwalifikuje się do alertu.
3. Zastosuj mechanizm deduplikacji w Redis:
   - Sprawdź obecność klucza `alert_sent:{link_id}` w Redis.
   - JEŚLI KLUCZ ISTNIEJE: zignoruj (alert został już wysłany w ciągu ostatnich 24 godzin, nie chcemy spamować marketera).
   - JEŚLI KLUCZ NIE ISTNIEJE:
     a) Zapisz klucz `alert_sent:{link_id}` w Redis o wartości `true` z czasem wygasania TTL = 86400 sekund (24 godziny).
     b) Pobierz dane twórcy linku (`links.created_by` -> pobierz email marketera).
     c) Opublikuj event `notification.send` z typem 'alert_no_clicks', adresem e-mail marketera jako odbiorcą oraz danymi identyfikacyjnymi linku w `template_data`.
```

---

## Dead-letter queue (DLQ)

- **Kolejka monitorująca**: `trackflow.dead-letter`
- **Rola**: Przechowywanie komunikatów, których przetwarzanie zakończyło się błędem (np. 3-krotne odrzucenie zapisu kliknięcia z powodu przejściowej awarii bazy danych lub błędny format nagłówka w UA).
- **Zasady monitorowania**:
  - Panel zarządzania RabbitMQ Management udostępnia widok na stan kolejki DLQ.
  - Wszelkie przyrosty komunikatów w `trackflow.dead-letter` powinny generować alerty systemowe dla zespołu deweloperskiego.
- **Ponowne przetwarzanie (Reprocessing)**:
  - Wiadomości w DLQ zachowują oryginalne nagłówki (`x-death`), w tym informację o pierwotnej kolejce i przyczynie błędu.
  - Po usunięciu usterki w systemie, administrator może dokonać manualnego "przekierowania" (shoveling/replay) komunikatów z DLQ z powrotem do kolejki wejściowej (`trackflow.clicks` lub `trackflow.reports`), co gwarantuje zerową utratę danych biznesowych.
