# ASTON OS 11.0.0 — Sovereign Leap

Three edge-native engines that push autonomy and latency beyond sequential AIP-style agents.

## 1. Multi-Agent Swarm (`/v1/swarm`)
- Agents: detector → negotiator + twin (parallel) → notary
- HMAC swarm receipt
- `POST /v1/swarm/run` with payload (delay, risk, amount…)

## 2. Predictive Stream (`/v1/predictive`)
- EWMA + z-score anomaly at ingest (no lake round-trip)
- 3-step projection, trend up/down/flat
- KV-backed stream state
- `POST /v1/predictive/ingest`

## 3. Auto-Governance (`/v1/gov`)
- Policy rules: max_amount, min_risk, field equals/contains
- Actions: allow | block | revert | challenge
- Immutable HMAC execution receipt
- `POST /v1/gov/execute`

## Health
`GET /health` → `version: 11.0.0`, `phase: 11-sovereign`
