# Phase 2 — Universal Data Pipeline & Connector Factory (+10%)

**Version:** 10.7.0  
**Routes:** `/v1/connectors/*`

## Deliverables

### Edge Ingestion Gateways
- `POST /v1/connectors` — register connector (webhook gets unique token URL)
- `POST /v1/connectors/webhook/:token` — dynamic webhook ingress → ontology
- Types: `webhook.generic`, `webhook.shopify`, `csv.upload`, `json.batch`

### Zero-Copy Style Connectors
- `POST /v1/connectors/run/http` — fetch remote JSON, project to ontology
- `POST /v1/connectors/run/r2` — list/get R2 objects → entities
- `POST /v1/connectors/run/d1` — project D1 tables into ontology view

### Factory / Catalog
- `GET /v1/connectors/catalog`
- `GET /v1/connectors/list`
- `POST /v1/connectors/:id/run`
- `GET /v1/connectors/runs`
- D1: `connectors`, `connector_runs`

## Auth
Bearer `ASTON_API_TOKEN` + optional `X-Tenant`. Webhooks use path token only.

## Next
- Salesforce / SAP adapters
- Snowflake / BigQuery via external fetch
- Scheduled sync (cron + sync_schedules)
