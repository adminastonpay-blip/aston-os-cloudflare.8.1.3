// ASTON OS — Ontology + Phase 9.1 auto-emit + Phase 10 Graph Intelligence
import { filterEntitiesByAcl, gateEntityRead, gateEntityWrite } from "./secure_read.js";
import { emitChangeEvent } from "./events_feed.js";

const ENTITY_TYPES = new Set(["person","organization","account","product","order","location","asset","supplier","store","document","event","risk","metric","other"]);
const REL_TYPES = new Set(["owns","belongs_to","works_at","located_in","supplies","buys_from","related_to","mentions","derived_from","transacted_with","audited","risks"]);
const VERSION = "12.3.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers } });

async function readJson(request) { try { return await request.json(); } catch { return null; } }
function safeParse(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }
function slugId(prefix = "e") { return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`; }

export async function ensureOntologySchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ontology_entities (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      props TEXT, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ont_ent_tenant ON ontology_entities (tenant, type, updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ont_ent_name ON ontology_entities (tenant, name)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS ontology_relations (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, rel_type TEXT NOT NULL,
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, props TEXT, created_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ont_rel_from ON ontology_relations (tenant, from_id, rel_type)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ont_rel_to ON ontology_relations (tenant, to_id, rel_type)")
  ]);
}

async function upsertEntity(db, tenant, { id, type, name, props, source }) {
  const now = new Date().toISOString();
  const eid = id || slugId("ent");
  const etype = ENTITY_TYPES.has(String(type || "").toLowerCase()) ? String(type).toLowerCase() : "other";
  const ename = String(name || "").trim().slice(0, 500);
  if (!ename) throw new Error("name_required");
  const propsJson = JSON.stringify(props && typeof props === "object" ? props : {});
  const src = source ? String(source).slice(0, 200) : null;
  const existing = await db.prepare("SELECT id FROM ontology_entities WHERE tenant = ? AND id = ?").bind(tenant, eid).first();
  if (existing) {
    await db.prepare("UPDATE ontology_entities SET type = ?, name = ?, props = ?, source = COALESCE(?, source), updated_at = ? WHERE tenant = ? AND id = ?")
      .bind(etype, ename, propsJson, src, now, tenant, eid).run();
    return { id: eid, created: false };
  }
  const byName = await db.prepare("SELECT id FROM ontology_entities WHERE tenant = ? AND type = ? AND lower(name) = lower(?) LIMIT 1").bind(tenant, etype, ename).first();
  if (byName?.id) {
    await db.prepare("UPDATE ontology_entities SET props = ?, source = COALESCE(?, source), updated_at = ? WHERE tenant = ? AND id = ?")
      .bind(propsJson, src, now, tenant, byName.id).run();
    return { id: byName.id, created: false };
  }
  await db.prepare("INSERT INTO ontology_entities (id, tenant, type, name, props, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(eid, tenant, etype, ename, propsJson, src, now, now).run();
  return { id: eid, created: true };
}

async function createRelation(db, tenant, { id, rel_type, from_id, to_id, props }) {
  const rid = id || slugId("rel");
  const rt = REL_TYPES.has(String(rel_type || "").toLowerCase()) ? String(rel_type).toLowerCase() : "related_to";
  if (!from_id || !to_id) throw new Error("from_id_and_to_id_required");
  const from = await db.prepare("SELECT id FROM ontology_entities WHERE tenant = ? AND id = ?").bind(tenant, String(from_id)).first();
  const to = await db.prepare("SELECT id FROM ontology_entities WHERE tenant = ? AND id = ?").bind(tenant, String(to_id)).first();
  if (!from || !to) throw new Error("endpoint_entity_missing");
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO ontology_relations (id, tenant, rel_type, from_id, to_id, props, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(rid, tenant, rt, String(from_id), String(to_id), JSON.stringify(props && typeof props === "object" ? props : {}), now).run();
  return rid;
}

async function listEntities(db, tenant, { type, q, limit = 20 } = {}) {
  const fetchLim = Math.min(80, Math.min(50, Math.max(1, Number(limit) || 20)) * 2);
  if (type && q) return (await db.prepare("SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?").bind(tenant, String(type).toLowerCase(), `%${String(q).slice(0, 100)}%`, fetchLim).all()).results || [];
  if (type) return (await db.prepare("SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? ORDER BY updated_at DESC LIMIT ?").bind(tenant, String(type).toLowerCase(), fetchLim).all()).results || [];
  if (q) return (await db.prepare("SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?").bind(tenant, `%${String(q).slice(0, 100)}%`, fetchLim).all()).results || [];
  return (await db.prepare("SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? ORDER BY updated_at DESC LIMIT ?").bind(tenant, fetchLim).all()).results || [];
}

async function getEntity(db, tenant, id) {
  const row = await db.prepare("SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND id = ?").bind(tenant, id).first();
  if (!row) return null;
  return { ...row, props: safeParse(row.props, {}) };
}

/** Load undirected adjacency for a set of node ids (bounded). */
async function loadEdges(db, tenant, nodeIds, relType = null) {
  if (!nodeIds.size) return [];
  const ids = [...nodeIds].slice(0, 200);
  const placeholders = ids.map(() => "?").join(",");
  let sql = `SELECT id, rel_type, from_id, to_id, props, created_at FROM ontology_relations
    WHERE tenant = ? AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`;
  const binds = [tenant, ...ids, ...ids];
  if (relType) {
    sql += " AND rel_type = ?";
    binds.push(String(relType).toLowerCase());
  }
  sql += " LIMIT 800";
  return (await db.prepare(sql).bind(...binds).all()).results || [];
}

async function hydrateEntities(db, tenant, ids) {
  const out = [];
  for (const id of [...ids].slice(0, 120)) {
    const e = await getEntity(db, tenant, id);
    if (e) out.push(e);
  }
  return out;
}

/** 1-hop neighbors of a seed (ACL filtered). */
async function neighborsOf(env, auth, db, tenant, seedId, { direction = "both", rel_type = null, limit = 40 } = {}) {
  const lim = Math.min(80, Math.max(1, Number(limit) || 40));
  let edges = [];
  if (direction === "out" || direction === "both") {
    const q = rel_type
      ? db.prepare("SELECT id, rel_type, from_id, to_id, props, created_at FROM ontology_relations WHERE tenant = ? AND from_id = ? AND rel_type = ? LIMIT ?").bind(tenant, seedId, String(rel_type).toLowerCase(), lim)
      : db.prepare("SELECT id, rel_type, from_id, to_id, props, created_at FROM ontology_relations WHERE tenant = ? AND from_id = ? LIMIT ?").bind(tenant, seedId, lim);
    edges = edges.concat((await q.all()).results || []);
  }
  if (direction === "in" || direction === "both") {
    const q = rel_type
      ? db.prepare("SELECT id, rel_type, from_id, to_id, props, created_at FROM ontology_relations WHERE tenant = ? AND to_id = ? AND rel_type = ? LIMIT ?").bind(tenant, seedId, String(rel_type).toLowerCase(), lim)
      : db.prepare("SELECT id, rel_type, from_id, to_id, props, created_at FROM ontology_relations WHERE tenant = ? AND to_id = ? LIMIT ?").bind(tenant, seedId, lim);
    edges = edges.concat((await q.all()).results || []);
  }
  const neighborIds = new Set();
  for (const e of edges) {
    if (e.from_id !== seedId) neighborIds.add(e.from_id);
    if (e.to_id !== seedId) neighborIds.add(e.to_id);
  }
  const raw = await hydrateEntities(db, tenant, neighborIds);
  const filtered = await filterEntitiesByAcl(env, auth, raw, "entity");
  const allowed = new Set(filtered.entities.map((e) => e.id));
  const edgeOut = edges.filter((e) => allowed.has(e.from_id === seedId ? e.to_id : e.from_id) || e.from_id === seedId || e.to_id === seedId)
    .filter((e) => {
      const other = e.from_id === seedId ? e.to_id : e.from_id;
      return other === seedId || allowed.has(other);
    })
    .slice(0, lim);
  return {
    seed_id: seedId,
    neighbors: filtered.entities.slice(0, lim),
    edges: edgeOut,
    denied_count: filtered.denied,
    acl_enforced: true
  };
}

/** BFS shortest path between two entities (undirected, ACL-aware). */
async function bfsPath(env, auth, db, tenant, fromId, toId, maxHops = 4) {
  const hops = Math.min(6, Math.max(1, Number(maxHops) || 4));
  if (fromId === toId) {
    const e = await getEntity(db, tenant, fromId);
    const gated = e ? await gateEntityRead(env, auth, e, "entity") : null;
    if (!gated) return { found: false, reason: "forbidden_or_missing" };
    return { found: true, hops: 0, path: [fromId], nodes: [gated], edges: [] };
  }

  const startGate = await gateEntityRead(env, auth, await getEntity(db, tenant, fromId) || { id: fromId }, "entity");
  const endGate = await gateEntityRead(env, auth, await getEntity(db, tenant, toId) || { id: toId }, "entity");
  if (!startGate || !endGate) return { found: false, reason: "forbidden_or_missing" };

  const visited = new Set([fromId]);
  const parent = new Map(); // node -> { prev, edge }
  let frontier = [fromId];
  let depth = 0;
  let found = false;

  while (frontier.length && depth < hops && !found) {
    const nextFrontier = [];
    const frontierSet = new Set(frontier);
    const edges = await loadEdges(db, tenant, frontierSet);
    // ACL-filter endpoint entities
    const candIds = new Set();
    for (const e of edges) {
      if (frontierSet.has(e.from_id)) candIds.add(e.to_id);
      if (frontierSet.has(e.to_id)) candIds.add(e.from_id);
    }
    const raw = await hydrateEntities(db, tenant, candIds);
    const filtered = await filterEntitiesByAcl(env, auth, raw, "entity");
    const allowed = new Set(filtered.entities.map((x) => x.id));

    for (const e of edges) {
      for (const [src, dst] of [[e.from_id, e.to_id], [e.to_id, e.from_id]]) {
        if (!frontierSet.has(src)) continue;
        if (visited.has(dst)) continue;
        if (!allowed.has(dst) && dst !== toId) continue;
        // still require end node readable
        if (dst === toId && !endGate) continue;
        visited.add(dst);
        parent.set(dst, { prev: src, edge: e });
        nextFrontier.push(dst);
        if (dst === toId) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    frontier = nextFrontier;
    depth++;
  }

  if (!found) return { found: false, hops: depth, reason: "no_path_within_max_hops", max_hops: hops };

  // reconstruct
  const pathIds = [toId];
  const pathEdges = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = parent.get(cur);
    if (!p) break;
    pathEdges.unshift(p.edge);
    pathIds.unshift(p.prev);
    cur = p.prev;
  }
  const nodesRaw = await hydrateEntities(db, tenant, new Set(pathIds));
  const nodesFilt = await filterEntitiesByAcl(env, auth, nodesRaw, "entity");
  return {
    found: true,
    hops: pathIds.length - 1,
    path: pathIds,
    nodes: nodesFilt.entities,
    edges: pathEdges,
    acl_enforced: true,
    denied_count: nodesFilt.denied
  };
}

/** Ego subgraph up to depth (BFS expansion). */
async function egoSubgraph(env, auth, db, tenant, seedId, depth = 2, nodeLimit = 60) {
  const maxDepth = Math.min(3, Math.max(1, Number(depth) || 2));
  const maxNodes = Math.min(100, Math.max(5, Number(nodeLimit) || 60));
  const seed = await getEntity(db, tenant, seedId);
  if (!seed) return null;
  const seedGated = await gateEntityRead(env, auth, seed, "entity");
  if (!seedGated) return { forbidden: true };

  const nodesMap = new Map([[seedId, seedGated]]);
  const edgeMap = new Map();
  let frontier = [seedId];

  for (let d = 0; d < maxDepth && nodesMap.size < maxNodes; d++) {
    const edges = await loadEdges(db, tenant, new Set(frontier));
    const cand = new Set();
    for (const e of edges) {
      edgeMap.set(e.id, e);
      if (!nodesMap.has(e.from_id)) cand.add(e.from_id);
      if (!nodesMap.has(e.to_id)) cand.add(e.to_id);
    }
    const raw = await hydrateEntities(db, tenant, cand);
    const filtered = await filterEntitiesByAcl(env, auth, raw, "entity");
    const next = [];
    for (const ent of filtered.entities) {
      if (nodesMap.size >= maxNodes) break;
      if (!nodesMap.has(ent.id)) {
        nodesMap.set(ent.id, ent);
        next.push(ent.id);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  // keep edges only between retained nodes
  const nodeIds = new Set(nodesMap.keys());
  const edges = [...edgeMap.values()].filter((e) => nodeIds.has(e.from_id) && nodeIds.has(e.to_id));

  return {
    seed_id: seedId,
    depth: maxDepth,
    nodes: [...nodesMap.values()],
    edges,
    counts: { nodes: nodesMap.size, edges: edges.length },
    acl_enforced: true
  };
}

export async function handleOntology(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const db = env.ASTON_DB;
  try {
    await ensureOntologySchema(db);

    if (method === "GET" && (path === "/v1/ontology" || path === "/v1/ontology/status")) {
      const count = await db.prepare("SELECT COUNT(*) as c FROM ontology_entities WHERE tenant = ?").bind(tenant).first();
      const relc = await db.prepare("SELECT COUNT(*) as c FROM ontology_relations WHERE tenant = ?").bind(tenant).first();
      return json({
        ok: true, phase: "10-graph-intel", version: VERSION, tenant,
        acl_enforced: true, auto_emit: true, graph: true,
        counts: { entities: count?.c || 0, relations: relc?.c || 0 },
        entity_types: [...ENTITY_TYPES], relation_types: [...REL_TYPES],
        endpoints: {
          neighbors: "GET /v1/ontology/entities/:id/neighbors",
          path: "GET /v1/ontology/path?from=&to=&max_hops=",
          subgraph: "GET /v1/ontology/subgraph?id=&depth=",
          stats: "GET /v1/ontology/stats"
        }
      }, 200, cors);
    }

    if (method === "GET" && path === "/v1/ontology/types") {
      return json({ ok: true, entity_types: [...ENTITY_TYPES], relation_types: [...REL_TYPES], phase: "10" }, 200, cors);
    }

    // Graph stats
    if (method === "GET" && path === "/v1/ontology/stats") {
      const byType = await db.prepare(
        "SELECT type, COUNT(*) as c FROM ontology_entities WHERE tenant = ? GROUP BY type ORDER BY c DESC LIMIT 30"
      ).bind(tenant).all();
      const byRel = await db.prepare(
        "SELECT rel_type, COUNT(*) as c FROM ontology_relations WHERE tenant = ? GROUP BY rel_type ORDER BY c DESC LIMIT 30"
      ).bind(tenant).all();
      // top degree (approx: sample relations)
      const degOut = await db.prepare(
        `SELECT from_id as id, COUNT(*) as degree FROM ontology_relations WHERE tenant = ?
         GROUP BY from_id ORDER BY degree DESC LIMIT 15`
      ).bind(tenant).all();
      const degIn = await db.prepare(
        `SELECT to_id as id, COUNT(*) as degree FROM ontology_relations WHERE tenant = ?
         GROUP BY to_id ORDER BY degree DESC LIMIT 15`
      ).bind(tenant).all();
      return json({
        ok: true, phase: "10-graph-intel", tenant,
        by_type: byType.results || [],
        by_relation: byRel.results || [],
        top_out_degree: degOut.results || [],
        top_in_degree: degIn.results || []
      }, 200, cors);
    }

    // Path finding
    if (method === "GET" && path === "/v1/ontology/path") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const maxHops = Number(url.searchParams.get("max_hops") || 4);
      if (!from || !to) return json({ ok: false, error: "from_and_to_required" }, 400, cors);
      const result = await bfsPath(env, auth, db, tenant, from, to, maxHops);
      return json({ ok: true, phase: "10-graph-intel", from, to, ...result }, 200, cors);
    }

    // Ego subgraph
    if (method === "GET" && path === "/v1/ontology/subgraph") {
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "id_required" }, 400, cors);
      const depth = Number(url.searchParams.get("depth") || 2);
      const limit = Number(url.searchParams.get("limit") || 60);
      const result = await egoSubgraph(env, auth, db, tenant, id, depth, limit);
      if (!result) return json({ ok: false, error: "not_found" }, 404, cors);
      if (result.forbidden) return json({ ok: false, error: "forbidden", reason: "acl_or_clearance" }, 403, cors);
      return json({ ok: true, phase: "10-graph-intel", ...result }, 200, cors);
    }

    // Neighbors
    if (method === "GET" && /^\/v1\/ontology\/entities\/[^/]+\/neighbors$/.test(path)) {
      const id = path.split("/")[4];
      const entity = await getEntity(db, tenant, id);
      if (!entity) return json({ ok: false, error: "not_found" }, 404, cors);
      const gated = await gateEntityRead(env, auth, entity, "entity");
      if (!gated) return json({ ok: false, error: "forbidden", reason: "acl_or_clearance" }, 403, cors);
      const result = await neighborsOf(env, auth, db, tenant, id, {
        direction: url.searchParams.get("direction") || "both",
        rel_type: url.searchParams.get("rel_type"),
        limit: Number(url.searchParams.get("limit") || 40)
      });
      return json({ ok: true, phase: "10-graph-intel", seed: gated, ...result }, 200, cors);
    }

    if (method === "GET" && path === "/v1/ontology/entities") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      const rows = await listEntities(db, tenant, { type: url.searchParams.get("type"), q: url.searchParams.get("q"), limit });
      const parsed = rows.map((r) => ({ ...r, props: safeParse(r.props, {}) }));
      const filtered = await filterEntitiesByAcl(env, auth, parsed, "entity");
      return json({ ok: true, tenant, acl_enforced: true, denied_count: filtered.denied, entities: filtered.entities.slice(0, limit) }, 200, cors);
    }

    if (method === "GET" && /^\/v1\/ontology\/entities\/[^/]+$/.test(path)) {
      const id = path.split("/").pop();
      const entity = await getEntity(db, tenant, id);
      if (!entity) return json({ ok: false, error: "not_found" }, 404, cors);
      const gated = await gateEntityRead(env, auth, entity, "entity");
      if (!gated) return json({ ok: false, error: "forbidden", reason: "acl_or_clearance" }, 403, cors);
      const out = (await db.prepare("SELECT id, rel_type, to_id, props, created_at FROM ontology_relations WHERE tenant = ? AND from_id = ? LIMIT 50").bind(tenant, id).all()).results || [];
      const inn = (await db.prepare("SELECT id, rel_type, from_id, props, created_at FROM ontology_relations WHERE tenant = ? AND to_id = ? LIMIT 50").bind(tenant, id).all()).results || [];
      return json({ ok: true, entity: gated, relations: { out, in: inn }, acl_enforced: true }, 200, cors);
    }

    if (method === "POST" && path === "/v1/ontology/entities") {
      const body = await readJson(request);
      if (!body || typeof body !== "object") return json({ ok: false, error: "json_object_required" }, 400, cors);
      const items = Array.isArray(body.entities) ? body.entities : [body];
      const ids = [];
      for (const item of items.slice(0, 50)) {
        if (item.id) {
          const w = await gateEntityWrite(env, auth, item.id, "write", "entity");
          if (!w.allowed) continue;
        }
        const result = await upsertEntity(db, tenant, item);
        ids.push(result.id);
        try {
          await emitChangeEvent(env, {
            tenant,
            event: result.created ? "entity.created" : "entity.updated",
            resource_kind: "entity",
            resource_id: result.id,
            payload: { type: item.type, name: item.name },
            actor: auth.actor || "api"
          });
        } catch (_) {}
      }
      try {
        await db.prepare("INSERT INTO audit_log (ts, tenant, actor, action, detail) VALUES (?, ?, ?, ?, ?)")
          .bind(new Date().toISOString(), tenant, auth.actor || "api", "ontology.entities.upsert", JSON.stringify({ count: ids.length }).slice(0, 1500)).run();
      } catch (_) {}
      return json({ ok: true, tenant, ids }, 200, cors);
    }

    if (method === "POST" && path === "/v1/ontology/relations") {
      const body = await readJson(request);
      if (!body || typeof body !== "object") return json({ ok: false, error: "json_object_required" }, 400, cors);
      const items = Array.isArray(body.relations) ? body.relations : [body];
      const ids = [];
      for (const item of items.slice(0, 50)) {
        const fromOk = await gateEntityWrite(env, auth, item.from_id, "write", "entity");
        if (item.from_id && !fromOk.allowed) continue;
        const rid = await createRelation(db, tenant, item);
        ids.push(rid);
        try {
          await emitChangeEvent(env, {
            tenant,
            event: "relation.created",
            resource_kind: "relation",
            resource_id: rid,
            payload: { rel_type: item.rel_type, from_id: item.from_id, to_id: item.to_id },
            actor: auth.actor || "api"
          });
        } catch (_) {}
      }
      return json({ ok: true, tenant, ids }, 200, cors);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("ontology handler", e?.message || e);
    return json({ ok: false, error: "ontology_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}

export async function ontologyToolSearch(env, tenant, q, limit = 10) {
  if (!env.ASTON_DB) return { error: "d1_unavailable" };
  await ensureOntologySchema(env.ASTON_DB);
  return { mode: "ontology", entities: await listEntities(env.ASTON_DB, tenant, { q, limit }) };
}

export async function ontologyToolUpsert(env, tenant, entity) {
  if (!env.ASTON_DB) return { error: "d1_unavailable" };
  await ensureOntologySchema(env.ASTON_DB);
  const r = await upsertEntity(env.ASTON_DB, tenant, entity);
  return { id: r.id };
}
