# Index.js wiring for Phase A (apply on merge if not already in index.js)

1. Add import:
```js
import { handleOntology, AstonOntology } from "./ontology.js";
```

2. Bump VERSION to `9.2.0` and `x-aston-os` header.

3. Add plugin in PLUGIN_DEFINITIONS:
```js
{ id: "ontology", name: "Ontology Graph", version: "9.2.0", description: "Entities, relations, path queries", requires: ["ASTON_DB"], routes: ["POST /v1/ontology/entities", "GET /v1/ontology/entities", "POST /v1/ontology/relations", "GET /v1/ontology/query", "POST /v1/ontology/extract", "GET /v1/ontology/types"] },
```

4. Before agent routes, add:
```js
if (path.startsWith("/v1/ontology")) {
  const auth = await authorized(request, env, method === "GET" ? "read" : "write");
  if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
  return handleOntology(request, env, auth, cors);
}
```

5. Export:
```js
export { AstonOntology } from "./ontology.js";
```

A pre-patched `index.js` is available in the branch artifacts conversation; apply the 5 steps above on `main` index if the full file is not committed.
