# Anti-Gap Phase 11 — Compute Fabric

**Branch:** `feature/anti-gap-p11`  
Edge-first, USD budgets, kill switch. `index.js` untouched.

## Routes

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/compute/tiers` | read |
| GET/POST | `/v1/compute/policy` | read / admin |
| GET/POST | `/v1/compute/cost` | read / write |
| POST | `/v1/compute/route` | ai/write |

## Tiers

`edge` (default) | `byok` | `heavy` (opt-in) | `blocked`

## Deploy

```bash
git checkout feature/anti-gap-p11
npx wrangler deploy
```
