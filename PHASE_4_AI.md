# Phase 4 — Multi-Model AI Orchestration (+5%)

**Version:** 10.9.0  
**Routes:** `/v1/ai/*`

## Router
- Catalog: Workers AI (Llama 8B/70B, Qwen) + OpenAI + Anthropic
- Selects by complexity, latency budget, cost
- Edge-first: fast tier on Workers AI; heavy only when needed

## Endpoints
- `GET /v1/ai/models` — catalog + availability
- `GET /v1/ai/status`
- `POST /v1/ai/route` — dry-run selection
- `POST /v1/ai/chat` — routed completion
- `POST /v1/ai/rag` — Vectorize + ontology context → answer

## RAG
1. Embed query (bge-base)
2. Vectorize top-k
3. Ontology name/type LIKE fallback from D1
4. Inject CONTEXT into system+user messages

## Env
- `AI` (Workers AI)
- `VECTORIZE` (optional)
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (optional heavy tier)
