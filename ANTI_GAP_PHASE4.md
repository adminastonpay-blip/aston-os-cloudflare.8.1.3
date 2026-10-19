# Anti-Gap Phase 4

**Branch:** `feature/anti-gap-p4`  
`index.js` untouched. Stack: P1 + P2 + P3 + P4.

## Features

| Feature | Route | Auth |
|---------|-------|------|
| BYOK config | `GET/POST/DELETE /v1/policies/byok` | admin |
| Retention policy | `GET/POST /v1/policies/retention` | read / admin |
| Enforce retention | `POST /v1/compliance/enforce-retention` | admin |
| Observability | `GET /v1/observability` | read |
| Hybrid chat BYOK | `POST /v1/ai/chat` + `X-Aston-Byok: 1` | ai |

## BYOK

```json
POST /v1/policies/byok
{
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-...",
  "model": "gpt-4o-mini",
  "prefer_over_workers": false
}
```

Secrets: `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `OPENAI_MODEL`.
Header: `X-Aston-Byok: 1` or env `BYOK_DEFAULT=true`.

## Deploy

```bash
git checkout feature/anti-gap-p4
npx wrangler deploy
```
