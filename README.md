![ubt ship tracking frontend screenshot - redacted](ss_ubtship.png)

# UBTSHIP API Documentation

The UBTSHIP module provides endpoints for saving and retrieving ship data JSON files. Saved files are stored on disk in `rute/ubtship/output/` and indexed into a local SQLite database at `rute/ubtship/ubtship.db` for faster reads.

---

## Directory Structure

```
rute/ubtship/
├── kapal.js       # Express router definition
├── README.md      # API documentation
├── output/        # Storage directory for generated JSON files
└── ubtship.db     # SQLite index for paginated reads
```

---

## Environment Variables

Ensure the following environment variables are set before starting the server:

| Variable | Description |
| --- | --- |
| `UBTSHIP_API_KEY` | Bearer token used to authenticate `POST /ubtship/create-json` requests. |
| `UBTSHIP_BODY_SECRET` | Secret string required in the JSON payload of `POST /ubtship/create-json`. |

---

## Endpoints Summary

| Method | Endpoint | Auth Required | Description |
| --- | --- | --- | --- |
| `POST` | `/ubtship/create-json` | Bearer Token + Body Secret | Create/write a ship JSON file in `output/` and index it in SQLite |
| `GET` | `/ubtship/read-json` | None (Rate Limited) | Paginated listing of indexed JSON files (newest first) |

---

## API Details

### 1. `POST /ubtship/create-json`

Creates or overwrites a `.json` file in the `rute/ubtship/output/` directory and updates the SQLite index.

#### Headers
- `Authorization: Bearer <UBTSHIP_API_KEY>`
- `Content-Type: application/json`

#### Request Body
```json
{
  "fileName": "summary_2026-08-03_12-00_1.json",
  "fileContent": {
    "shipName": "UBTSHIP 01",
    "position": {
      "lat": -6.1751,
      "lng": 106.8650
    },
    "timestamp": "2026-08-03T12:00:00Z"
  },
  "secret": "<UBTSHIP_BODY_SECRET>"
}
```

*Note: `fileContent` can be an Object or a String. `fileName` will automatically be appended with `.json` if not provided.*

#### Responses

- **`200 OK`**
  ```json
  {
    "success": true,
    "indexed": true,
    "filePath": "output/summary_2026-08-03_12-00_1.json"
  }
  ```

- **`400 Bad Request`**
  Returned for a missing/non-object JSON body or an invalid filename. Configure
  `express.json()` in the parent application before mounting this router.
  ```json
  {
    "error": "fileName and fileContent are required"
  }
  ```
  or
  ```json
  {
    "error": "Invalid fileName"
  }
  ```

- **`401 Unauthorized`**
  Missing, invalid, or wrong-length bearer tokens and body secrets are rejected
  without throwing. The body secret must be a string.
  ```json
  {
    "error": "Unauthorized"
  }
  ```

- **`500 Internal Server Error`**
  ```json
  {
    "error": "Server misconfiguration"
  }
  ```
  *(Returned if `UBTSHIP_API_KEY` or `UBTSHIP_BODY_SECRET` is missing in environment variables)*

---

### 2. `GET /ubtship/read-json`

Retrieves a paginated list of indexed JSON files and their parsed content. Files are ordered **newest first** based on filename sorting (descending).

On startup, the route backfills existing files from `output/` into SQLite. The read endpoint also performs a lightweight directory sync before querying so files added outside the API are picked up.

#### Rate Limiting
- **Limit**: Max 5 requests per 1-minute window per client IP resolved by Express
  (`req.ip`, with the connection address as a fallback). Unverified `x-api-key`
  and raw `x-forwarded-for` headers are never used directly as quota keys.
- **Response Headers**:
  - `X-RateLimit-Limit`: Maximum requests per window (5)
  - `X-RateLimit-Remaining`: Remaining request count
  - `X-RateLimit-Reset`: Unix timestamp when rate limit resets
  - `Retry-After`: Whole seconds until another request is allowed (429 responses only)

The parent application's `trust proxy` configuration must match the deployment.
Leave the Express default (`false`) for direct connections. Behind a reverse
proxy, trust only its actual addresses/subnets and ensure the proxy overwrites
forwarded headers. Do not enable blanket `trust proxy: true` for arbitrary
clients. See the [Express proxy guide](https://expressjs.com/en/guide/behind-proxies.html).

This limiter uses process-local memory and tracks individual IP addresses.
Workers/replicas do not share quotas, restarts reset them, and clients sharing an
IP share a quota. Use an edge limiter or a shared rate-limit store for a global
quota across multiple instances; consider IPv6 subnet grouping where needed.

#### Query Parameters

| Parameter | Type | Default | Min | Max | Description |
| --- | --- | --- | --- | --- | --- |
| `page` | integer | `1` | `1` | - | Page number to retrieve |
| `limit` | integer | `20` | `1` | `500` | Number of items per page |

#### Request Example
```http
GET /ubtship/read-json?page=1&limit=20 HTTP/1.1
Host: localhost:3000
```

#### Response (`200 OK`)
```json
{
  "page": 1,
  "limit": 20,
  "totalFiles": 180,
  "totalPages": 9,
  "items": [
    {
      "fileName": "summary_2026-07-27_19-05_1.json",
      "content": {
        "shipName": "UBTSHIP 01",
        "position": {
          "lat": -6.1751,
          "lng": 106.8650
        }
      },
      "parseError": null
    }
  ]
}
```

#### Rate Limit Exceeded (`429 Too Many Requests`)
```json
{
  "error": "Too many requests (max 5 per minute)"
}
```

---

## Code Examples

### cURL

#### Create JSON
```bash
curl -X POST "http://localhost:3000/ubtship/create-json" \
  -H "Authorization: Bearer YOUR_UBTSHIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "summary_2026-08-03_12-00_1.json",
    "fileContent": { "status": "active" },
    "secret": "YOUR_UBTSHIP_BODY_SECRET"
  }'
```

#### Read JSON (Page 1, 20 items per page)
```bash
curl -X GET "http://localhost:3000/ubtship/read-json?page=1&limit=20"
```

## Security regression tests

Run with Node.js 18 or later; the regression suite requires no extra packages:

```bash
node --test test/api-robustness.test.cjs
```

The suite executes this router's actual registered handlers with mocked storage
and framework registration. It checks authentication, malformed bodies and
filenames, quota bypass attempts, reset boundaries, and retry headers. It does
not start a live service or validate the deployment's proxy configuration.
