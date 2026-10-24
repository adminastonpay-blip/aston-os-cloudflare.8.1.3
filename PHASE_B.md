# Phase B — Multi-Agent Orchestrator

## Goal
Operational multi-step intelligence: gather context → specialist agents → synthesize answer (Palantir-style workflow, edge-native).

## Roles
| Role | Focus |
|------|--------|
| `analyst` | Data, trends, anomalies |
| `compliance` | Risk, policy, audit |
| `supplier` | Vendor / supply risk |
| `growth` | Commercial actions |
| synthesizer | Executive merge (always last) |

## APIs

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/orchestrator/roles` | read |
| POST | `/v1/orchestrator/run` | ai |
| GET | `/v1/orchestrator/runs` | read |
| GET | `/v1/orchestrator/runs/:id` | read |

### POST body
```json
{
  "goal": "Evaluar riesgo de proveedores y proponer acciones de crecimiento",
  "roles": ["analyst", "supplier", "growth"],
  "max_roles": 3,
  "store_artifact": true
}
```

If `roles` omitted, roles are inferred from the goal text.

## Deploy
```bash
git checkout phase-b-orchestrator
npm run db:init
npx wrangler deploy
```

Requires migration `v5-orchestrator` (DO `AstonOrchestrator`).

## Smoke
```bash
curl -s -H "Authorization: Bearer $TOKEN" "$HOST/v1/orchestrator/roles" | jq .

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$HOST/v1/orchestrator/run" \
  -d '{"goal":"Resumen de riesgos de compliance y proveedores para el tenant"}' | jq .
```

## Artifacts
When R2 is bound, results are stored at `orchestrator/{tenant}/{run_id}.md`.

## Next
Phase C — Cases / playbooks
