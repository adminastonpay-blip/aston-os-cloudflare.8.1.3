# Anti-Gap Phase 7 — Webhooks & Event Bus

**Branch:** `feature/anti-gap-p7`  
`index.js` untouched.

## Routes

| Method | Path | Auth |
|--------|------|------|
| POST | `/v1/webhooks` | admin |
| GET | `/v1/webhooks` | read |
| DELETE | `/v1/webhooks/:id` | admin |
| POST | `/v1/events` | write |
| GET | `/v1/events/deliveries` | read |

## Register

```json
POST /v1/webhooks
{
  "url": "https://example.com/hooks/aston",
  "secret": "optional-hmac-secret",
  "events": ["*", "order.paid"]
}
```

HTTPS only. Header: `X-Aston-Signature: sha256=...`

## Emit

```json
POST /v1/events
{ "type": "order.paid", "data": { "order_id": "123" } }
```

Retries up to 3x; hourly cron retries pending/failed.

## Deploy

```bash
git checkout feature/anti-gap-p7
npx wrangler deploy
```
