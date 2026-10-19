# Anti-Gap Phase 10 — Plans, Quotas & Trust

**Branch:** `feature/anti-gap-p10`  
`index.js` untouched.

## Routes

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/trust` | public |
| GET | `/v1/plans` | read |
| GET/POST | `/v1/tenant/plan` | read / admin |
| GET | `/v1/tenant/usage` | read |
| POST | `/v1/tenant/quota/check` | write |

## Plans

`free` | `pro` | `enterprise`

## Deploy

```bash
git checkout feature/anti-gap-p10
npx wrangler deploy
```
