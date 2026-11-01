# Phase 3.1 — Enforce ACL on ontology reads

**Branch:** `phase-3-1-enforce-acl`  
**Version:** 11.6.1

## What changed

Ontology list / get / graph / neighbors / path now:

1. Call `checkObjectAccess` (marking clearance + optional ACL rows)
2. Redact sensitive props via ALS (`DEFAULT_ALS` by role)
3. Return `acl_enforced: true` and `denied_count` where relevant
4. Single entity denied → **403** (not 404) so clients can distinguish

Helpers: `secure_read.js` (`filterEntitiesByAcl`, `gateEntityRead`, `gateEntityWrite`)

## Still open

- Foundry object snapshot search can reuse the same helpers (next micro-step)
- Bulk list performance: over-fetches 2× limit then filters (OK for edge tenants)

## Test

```bash
# Mark secret + downscope role
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "Content-Type: application/json" \
  -d '{"resource_id":"ent_xxx","marking":"SECRET"}' $BASE/v1/security/markings

curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" -H "X-Aston-Role: viewer" \
  $BASE/v1/ontology/entities/ent_xxx
# expect 403
```
