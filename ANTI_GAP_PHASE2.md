# Anti-Gap Phase 2

**Branch:** `feature/anti-gap-p2`  
Builds on Phase 1. **`index.js` still untouched.**

## What it adds

| Feature | Detail |
|---------|--------|
| Multi-model router | Ordered fallbacks across Workers AI models |
| KV cache | Cache chat answers (~5 min default, configurable) |
| Budget gate | Soft warn / hard block via `tenant_budgets` |
| Model policies | Per-tenant primary/fallback in KV |

## Routes

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/v1/ai/chat` | ai (or public) | Enhanced path (default on this branch) |
| GET | `/v1/policies/models` | read | Current policy |
| POST | `/v1/policies/models` | admin | Save policy to KV |

### Force original core chat

```http
X-Aston-Core-Only: 1
```

### Disable Phase 2 only

```
ANTI_GAP_P2=false
```

### Disable all anti-gap

```
ANTI_GAP=false
```

## Chat body (compatible)

```json
{
  "prompt": "Hola",
  "model": "@cf/meta/llama-3.1-8b-instruct",
  "system": "optional",
  "max_tokens": 1024,
  "prefer_cheap": true,
  "cache": true
}
```

Also accepts `message` instead of `prompt`.

## Policy body

```json
{
  "primary": "@cf/meta/llama-3.1-8b-instruct",
  "fallback": ["@cf/meta/llama-3.1-8b-instruct-fp8"],
  "prefer_cheap": true,
  "max_cost_weight": 2,
  "cache_ttl_sec": 300
}
```

## Response extras (non-breaking)

Core fields preserved: `ok`, `model`, `result`.  
Added: `text`, `cached`, `attempts`, `anti_gap`, `latency_ms`.

## Deploy

```bash
git checkout feature/anti-gap-p2
npx wrangler deploy
```
