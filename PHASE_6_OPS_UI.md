# Phase 6 — Ops UI + tenant rate limits

**Branch:** `phase-6-ops-ui`  
**Version:** 11.9.0

## Rate limit

- Default: **120 req/min/tenant** (`RATE_LIMIT_PER_MINUTE` env)
- Order: **KV** → **Durable Object** `ASTON_RATE_LIMITER` → passthrough (dev)
- Applied to authenticated API surface (ontology, foundry, aip, pipelines, …)
- Status: `GET /v1/ops/rate-limit` (Bearer + X-Tenant)

429 body:

```json
{ "ok": false, "error": "rate_limited", "limit": 120, "retry_after": 60 }
```

## Command UI

`GET /ui` — ops hub cards linking ontology, foundry, AIP, security, pipelines, studio.

Studio: `/ui/studio` (existing).

## Config

| Binding / var | Role |
|---------------|------|
| `ASTON_KV` | Preferred counter |
| `ASTON_RATE_LIMITER` | DO fallback |
| `RATE_LIMIT_PER_MINUTE` | Override limit |
