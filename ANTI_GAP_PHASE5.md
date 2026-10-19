# Anti-Gap Phase 5

**Branch:** `feature/anti-gap-p5`  
Tool calling + agent loop. `index.js` untouched.

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/ai/tools` | read | List tools + allowlist |
| POST | `/v1/ai/tools` | admin | Save custom tool metadata + hosts |
| POST | `/v1/ai/tools/invoke` | ai | Run one tool without LLM |
| POST | `/v1/ai/agent` | ai | Multi-step agent with tools |

## Built-in tools

- `echo`, `now_iso`, `http_get` (HTTPS allowlist), `kv_get`/`kv_put`, `roi_summary`

## Agent example

```bash
curl -X POST https://WORKER/v1/ai/agent \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What time is it UTC and summarize my ROI for 7 days?","max_steps":4}'
```

## Deploy

```bash
git checkout feature/anti-gap-p5
npx wrangler deploy
```
