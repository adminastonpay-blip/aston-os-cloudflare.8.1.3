# Phase G — Foundry Core (Worker maximum)

Backend capabilities closest to Palantir Foundry **that fit on the Worker**.

## Modules
| Module | API |
|--------|-----|
| Object types (versioned) | `GET/POST /v1/foundry/types` |
| Object view | `GET /v1/foundry/objects/:id` |
| Mutation history | `GET /v1/foundry/objects/:id/history` |
| Update object | `POST /v1/foundry/objects/:id` |
| Actions | `POST /v1/foundry/objects/:id/actions/:action` |
| Global search | `GET /v1/foundry/search?q=` or `/v1/search?q=` |
| Approvals (HITL) | `GET /v1/foundry/approvals`, `.../approve|reject` |
| Sync schedules | `GET/POST /v1/foundry/sync`, `.../run` |

## Built-in actions
- `open_case` — creates case on object
- `flag_risk` — props risk flag
- `link_objects` — ontology relation
- `run_investigation` — **requires approval** then orchestrator
- `export_snapshot` — **requires approval**

## Still NOT on Worker (needs product/org)
UI Workshop, SSO/SAML, SOC2, 100+ connectors, forward-deployed teams.

## Deploy
```bash
git checkout phase-g-foundry-core
npm run db:init
npx wrangler deploy
```
