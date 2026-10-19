# Anti-Gap Phase 3

**Branch:** `feature/anti-gap-p3`  
`index.js` untouched. Builds on P1 + P2.

## Features

| Feature | Route | Auth |
|---------|-------|------|
| SLA metrics | `GET /v1/sla?hours=24` | read |
| Global SLA | `GET /v1/sla?global=1` | admin |
| Export tenant | `POST /v1/export/tenant` | admin |
| Download export | `GET /v1/export/download?job_id=` | admin |
| Purge tenant | `DELETE /v1/tenant/data` | admin + confirm |

## Anti lock-in

Export writes **JSONL** to R2 (`exports/{tenant}/{day}/{job_id}.jsonl`) with D1 rows + R2 object listing.

## Purge

```bash
curl -X DELETE "https://WORKER/v1/tenant/data" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"YOUR_TENANT","purge_r2":true}'
```

## Flags

- `ANTI_GAP=false` — all off
- `ANTI_GAP_P3=false` — only Phase 3 off

## Deploy

```bash
git checkout feature/anti-gap-p3
npx wrangler deploy
```
