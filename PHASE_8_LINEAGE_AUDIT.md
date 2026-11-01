# Phase 8 — Lineage & Audit Export

**Branch:** `phase-8-lineage-audit`  
**Version:** 12.1.0

## Purpose

Palantir-style decision provenance: one timeline across Truth Receipts, entity history, AIP plans, pipeline runs, and security audit.

## API

```bash
GET  /v1/lineage/status
GET  /v1/lineage/subject/:id
GET  /v1/lineage/entity/:id
POST /v1/lineage/record

POST /v1/audit/export
GET  /v1/audit/packages
GET  /v1/audit/packages/:id
```

### Export example

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "Content-Type: application/json" \
  -d '{"since_hours":24,"include_metrics":true}' \
  $BASE/v1/audit/export
```

Stores package in D1; optional R2 key `audit/{tenant}/{id}.json`.
