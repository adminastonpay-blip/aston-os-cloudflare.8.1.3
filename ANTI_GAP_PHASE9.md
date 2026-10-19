# Anti-Gap Phase 9 — Compliance Fabric

**Branch:** `feature/anti-gap-p9`  
`index.js` untouched.

## Routes

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/compliance/packs` | read |
| GET/POST | `/v1/compliance/policy` | read / admin |
| POST/GET | `/v1/compliance/evidence` | admin / read |
| POST/GET | `/v1/compliance/dsar` | admin / read |
| POST | `/v1/compliance/dsar/:id/complete` | admin |

## Packs

`gdpr` | `hipaa` | `ai_act` | `soc2`

## Deploy

```bash
git checkout feature/anti-gap-p9
npx wrangler deploy
```
