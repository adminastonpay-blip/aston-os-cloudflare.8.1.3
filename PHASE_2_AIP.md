# Phase 2 — AIP-lite (Human-in-the-Loop)

**Branch:** `phase-2-aip` (from `phase-1-ontology`)  
**Version:** 11.5.0

## Goal
Approach Palantir AIP style: agents propose, humans approve, then execute with signed Truth Receipts.

## Flow

```
POST /v1/aip/plan          → status: pending_approval
POST /v1/aip/plans/:id/approve  → runs orchestrator (or wait for execute)
POST /v1/aip/plans/:id/reject
POST /v1/aip/plans/:id/execute  → multi-agent + receipt
```

Skip HITL when needed:

```json
POST /v1/aip/plan  { "goal": "...", "require_approval": false }
```

## Also wired (were orphaned)

| Module | Paths |
|--------|--------|
| Orchestrator | `/v1/orchestrator/run`, `/runs`, `/roles` |
| Cases | `/v1/cases`, playbooks |
| Receipts | `/v1/receipts/*` |

## Smoke

```bash
export TOKEN=...
export BASE=https://<worker>

# Propose
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "Content-Type: application/json" \
  -d '{"goal":"Revisar riesgo de proveedores en LatAm","open_case":true}' \
  $BASE/v1/aip/plan

# Approve (use plan_id from response)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  $BASE/v1/aip/plans/<plan_id>/approve

# Direct agent run (no HITL)
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant: demo" \
  -H "Content-Type: application/json" \
  -d '{"goal":"Resumen operativo del tenant"}' \
  $BASE/v1/orchestrator/run
```

## Secrets

- `ASTON_API_TOKEN` — API auth
- `ASTON_RECEIPT_SECRET` (or JWT/API token fallback) — sign Truth Receipts
- Workers AI binding — specialist agents

## Gaps vs Palantir AIP

- No visual Logic board / Workshop
- Simulation sandbox is Decision Twin / swarm, not full ontology clone
- AgentOps traces are step texts, not full prompt/tool graph UI
