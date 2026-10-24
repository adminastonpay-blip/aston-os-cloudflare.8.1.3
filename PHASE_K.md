# Phase K — PoV / Demo Kit

Kit para demostraciones ejecutivas.

## APIs
| Method | Path |
|--------|------|
| GET | `/v1/capabilities` or `/v1/pov/status` |
| GET | `/v1/pov/graph` |
| POST | `/v1/pov/seed` |
| POST | `/v1/pov/demo` (seed if empty + optional orchestrator) |

## Demo flow
1. Deploy + token
2. `POST /v1/pov/demo`
3. Open `/ui` → Search "Edge" → Cases → Metrics bench
4. Show Truth Receipt on orchestrator response

## Version 10.4.0
