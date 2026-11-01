# ASTON OS (Cloudflare Worker)

**v11.5.0 — Phase 2 AIP** — Edge operational intelligence: ontology graph, Foundry core, AIP plan→approve→execute, multi-agent orchestrator, cases, Truth Receipts.

## Quick links
- Deploy: **[DEPLOY.md](./DEPLOY.md)**
- Phase 1: **[PHASE_1_ONTOLOGY.md](./PHASE_1_ONTOLOGY.md)**
- Phase 2: **[PHASE_2_AIP.md](./PHASE_2_AIP.md)**
- UI: `https://<worker>/ui`

## Modules
| Area | Routes |
|------|--------|
| AIP (HITL) | `/v1/aip/plan`, `/v1/aip/plans/:id/approve`, `/execute` |
| Orchestrator | `/v1/orchestrator/run` |
| Cases | `/v1/cases` |
| Receipts | `/v1/receipts` |
| Ontology | `/v1/ontology` |
| Foundry | `/v1/foundry`, `/v1/search` |
| Capabilities | `/v1/capabilities` |

## Auth
`Authorization: Bearer <ASTON_API_TOKEN>` + optional `X-Tenant`, `X-Aston-Actor`.

## Honest scope
Moving toward Palantir-class ontology + AIP on the edge. Not full Foundry/AIP parity.
