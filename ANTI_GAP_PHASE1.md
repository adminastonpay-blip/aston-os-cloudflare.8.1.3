# Anti-Gap Phase 1 (non-breaking)

Adds ROI metering, deep health probes, and circuit-breaker helpers **without changing existing routes or auth**.

## Branch

`feature/anti-gap-phase1`

## Disable

Set Worker var:

```
ANTI_GAP=false
```

When set, `/v1/roi/*` handlers skip and ROI writes no-op.

## New routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/roi/summary?days=30` | read | Cost/latency/outcome summary |
| GET | `/v1/roi/by-route` | read | Breakdown by route |
| GET | `/v1/roi/budget` | read | Budget status (fail-open if unset) |
| POST | `/v1/roi/event` | write | Manual ROI event |
| POST | `/v1/roi/init` | admin | Ensure ROI tables on D1 |

## Health

`GET /` and `GET /health` include `anti_gap: { phase, version, features }`.

`GET /health?deep=1` runs probes (D1/KV/R2) and reports circuit breaker state.

## Existing behavior

- All previous endpoints unchanged.
- `VERSION` remains `8.12.2` for client compatibility.
- Schema uses `CREATE TABLE IF NOT EXISTS` only.
- AI chat optionally records a ROI event via `waitUntil` when authenticated.

## Deploy

```bash
git checkout feature/anti-gap-phase1
npx wrangler deploy
npx wrangler d1 execute aston-omni-primary --remote --file=schema.sql
```
