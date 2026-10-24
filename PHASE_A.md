# Phase A — Ontology

## APIs

| Method | Path | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/v1/ontology/types` | read | Tipos de entidad y relación |
| GET | `/v1/ontology/entities?type=&q=&limit=` | read | Listar / buscar entidades |
| POST | `/v1/ontology/entities` | write | Upsert entidad(es) |
| POST | `/v1/ontology/relations` | write | Crear relación(es) |
| GET | `/v1/ontology/query?entity_id=&depth=&direction=` | read | Traversal del grafo |
| POST | `/v1/ontology/extract` | write | Extraer entidades de texto (`persist`, `use_ai`) |

## Agent tools

- `ontology_search` — busca entidades por nombre
- `ontology_traverse` — vecinos del grafo
- `ontology_upsert` — crea/actualiza entidad

## Ejemplo

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  https://<worker>/v1/ontology/entities \
  -d '{"type":"organization","name":"ASTON Commerce","props":{"sector":"commerce"}}'

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  https://<worker>/v1/ontology/extract \
  -d '{"text":"Order ORD-9981 from Acme Corp Inc account ACC-44","persist":true}'
```
