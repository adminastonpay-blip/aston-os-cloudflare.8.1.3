# ASTON OS — Activar Vectorize (búsqueda semántica)

## ¿Qué es Vectorize?

Es la **base de datos de vectores** de Cloudflare.

Flujo:
1. Un texto se convierte en un vector de 768 números (embedding) con Workers AI.
2. Ese vector se guarda en Vectorize junto con metadata (tenant, sector, record_id).
3. Cuando buscás por significado, se convierte tu pregunta en otro vector y Vectorize
   devuelve los registros más parecidos (no hace falta que coincidan las palabras exactas).

Modelo que usa ASTON: `@cf/baai/bge-base-en-v1.5` → **768 dimensiones**.
Métrica: **cosine**.

Requisito de Cloudflare: plan **Workers Paid** (Vectorize no está en el plan free).

---

## Pasos (una sola vez)

### 1. Login en Cloudflare (en tu PC o terminal)

```bash
npx wrangler login
```

### 2. Crear el índice (NO se puede cambiar dimensions/metric después)

```bash
npx wrangler vectorize create aston-omni-index --dimensions=768 --metric=cosine
```

Deberías ver: `Successfully created index 'aston-omni-index'`

### 3. Índices de metadata (filtrar por tenant y sector)

```bash
npx wrangler vectorize create-metadata-index aston-omni-index --property-name=tenant --type=string
npx wrangler vectorize create-metadata-index aston-omni-index --property-name=sector --type=string
```

### 4. Binding en el Worker

Ya está en `wrangler.toml`:

```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "aston-omni-index"
```

### 5. Deploy

```bash
npx wrangler deploy
```

O dejá que Cloudflare Builds despliegue desde GitHub.

### 6. Verificar

```bash
curl -s https://TU-WORKER/ | jq '.capabilities.vectorize, .capabilities.semantic_search'
```

Debe devolver `true` y `true`.

---

## Cómo usarlo

### Crear un record (auto-embed)

```bash
curl -X POST https://TU-WORKER/v1/records/fintech \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Tenant: demo" \
  -d '{"title":"Pago QR rural","text":"Solución de cobros para productores agropecuarios"}'
```

### Búsqueda semántica

```bash
curl -X POST https://TU-WORKER/v1/search/semantic \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Tenant: demo" \
  -d '{"q":"pagos para el campo","top_k":5}'
```

### Reindexar records del tenant

```bash
curl -X POST https://TU-WORKER/v1/embed/reindex \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "X-Tenant: demo"
```

---

## Si algo falla

| Síntoma | Causa | Qué hacer |
|---------|--------|-----------|
| `plugin_inactive` / missing VECTORIZE | Índice no existe o binding no desplegado | Crear índice + deploy |
| Error de dimensión | Índice con dimensions ≠ 768 | Borrar y recrear con 768 |
| Filter tenant no filtra | Falta metadata index | `create-metadata-index ... tenant` |
| Not available on free plan | Plan free | Workers Paid |

### Borrar y recrear (borra vectores)

```bash
npx wrangler vectorize delete aston-omni-index
npx wrangler vectorize create aston-omni-index --dimensions=768 --metric=cosine
```

## Qué ya hace el Worker

- Embeddings 768-d con Workers AI
- Auto-upsert al crear records
- `POST /v1/search/semantic`
- `POST /v1/embed/reindex`
- Plugin `semantic-search` activo solo si existen `AI` + `VECTORIZE`
