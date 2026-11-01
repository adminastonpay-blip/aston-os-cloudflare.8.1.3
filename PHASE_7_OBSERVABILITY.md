# Phase 7 — Observability

**Branch:** `phase-7-observability`  
**Version:** 12.0.0

## What

- Per-request metrics (path, status, latency ms, actor)
- Hourly rollups by path group
- KV last-request pulse
- Response header `x-aston-ms`

## API

```bash
GET /v1/metrics/summary   # 24h totals + by_group
GET /v1/metrics/hourly?hours=24
GET /v1/metrics/recent?limit=30
GET /v1/metrics/groups
```

Auth: Bearer + X-Tenant.

## Groups

ontology · foundry · aip · orchestrator · pipelines · security · cases · receipts · ops · ui · health · other

## Notes

- Recording uses `ctx.waitUntil` when available so latency impact is minimal
- Tables: `metrics_events`, `metrics_hourly`
