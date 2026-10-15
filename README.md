# ASTON OS Omni-Core 8.4.0

Edge-native multi-tenant core on Cloudflare Workers.

## New in 8.4.0

- **Semantic search** (`POST /v1/search/semantic`) via Workers AI embeddings + Vectorize
- **Auto-embed** on record create when AI + Vectorize are bound
- **Reindex** (`POST /v1/embed/reindex`) for tenant records
- **Background jobs** (`POST /v1/jobs`, `GET /v1/jobs`) via Queues
- **Agent runtime** (`POST /v1/agent/run`) per-tenant Durable Object
- Plugins: `semantic-search`, `jobs`, `agent`

## Enable optional resources

```bash
npx wrangler vectorize create aston-omni-index --dimensions=768 --metric=cosine
npx wrangler queues create aston-global-queue
npx wrangler deploy
```

## Deploy

```bash
npm install
npx wrangler deploy
```
