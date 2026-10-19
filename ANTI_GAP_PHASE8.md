# Anti-Gap Phase 8 — SecOps Fabric

**Branch:** `feature/anti-gap-p8`  
`index.js` untouched.

## Routes

| Method | Path | Auth |
|--------|------|------|
| POST | `/v1/secops/events` | write |
| GET | `/v1/secops/events` | read |
| GET/POST | `/v1/secops/playbooks` | read / admin |
| GET | `/v1/secops/audit` | read |

## Sources

`generic` | `cloudflare_waf` | `crowdstrike` | `okta`

## Deploy

```bash
git checkout feature/anti-gap-p8
npx wrangler deploy
```
