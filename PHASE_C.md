# Phase C — Cases & Playbooks

Operational cases (Palantir-style missions) with status machine and playbooks.

## Statuses
`open` → `investigating` → `pending_approval` → `acting` → `resolved` → `closed`  
Also: `cancelled`

## Playbooks
| ID | Use |
|----|-----|
| `store_audit` | Live store / channel audit |
| `supplier_risk` | Supplier risk review |
| `ledger_anomaly` | Ledger outliers |
| `ontology_alert` | Graph / entity alert |

## APIs

| Method | Path |
|--------|------|
| GET | `/v1/cases/playbooks` |
| POST | `/v1/cases/playbooks/:id/run` |
| GET | `/v1/cases` |
| GET | `/v1/cases/:id` |
| POST | `/v1/cases` |
| POST | `/v1/cases/:id/transition` |
| POST | `/v1/cases/:id/events` |

### Create + auto orchestrator
```json
{
  "title": "Riesgo proveedor Acme",
  "playbook": "supplier_risk",
  "priority": "high",
  "run_orchestrator": true,
  "ontology_ids": [],
  "goal": "Evaluar riesgo del proveedor Acme"
}
```

### Transition
```json
{ "status": "resolved", "result": "Mitigated", "note": "OK" }
```

## Webhooks
Fires `case.created` and `case.status_changed` to active rows in `webhooks` table (events JSON includes event name or `*`).

## Deploy
```bash
git checkout phase-c-cases
npm run db:init
npx wrangler deploy
```
