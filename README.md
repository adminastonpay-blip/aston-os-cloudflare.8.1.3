# ASTON OS (Cloudflare Worker)

**main track @ v11.4.0 — Phase 1 Ontology** — Edge operational intelligence: ontology graph, Foundry core, multi-agent modules, governance, fusion, Truth Receipts, metrics, `/ui` studio.

## Quick links
- Deploy: see **[DEPLOY.md](./DEPLOY.md)**
- Phase 1 notes: **[PHASE_1_ONTOLOGY.md](./PHASE_1_ONTOLOGY.md)**
- Roadmap: [ROADMAP.md](./ROADMAP.md)
- UI (after deploy): `https://<worker>/ui`

## Modules
| Area | Routes |
|------|--------|
| Ontology (Phase 1) | `/v1/ontology`, `/v1/ontology/entities`, `/v1/ontology/query`, `/v1/ontology/path`, `/v1/ontology/neighbors` |
| Foundry | `/v1/foundry`, `/v1/foundry/types`, `/v1/foundry/objects/:id`, `/v1/search` |
| Security | `/v1/security` |
| Connectors | `/v1/connectors` |
| Capabilities | `/v1/capabilities` |
| UI | `/ui`, `/ui/studio` |

## Auth
`Authorization: Bearer <ASTON_API_TOKEN>` and optional `X-Tenant`, `X-Aston-Actor`.

## Honest scope
Edge-native ops stack moving toward Palantir-class ontology + actions. Not full Foundry parity. LLM latency is not sub-100ms end-to-end.
