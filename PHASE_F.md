# Phase F — Data Fusion

Ingest external data into **records + ontology** (+ **Vectorize** when bound).

## Connectors

| Endpoint | Source |
|----------|--------|
| `POST /v1/fusion/ingest/json` | Array of items |
| `POST /v1/fusion/ingest/csv` | CSV text in JSON body |
| `POST /v1/fusion/webhook/shopify` | Shopify order/customer/product webhooks |
| `GET /v1/fusion/status` | Connector status |
| `GET /v1/fusion/runs` | Fusion run history |

## JSON ingest
```json
{
  "source": "crm_export",
  "sector": "commerce",
  "default_type": "person",
  "embed": true,
  "items": [
    { "name": "Acme Corp", "type": "organization", "text": "Supplier Acme" },
    { "name": "ORD-1", "type": "order", "props": { "total": 100 } }
  ]
}
```

## CSV ingest
```json
{
  "csv": "name,type,country\nAcme,organization,US\n",
  "name_field": "name",
  "type_field": "type",
  "embed": true
}
```

## Shopify
Point webhook to `/v1/fusion/webhook/shopify` with `Authorization: Bearer …` and `X-Tenant`.  
Optional secret: `SHOPIFY_WEBHOOK_SECRET` (wrangler secret).

## Pipeline per item
1. Insert `records`
2. Upsert `ontology_entities`
3. `lineage` row
4. Embed → Vectorize (if `AI` + `VECTORIZE`)

## Deploy
```bash
git checkout phase-f-fusion
npm run db:init
npx wrangler deploy
```
