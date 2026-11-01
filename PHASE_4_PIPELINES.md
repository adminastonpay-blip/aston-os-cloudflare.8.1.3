# Phase 4 — Security Pipelines

**Branch:** `phase-4-security-pipelines`  
**Version:** 11.7.0

## Idea

Declarative pipelines that chain **data in → classification → ACL → ontology → optional HITL (AIP)**.

## Templates

| ID | Stages |
|----|--------|
| `secure_ingest` | normalize → upsert → mark INTERNAL → receipt |
| `classified_ingest` | + apply_acl |
| `risk_pipeline` | mark RESTRICTED → open AIP plan |
| `zero_copy_http` | fetch_http → … → mark |

## API

```bash
GET  /v1/pipelines/catalog
POST /v1/pipelines/run
POST /v1/pipelines/run/classified_ingest
GET  /v1/pipelines/runs
```

### Example — classified batch

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "Content-Type: application/json" \
  -d '{
    "template_id": "classified_ingest",
    "marking": "CONFIDENTIAL",
    "acl_principals": ["role:compliance", "role:operator"],
    "items": [
      {"type": "supplier", "name": "Acme LatAm", "props": {"country": "AR", "risk": 7}},
      {"type": "person", "name": "ops@acme.com", "props": {"email": "ops@acme.com"}}
    ]
  }' \
  $BASE/v1/pipelines/run
```

### Example — risk + HITL

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "Content-Type: application/json" \
  -d '{
    "template_id": "risk_pipeline",
    "marking": "RESTRICTED",
    "goal": "Revisar proveedores de alto riesgo",
    "items": [{"type": "supplier", "name": "VendorX", "props": {"risk": 9}}]
  }' \
  $BASE/v1/pipelines/run/risk_pipeline
```

## Stages reference

`fetch_http` · `normalize` · `upsert_entities` · `apply_marking` · `apply_acl` · `open_aip_plan` · `receipt`

Custom: pass `"stages": [...]` in the body.
