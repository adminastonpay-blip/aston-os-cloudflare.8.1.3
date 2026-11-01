# Phase 3 — Security (OLS / ACL / Markings)

**Branch:** `phase-3-security`  
**Version:** 11.6.0

## Capabilities

| Feature | Endpoint |
|---------|----------|
| Status | `GET /v1/security/status` |
| Whoami + clearance | `GET /v1/security/whoami` |
| Object ACL grant/list | `GET\|POST /v1/security/acl` |
| Data markings | `GET\|POST /v1/security/markings` |
| Access check | `POST /v1/security/access/check` |
| ALS redact preview | `POST /v1/security/als/preview` |

## Markings (rank)

PUBLIC(0) < INTERNAL(10) < CONFIDENTIAL(20) < RESTRICTED(30) < SECRET(40)

## Role clearance

| Role | Clearance |
|------|-----------|
| viewer | 10 |
| operator | 20 |
| compliance | 30 |
| admin | 40 |

Downscope API token for tests: `X-Aston-Role: viewer`

## ACL semantics

- No ACL rows → allowed within tenant if clearance ≥ marking
- ACL rows present → principal (`actor`, `role:operator`, or `*`) must have the permission bit
- Admin always allowed

## Smoke

```bash
# Mark entity as SECRET
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "Content-Type: application/json" \
  -d '{"resource_kind":"entity","resource_id":"ent_xxx","marking":"SECRET"}' \
  $BASE/v1/security/markings

# Viewer should fail clearance
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "X-Aston-Role: viewer" -H "Content-Type: application/json" \
  -d '{"resource_kind":"entity","resource_id":"ent_xxx","permission":"read"}' \
  $BASE/v1/security/access/check

# Grant read to operator
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "Content-Type: application/json" \
  -d '{"resource_id":"ent_xxx","principal":"role:operator","can_read":true}' \
  $BASE/v1/security/acl
```

## Gaps vs Palantir

- Markings not yet auto-applied on every ontology list response (use access/check + client filter; server-side filter can be Phase 3.1)
- No mandatory access groups / CBAC full model
- OIDC JWKS fetch still config-oriented (HS256 path works today)
