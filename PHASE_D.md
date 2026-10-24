# Phase D — Governance

## Features
- **Scope catalog** — fine-grained permissions (`ontology:read`, `cases:write`, `audit:export`, …)
- **Role presets** — `viewer`, `operator`, `compliance`, `admin`
- **tenant_actors** — per-actor scopes (RLS-style); header `X-Aston-Actor` with API token
- **Lineage** — provenance for entities (`/v1/governance/lineage`)
- **Audit export** — JSONL to R2 `audit-exports/{tenant}/{id}.jsonl`

## APIs

| Method | Path |
|--------|------|
| GET | `/v1/governance/whoami` |
| GET | `/v1/governance/scopes` |
| GET/POST | `/v1/governance/actors` |
| GET/POST | `/v1/governance/lineage` |
| POST | `/v1/governance/audit/export` |

### Register actor
```json
POST /v1/governance/actors
{ "actor": "ops-bot", "role": "operator" }
```

### Whoami
```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Aston-Actor: ops-bot" $HOST/v1/governance/whoami
```

API token without a `tenant_actors` row keeps full admin scopes (backward compatible).

## Deploy
```bash
git checkout phase-d-governance
npm run db:init
npx wrangler deploy
```
