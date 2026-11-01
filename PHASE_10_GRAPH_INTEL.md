# Phase 10 — Graph Intelligence

**Branch:** `phase-10-graph-intel`  
**Version:** 12.3.0  
**Stacks on:** Phase 9.1 auto-emit

## Goal
Bring ontology closer to Palantir Ontology Explorer / graph navigation: neighbors, shortest path (BFS), ego-subgraph, and degree/type stats — all ACL-aware.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/ontology/entities/:id/neighbors` | 1-hop neighbors (`direction=in\|out\|both`, `rel_type`, `limit`) |
| GET | `/v1/ontology/path?from=&to=&max_hops=` | BFS shortest path (undirected, max 6 hops) |
| GET | `/v1/ontology/subgraph?id=&depth=&limit=` | Ego network up to depth 3 |
| GET | `/v1/ontology/stats` | Counts by type / relation + top degree |

## Security
- Seed entity must pass `gateEntityRead`.
- Neighbor / path / subgraph nodes are filtered with `filterEntitiesByAcl`.
- Denied nodes never appear in path or edges.

## Limits (edge-safe)
- Path: max_hops ≤ 6
- Subgraph: depth ≤ 3, nodes ≤ 100
- Neighbors: limit ≤ 80
- Edge loads batched with IN clauses capped

## Status
`GET /v1/ontology` → `phase: "10-graph-intel"`, `graph: true`
