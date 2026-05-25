# Kontrakt REST API — TrackFlow

> ✅ Ten dokument definiuje pełny kontrakt REST API dla systemu TrackFlow v1.0. Agent implementuje serwer API Fastify oraz interfejs frontendowy dokładnie według poniższych specyfikacji.

---

## Konwencje ogólne

```
Autentykacja:  Nagłówek HTTP: "Authorization: Bearer <JWT_TOKEN>" (nie dotyczy logowania i redirectu)
Format danych: JSON (zarówno dla Request, jak i Response)
Błędy:         Zwracane z odpowiednim kodem statusu HTTP (4xx/5xx) w formacie:
               { "code": "ERROR_CODE", "message": "Opis błędu dla dewelopera" }
Paginacja:     Stosowana przy listach za pomocą parametrów query `page` oraz `limit`:
               GET /api/zasob?page=1&limit=20
               Zwraca format koperty:
               { "data": [...], "total": N, "page": N, "limit": N }
```

---

## AUTH

### 1. POST /auth/login

*Logowanie marketerów oraz klientów agencji.*

- **Auth**: Brak (publiczny)
- **Request**:
  ```json
  {
    "email": "marketer@test.com",
    "password": "super_secret_password"
  }
  ```
- **Response 200 OK**:
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsIn...",
    "user": {
      "id": "7a26fcd1-59ff-4e94-94b2-c0e816a1b241",
      "email": "marketer@test.com",
      "role": "marketer"
    }
  }
  ```
- **Response 400 Bad Request**: `{ "code": "VALIDATION_ERROR", "message": "E-mail and password are required." }`
- **Response 401 Unauthorized**: `{ "code": "INVALID_CREDENTIALS", "message": "Invalid e-mail or password." }`

### 2. POST /auth/change-password

*Zmiana hasła zalogowanego użytkownika.*

- **Auth**: Wymagana (Marketer lub Client)
- **Request**:
  ```json
  {
    "old_password": "super_secret_password",
    "new_password": "new_awesome_password"
  }
  ```
- **Response 204 No Content**: Brak body.
- **Response 400 Bad Request**: `{ "code": "VALIDATION_ERROR", "message": "Password criteria not met." }`
- **Response 401 Unauthorized**: `{ "code": "UNAUTHORIZED", "message": "Invalid old password." }`

---

## REDIRECT

### 3. GET /:short_code

*Krytyczny endpoint skracania linku przekierowujący na adres oryginalny. Musi odpowiedzieć w czasie < 80ms (docelowo ~15ms z cache).*
*W tle, asynchronicznie, wysyła event click.recorded do brokera RabbitMQ.*

- **Auth**: Brak (publiczny)
- **Response 302 Found**:
  - Nagłówek `Location`: `<original_url>`
  - Brak body (lub standardowe przekierowanie HTML jako fallback)
- **Response 404 Not Found**: `{ "code": "LINK_NOT_FOUND", "message": "Link does not exist or has expired." }`

---

## LINKS

### 4. GET /api/links

*Pobieranie listy skróconych linków z paginacją i filtrami.*

- **Auth**: Wymagana (Marketer lub Client).
  - *Marketer* widzi wszystkie linki lub może filtrować po klientach.
  - *Client* widzi wyłącznie linki przypisane do jego `client_id` (automatycznie filtrowane po jego ID z tokenu).
- **Query params (opcjonalne)**:
  - `page`: Numer strony (domyślnie `1`)
  - `limit`: Ilość rekordów (domyślnie `20`, max `100`)
  - `campaign_name`: Filtrowanie po nazwie kampanii (dokładne lub fragment)
  - `client_id`: Filtrowanie po ID klienta (dostępne tylko dla roli `marketer`)
  - `search`: Wyszukiwanie frazy w `original_url` lub `short_code`
- **Response 200 OK**:
  ```json
  {
    "data": [
      {
        "id": "e9cb2026-c2cf-4bc6-8d19-ee7c74070a7b",
        "short_code": "xK9mP",
        "original_url": "https://example.com/long-marketing-url-2026",
        "campaign_name": "Summer Sale",
        "client_id": "8f8f2b73-04d8-4c8d-8fe5-f9f6e729ea89",
        "expires_at": "2027-05-25T12:00:00.000Z",
        "created_by": "7a26fcd1-59ff-4e94-94b2-c0e816a1b241",
        "created_at": "2026-05-25T12:00:00.000Z",
        "updated_at": "2026-05-25T12:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 20
  }
  ```

### 5. POST /api/links

*Tworzenie nowego skróconego linku.*

- **Auth**: Wymagana (tylko Marketer)
- **Request**:
  ```json
  {
    "original_url": "https://example.com/long-marketing-url-2026",
    "campaign_name": "Summer Sale",
    "client_id": "8f8f2b73-04d8-4c8d-8fe5-f9f6e729ea89",
    "expires_at": "2027-05-25T12:00:00.000Z"
  }
  ```
  *Uwaga: Wartość `expires_at` nie może być ustawiona na więcej niż 365 dni od daty bieżącej.*
- **Response 201 Created**:
  ```json
  {
    "id": "e9cb2026-c2cf-4bc6-8d19-ee7c74070a7b",
    "short_code": "xK9mP",
    "original_url": "https://example.com/long-marketing-url-2026",
    "campaign_name": "Summer Sale",
    "client_id": "8f8f2b73-04d8-4c8d-8fe5-f9f6e729ea89",
    "expires_at": "2027-05-25T12:00:00.000Z",
    "created_by": "7a26fcd1-59ff-4e94-94b2-c0e816a1b241",
    "created_at": "2026-05-25T12:00:00.000Z",
    "updated_at": "2026-05-25T12:00:00.000Z"
  }
  ```
- **Response 400 Bad Request**:
  - Gdy URL jest niepoprawny: `{ "code": "INVALID_URL", "message": "Provided string is not a valid HTTP/HTTPS URL." }`
  - Gdy okres wygaśnięcia przekracza 365 dni: `{ "code": "EXPIRY_LIMIT_EXCEEDED", "message": "Expiration date cannot exceed 365 days from now." }`
  - Błędy walidacji pól obowiązkowych.

### 6. GET /api/links/:id

*Pobieranie szczegółów konkretnego linku.*

- **Auth**: Wymagana (Marketer lub Client).
  - *Client* otrzyma błąd 404/403, jeśli link nie jest przypisany do jego `client_id`.
- **Response 200 OK**:
  ```json
  {
    "id": "e9cb2026-c2cf-4bc6-8d19-ee7c74070a7b",
    "short_code": "xK9mP",
    "original_url": "https://example.com/long-marketing-url-2026",
    "campaign_name": "Summer Sale",
    "client_id": "8f8f2b73-04d8-4c8d-8fe5-f9f6e729ea89",
    "expires_at": "2027-05-25T12:00:00.000Z",
    "created_by": "7a26fcd1-59ff-4e94-94b2-c0e816a1b241",
    "created_at": "2026-05-25T12:00:00.000Z",
    "updated_at": "2026-05-25T12:00:00.000Z"
  }
  ```
- **Response 404 Not Found**: `{ "code": "LINK_NOT_FOUND", "message": "Link does not exist or you do not have permission to view it." }`

### 7. DELETE /api/links/:id

*Miękkie usuwanie linku skróconego (Soft Delete).*

- **Auth**: Wymagana (tylko Marketer)
- **Response 204 No Content**: Brak body.
- **Response 404 Not Found**: `{ "code": "LINK_NOT_FOUND", "message": "Link does not exist or has already been deleted." }`

---

## STATYSTYKI

### 8. GET /api/links/:id/stats

*Pobieranie statystyk kliknięć dla konkretnego linku. Agregacja z PostgreSQL w czasie rzeczywistym.*

- **Auth**: Wymagana (Marketer lub Client).
  - *Client* ma dostęp tylko, gdy link należy do jego konta.
- **Query params (opcjonalne)**:
  - `period`: Zakres podziału czasu wykresu: `"hour" | "day" | "week"` (domyślnie `"day"`)
  - `date_from`: Data początkowa (ISO 8601, opcjonalna, np. `2026-05-01T00:00:00Z`)
  - `date_to`: Data końcowa (ISO 8601, opcjonalna, np. `2026-05-25T23:59:59Z`)
- **Response 200 OK**:
  ```json
  {
    "total_clicks": 1234,
    "unique_clicks": 890,
    "clicks_over_time": [
      { "timestamp": "2026-05-20T00:00:00.000Z", "count": 245 },
      { "timestamp": "2026-05-21T00:00:00.000Z", "count": 312 }
    ],
    "by_country": [
      { "country": "PL", "count": 920 },
      { "country": "DE", "count": 180 },
      { "country": "Unknown", "count": 134 }
    ],
    "by_device": [
      { "device_type": "mobile", "count": 780 },
      { "device_type": "desktop", "count": 404 },
      { "device_type": "tablet", "count": 50 }
    ],
    "by_referrer": [
      { "referrer": "instagram.com", "count": 520 },
      { "referrer": "facebook.com", "count": 414 },
      { "referrer": "Direct / Unknown", "count": 300 }
    ]
  }
  ```
- **Response 404 Not Found**: `{ "code": "LINK_NOT_FOUND", "message": "Link not found or no permission." }`

---

## RAPORTY

### 9. POST /api/reports

*Zlecenie asynchronicznego wygenerowania raportu PDF.*
*Zwraca status 202 Accepted natychmiast, proces PDF uruchamia się w tle przez event report.requested.*

- **Auth**: Wymagana (tylko Marketer)
- **Request**:
  ```json
  {
    "date_from": "2026-05-01T00:00:00.000Z",
    "date_to": "2026-05-25T23:59:59.000Z",
    "client_id": "8f8f2b73-04d8-4c8d-8fe5-f9f6e729ea89",
    "link_id": "e9cb2026-c2cf-4bc6-8d19-ee7c74070a7b"
  }
  ```
  *(pola `client_id` oraz `link_id` są opcjonalne. Pozwalają na generowanie raportu zagregowanego dla klienta lub dla pojedynczego linku).*
- **Response 202 Accepted**:
  ```json
  {
    "report_id": "ac6a3d93-3ea7-4f6c-b4be-5ff6fbbf05ab",
    "status": "pending"
  }
  ```
- **Response 400 Bad Request**: Walidacja dat (np. data początkowa późniejsza niż końcowa).

### 10. GET /api/reports/:id

*Pobieranie statusu i linku pobierania zlecenia raportu (odpytywanie przez frontend co 3s).*

- **Auth**: Wymagana (tylko Marketer)
- **Response 200 OK**:
  ```json
  {
    "id": "ac6a3d93-3ea7-4f6c-b4be-5ff6fbbf05ab",
    "status": "pending | processing | done | failed",
    "download_url": "http://localhost:3000/api/reports/ac6a3d93-3ea7-4f6c-b4be-5ff6fbbf05ab/download",
    "error_message": null,
    "created_at": "2026-05-25T14:00:00.000Z",
    "completed_at": "2026-05-25T14:00:08.000Z"
  }
  ```
  *Uwaga: pole `download_url` oraz `completed_at` są `null`, dopóki status != 'done'. Pole `error_message` zawiera tekst tylko przy statusie 'failed'.*
- **Response 404 Not Found**: `{ "code": "REPORT_NOT_FOUND", "message": "Report task does not exist." }`

### 11. GET /api/reports/:id/download

*Pobranie fizycznego pliku PDF raportu.*

- **Auth**: Wymagana (tylko Marketer)
- **Response 200 OK**:
  - Nagłówek HTTP `Content-Type`: `application/pdf`
  - Nagłówek HTTP `Content-Disposition`: `attachment; filename="report_ac6a3d93-3ea7-4f6c-b4be-5ff6fbbf05ab.pdf"`
  - Body: strumień binarny pliku PDF
- **Response 400 Bad Request**: `{ "code": "REPORT_NOT_READY", "message": "Report is still processing or has failed." }`
- **Response 404 Not Found**: `{ "code": "FILE_NOT_FOUND", "message": "The PDF file does not exist on disk." }`

### 12. GET /api/reports

*Pobieranie listy zleconych raportów przez danego marketera z paginacją.*

- **Auth**: Wymagana (tylko Marketer)
- **Response 200 OK**:
  ```json
  {
    "data": [
      {
        "id": "ac6a3d93-3ea7-4f6c-b4be-5ff6fbbf05ab",
        "status": "done",
        "date_from": "2026-05-01T00:00:00.000Z",
        "date_to": "2026-05-25T23:59:59.000Z",
        "created_at": "2026-05-25T14:00:00.000Z",
        "completed_at": "2026-05-25T14:00:08.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 20
  }
  ```

---

## UTILITY / METADATA

### 13. GET /api/clients

*Pobieranie listy klientów agencji (użytkownicy z rolą `client`) do dropdowna przy tworzeniu linków.*

- **Auth**: Wymagana (tylko Marketer)
- **Response 200 OK**:
  ```json
  {
    "data": [
      {
        "id": "8f8f2b73-04d8-4c8d-8fe5-f9f6e729ea89",
        "email": "client@test.com",
        "created_at": "2026-05-25T12:00:00.000Z"
      }
    ]
  }
  ```
