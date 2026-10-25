# ASTON OS (Cloudflare Worker)

**main @ v10.5.0** — Edge operational intelligence: ontology, multi-agent orchestrator, cases, governance, fusion, Foundry core, Truth Receipts, metrics, `/ui` graph + PoV kit.

## Quick links
- Deploy: see **[DEPLOY.md](./DEPLOY.md)**
- Roadmap: [ROADMAP.md](./ROADMAP.md)
- UI (after deploy): `https://<worker>/ui`

## Modules (A–L)
| Area | Routes |
|------|--------|
| Ontology / Foundry | `/v1/ontology`, `/v1/foundry`, `/v1/search` |
| Orchestrator | `/v1/orchestrator` |
| Cases | `/v1/cases` |
| Governance | `/v1/governance` |
| Fusion | `/v1/fusion` |
| Truth Receipts | `/v1/receipts` |
| Metrics | `/v1/metrics` |
| PoV | `/v1/pov`, `/v1/capabilities` |
| UI | `/ui` |

## Auth
`Authorization: Bearer <ASTON_API_TOKEN>` and optional `X-Tenant`.

## Honest scope
This is an edge-native ops stack, not full Palantir Foundry parity. LLM/orchestrator latency is not sub-100ms end-to-end; edge-core benchmarks are separate.
