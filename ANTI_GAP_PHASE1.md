# Anti-Gap Phase 1 (non-breaking)

**Branch:** `feature/anti-gap-p1` (use this one)

`index.js` is **not modified**. A thin `entry.js` wraps the existing worker.

## How it stays safe

- `main` branch unchanged
- All previous routes still handled by original `index.js`
- New routes only under `/v1/roi/*`
- Health responses gain `anti_gap` field via wrapper
- Disable anytime: set var `ANTI_GAP=false`

## Deploy

```bash
git checkout feature/anti-gap-p1
npx wrangler deploy
# optional schema
npx wrangler d1 execute aston-omni-primary --remote --file=schema.sql
```

`wrangler.toml` points `main = "entry.js"`.

## New routes

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/roi/summary?days=30` | read |
| GET | `/v1/roi/by-route` | read |
| GET | `/v1/roi/budget` | read |
| POST | `/v1/roi/event` | write |
| POST | `/v1/roi/init` | admin |

## Health

`GET /health?deep=1` probes D1/KV/R2 and reports circuit breakers.

## Note

Ignore branch `feature/anti-gap-phase1` (experimental; do not deploy).
