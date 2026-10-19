# Anti-Gap Phase 6 — RAG / Knowledge Base

**Branch:** `feature/anti-gap-p6`  
`index.js` untouched. Vectorize optional (`ASTON_VECTORIZE`).

## Routes

| Method | Path | Auth |
|--------|------|------|
| POST | `/v1/kb/ingest` | write |
| POST/GET | `/v1/kb/search` | read |
| GET | `/v1/kb/docs` | read |
| DELETE | `/v1/kb/docs/:id` | admin |

## Flow

1. Ingest text → R2 + D1 chunks + Workers AI embeddings (`bge-base-en-v1.5`)
2. Search → Vectorize if bound, else cosine on D1, else keyword
3. Agent tool `knowledge_search`

## Deploy

```bash
git checkout feature/anti-gap-p6
npx wrangler deploy
```
