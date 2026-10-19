# ASTON OS 9.0.0 — Audit readiness

**Brand:** ASTON OS only (not Lane Aston / laneaston).
**Runtime:** Cloudflare Workers
**Entry:** `index.js`

## Deploy safety

- No `[[vectorize]]` binding until the index exists (avoids API error 10159).
- No queue producer until the queue is created.
- Durable Object classes exported: `AstonSession`, `AstonRateLimiter`, `AstonLedgerLock`, `AstonAgent`, `AstonVoiceSession`.
- Worker name in `wrangler.toml`: `aston-os-cloudflare-8-1-3` (must match CI if connected).

## Four pillars (self-check)

| Pillar | Evidence in product |
|--------|---------------------|
| Infrastructure | Workers, D1, R2, KV, DO, AI, optional Vectorize/Queue |
| Data & intelligence | Chat, image, video, voice, keyword search, semantic when bound |
| Platform services | Plugins, multi-sector records, academy, agent, media |
| Security & trust | Bearer auth, audit log, rate limiter DO, security headers, PUBLIC_CHAT off by default |

## Endpoints for auditors

| Method | Path | Notes |
|--------|------|-------|
| GET | `/` or `/health` | Version, capabilities, plugins, `audit.ready`, `deploy_safe` |
| GET | `/v1/capabilities` | Client skill spectrum + pillar status |
| GET | `/v1/plugins` | Plugin activation map |
| POST | `/v1/diagnostics/storage` | Auth required; optional Vectorize does not fail core |

## Security controls

- JSON responses: `x-content-type-options`, `x-frame-options`, `referrer-policy`, `x-aston-os`.
- Request body size guard (~1 MB) on JSON parse.
- Optional Durable Object rate limit on AI chat/image when `ASTON_RATE_LIMITER` is bound.
- Secrets via `wrangler secret` only — never commit tokens.
- Do not put API tokens in Shopify theme liquid in production; use a server-side proxy.

## Client skill spectrum

`ai.chat`, `ai.image`, `ai.video`, `voice.*`, `agent.run`, `search.*`, `data.records`, `data.ledger`, `academy`, `jobs` — see `GET /v1/capabilities`.

## Sectors (records)

primary, industry, infrastructure, fintech, govtech, health, mobility, media, commerce, education, agriculture, logistics, telecom, energy, legal, security, entertainment.

## Post-deploy smoke

```bash
curl -s https://<worker>/ | jq .version,.service,.audit
curl -s https://<worker>/v1/capabilities | jq .pillars,.skills_for_clients
```

Expected: `version` = `9.0.0`, `service` = `ASTON OS`, `audit.ready` = true.
