# Phase 5 — Foundry OLS enforce

**Branch:** `phase-5-foundry-acl`  
**Version:** 11.8.0

## What

Same server-side ACL + markings + ALS as ontology, applied to Foundry surface:

| Route | Behavior |
|-------|----------|
| `GET /v1/foundry/search` | Filter entities by clearance/ACL |
| `GET /v1/foundry/objects/:id` | 403 if denied; ALS redact props |
| `GET /v1/foundry/objects/:id/history` | Requires read access |
| `POST /v1/foundry/objects/:id` | Requires write ACL |
| `POST .../actions/:action` | Requires action ACL |

Uses `secure_read.js` helpers shared with Phase 3.1.
