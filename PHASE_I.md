# Phase I — Edge Metrics

Instrumentación de latencia para respaldar claims de Océano Azul (edge vs horas de batch).

## APIs
| Method | Path | Uso |
|--------|------|-----|
| GET | `/v1/metrics/status` | Estado |
| GET | `/v1/metrics/summary` | p50/p95/p99 por ruta |
| POST | `/v1/metrics/bench` | Micro-benchmark edge (crypto + D1) |

Headers en respuestas A–H: `x-aston-ms`, `server-timing`.

## Nota honesta
- **edge_core** (crypto + D1 ligero) puede ir sub-100ms.
- **Orchestrator / LLM / voz** son multi-segundo: no se venden como sub-100ms de extremo a extremo.

## Deploy
```bash
git checkout phase-i-edge-metrics
npm run db:init
npx wrangler deploy
```
