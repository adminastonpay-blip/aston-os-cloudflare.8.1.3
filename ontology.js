// ASTON OS — Ontology layer (Phase 1 + 3.1 ACL enforce)
// Entities, relations, graph query, pathfinding, extract + server-side OLS

import { filterEntitiesByAcl, gateEntityRead, gateEntityWrite } from "./secure_read.js";

const ENTITY_TYPES = new Set([
  "person", "organization", "account", "product", "order", "location", "asset",
  "supplier", "store", "document", "event", "risk", "metric", "other"
]);
const REL_TYPES = new Set([
  "owns", "belongs_to", "works_at", "located_in", "supplies", "buys_from",
  "related_to", "mentions", "derived_from", "transacted_with", "audited", "risks"
]);

const VERSION = "11.6.1";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function safeParse(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

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

function slugId(prefix = "e") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
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
    await db.prepare(
      "UPDATE ontology_entities SET type = ?, name = ?, props = ?, source = COALESCE(?, source), updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind(etype, ename, propsJson, src, now, tenant, eid).run();
    return eid;
  }
  const byName = await db.prepare(
    "SELECT id FROM ontology_entities WHERE tenant = ? AND type = ? AND lower(name) = lower(?) LIMIT 1"
  ).bind(tenant, etype, ename).first();
  if (byName?.id) {
    await db.prepare(
      "UPDATE ontology_entities SET props = ?, source = COALESCE(?, source), updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind(propsJson, src, now, tenant, byName.id).run();
    return byName.id;
  }
  await db.prepare(
    "INSERT INTO ontology_entities (id, tenant, type, name, props, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(eid, tenant, etype, ename, propsJson, src, now, now).run();
  return eid;
}

async function createRelation(db, tenant, { id, rel_type, from_id, to_id, props }) {
  const rid = id || slugId("rel");
  const rt = REL_TYPES.has(String(rel_type || "").toLowerCase()) ? String(rel_type).toLowerCase() : "related_to";
  if (!from_id || !to_id) throw new Error("from_id_and_to_id_required");
  const from = await db.prepare("SELECT id FROM ontology_entities WHERE tenant = ? AND id = ?").bind(tenant, String(from_id)).first();
  const to = await db.prepare("SELECT id FROM ontology_entities WHERE tenant = ? AND id = ?").bind(tenant, String(to_id)).first();
  if (!from || !to) throw new Error("endpoint_entity_missing");
  const now = new Date().toISOString();
  const propsJson = JSON.stringify(props && typeof props === "object" ? props : {});
  await db.prepare(
    "INSERT INTO ontology_relations (id, tenant, rel_type, from_id, to_id, props, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(rid, tenant, rt, String(from_id), String(to_id), propsJson, now).run();
  return rid;
}

function heuristicExtract(text) {
  const entities = [];
  const t = String(text || "").slice(0, 8000);
  for (const m of t.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)) {
    entities.push({ type: "person", name: m[0], props: { kind: "email" } });
  }
  for (const m of t.matchAll(/\b([A-Z][a-zA-Z0-9&]+(?:\s+[A-Z][a-zA-Z0-9&]+){0,3})\s+(?:Inc|LLC|Ltd|SA|S\.A\.|Corp)\b/g)) {
    entities.push({ type: "organization", name: m[0].trim() });
  }
  for (const m of t.matchAll(/\b(?:acct|account|cuenta)[:\s#]*([A-Z0-9_-]{4,32})\b/gi)) {
    entities.push({ type: "account", name: m[1], props: { label: "account_code" } });
  }
  for (const m of t.matchAll(/\b(?:order|pedido|orden)[:\s#]*([A-Z0-9_-]{4,32})\b/gi)) {
    entities.push({ type: "order", name: m[1] });
  }
  return entities.slice(0, 40);
}

async function listEntities(db, tenant, { type, q, limit = 20 } = {}) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 20));
  // Over-fetch slightly so ACL filter still returns ~limit visible rows
  const fetchLim = Math.min(80, lim * 2);
  if (type && q) {
    return (await db.prepare(
      "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?"
    ).bind(tenant, String(type).toLowerCase(), `%${String(q).slice(0, 100)}%`, fetchLim).all()).results || [];
  }
  if (type) {
    return (await db.prepare(
      "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? ORDER BY updated_at DESC LIMIT ?"
    ).bind(tenant, String(type).toLowerCase(), fetchLim).all()).results || [];
  }
  if (q) {
    return (await db.prepare(
      "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?"
    ).bind(tenant, `%${String(q).slice(0, 100)}%`, fetchLim).all()).results || [];
  }
  return (await db.prepare(
    "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? ORDER BY updated_at DESC LIMIT ?"
  ).bind(tenant, fetchLim).all()).results || [];
}

async function getEntity(db, tenant, id) {
  const row = await db.prepare(
    "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND id = ?"
  ).bind(tenant, id).first();
  if (!row) return null;
  return { ...row, props: safeParse(row.props, {}) };
}

async function queryGraph(db, tenant, { entity_id, direction = "both", rel_type, depth = 1, limit = 30 } = {}) {
  if (!entity_id) throw new Error("entity_id_required");
  const lim = Math.min(100, Math.max(1, Number(limit) || 30));
  const d = Math.min(3, Math.max(1, Number(depth) || 1));
  const visited = new Set([entity_id]);
  const edges = [];
  let frontier = [entity_id];
  for (let level = 0; level < d; level++) {
    const next = [];
    for (const eid of frontier) {
      let rows = [];
      if (direction === "out" || direction === "both") {
        const stmt = rel_type
          ? db.prepare("SELECT * FROM ontology_relations WHERE tenant = ? AND from_id = ? AND rel_type = ? LIMIT ?").bind(tenant, eid, String(rel_type).toLowerCase(), lim)
          : db.prepare("SELECT * FROM ontology_relations WHERE tenant = ? AND from_id = ? LIMIT ?").bind(tenant, eid, lim);
        rows = rows.concat((await stmt.all()).results || []);
      }
      if (direction === "in" || direction === "both") {
        const stmt = rel_type
          ? db.prepare("SELECT * FROM ontology_relations WHERE tenant = ? AND to_id = ? AND rel_type = ? LIMIT ?").bind(tenant, eid, String(rel_type).toLowerCase(), lim)
          : db.prepare("SELECT * FROM ontology_relations WHERE tenant = ? AND to_id = ? LIMIT ?").bind(tenant, eid, lim);
        rows = rows.concat((await stmt.all()).results || []);
      }
      for (const r of rows) {
        edges.push(r);
        for (const n of [r.from_id, r.to_id]) {
          if (!visited.has(n)) { visited.add(n); next.push(n); }
        }
      }
    }
    frontier = next;
    if (edges.length >= lim) break;
  }
  const entities = [];
  for (const id of [...visited].slice(0, 80)) {
    const row = await getEntity(db, tenant, id);
    if (row) entities.push(row);
  }
  return { root: entity_id, entities, relations: edges.slice(0, lim), depth: d };
}

async function findPath(db, tenant, from_id, to_id, maxDepth = 6) {
  if (!from_id || !to_id) throw new Error("from_id_and_to_id_required");
  if (from_id === to_id) {
    const e = await getEntity(db, tenant, from_id);
    return { found: true, path: [from_id], hops: 0, entities: e ? [e] : [], relations: [] };
  }
  const maxD = Math.min(6, Math.max(1, Number(maxDepth) || 6));
  const parent = new Map();
  parent.set(from_id, null);
  let frontier = [from_id];
  let found = false;
  for (let depth = 0; depth < maxD && !found; depth++) {
    const next = [];
    for (const eid of frontier) {
      const out = (await db.prepare(
        "SELECT * FROM ontology_relations WHERE tenant = ? AND from_id = ? LIMIT 50"
      ).bind(tenant, eid).all()).results || [];
      const inn = (await db.prepare(
        "SELECT * FROM ontology_relations WHERE tenant = ? AND to_id = ? LIMIT 50"
      ).bind(tenant, eid).all()).results || [];
      for (const r of out.concat(inn)) {
        const other = r.from_id === eid ? r.to_id : r.from_id;
        if (parent.has(other)) continue;
        parent.set(other, { prev: eid, edge: r });
        if (other === to_id) { found = true; break; }
        next.push(other);
      }
      if (found) break;
    }
    frontier = next;
  }
  if (!parent.has(to_id)) return { found: false, path: [], hops: -1, entities: [], relations: [] };
  const path = [];
  const relations = [];
  let cur = to_id;
  while (cur && cur !== from_id) {
    path.unshift(cur);
    const step = parent.get(cur);
    if (!step) break;
    relations.unshift(step.edge);
    cur = step.prev;
  }
  path.unshift(from_id);
  const entities = [];
  for (const id of path) {
    const e = await getEntity(db, tenant, id);
    if (e) entities.push(e);
  }
  return { found: true, path, hops: path.length - 1, entities, relations };
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
        ok: true,
        phase: "3.1-acl-enforce",
        version: VERSION,
        tenant,
        acl_enforced: true,
        counts: { entities: count?.c || 0, relations: relc?.c || 0 },
        entity_types: [...ENTITY_TYPES],
        relation_types: [...REL_TYPES]
      }, 200, cors);
    }

    if (method === "GET" && path === "/v1/ontology/types") {
      return json({ ok: true, entity_types: [...ENTITY_TYPES], relation_types: [...REL_TYPES], phase: "3.1" }, 200, cors);
    }

    if (method === "GET" && path === "/v1/ontology/entities") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      const rows = await listEntities(db, tenant, {
        type: url.searchParams.get("type"),
        q: url.searchParams.get("q"),
        limit
      });
      const parsed = rows.map((r) => ({ ...r, props: safeParse(r.props, {}) }));
      const filtered = await filterEntitiesByAcl(env, auth, parsed, "entity");
      return json({
        ok: true,
        tenant,
        acl_enforced: true,
        denied_count: filtered.denied,
        entities: filtered.entities.slice(0, limit)
      }, 200, cors);
    }

    if (method === "GET" && /^\/v1\/ontology\/entities\/[^/]+$/.test(path)) {
      const id = path.split("/").pop();
      const entity = await getEntity(db, tenant, id);
      if (!entity) return json({ ok: false, error: "not_found" }, 404, cors);
      const gated = await gateEntityRead(env, auth, entity, "entity");
      if (!gated) return json({ ok: false, error: "forbidden", reason: "acl_or_clearance" }, 403, cors);
      const out = (await db.prepare(
        "SELECT id, rel_type, to_id, props, created_at FROM ontology_relations WHERE tenant = ? AND from_id = ? LIMIT 50"
      ).bind(tenant, id).all()).results || [];
      const inn = (await db.prepare(
        "SELECT id, rel_type, from_id, props, created_at FROM ontology_relations WHERE tenant = ? AND to_id = ? LIMIT 50"
      ).bind(tenant, id).all()).results || [];
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
        ids.push(await upsertEntity(db, tenant, item));
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
        ids.push(await createRelation(db, tenant, item));
      }
      return json({ ok: true, tenant, ids }, 200, cors);
    }

    if (method === "GET" && path === "/v1/ontology/query") {
      try {
        const graph = await queryGraph(db, tenant, {
          entity_id: url.searchParams.get("entity_id"),
          direction: url.searchParams.get("direction") || "both",
          rel_type: url.searchParams.get("rel_type"),
          depth: url.searchParams.get("depth"),
          limit: url.searchParams.get("limit")
        });
        const rootGate = await gateEntityRead(env, auth, { id: graph.root }, "entity");
        if (!rootGate && graph.root) {
          return json({ ok: false, error: "forbidden", reason: "acl_or_clearance", entity_id: graph.root }, 403, cors);
        }
        const filtered = await filterEntitiesByAcl(env, auth, graph.entities, "entity");
        const visible = new Set(filtered.entities.map((e) => e.id));
        const relations = (graph.relations || []).filter((r) => visible.has(r.from_id) && visible.has(r.to_id));
        return json({
          ok: true,
          tenant,
          acl_enforced: true,
          denied_count: filtered.denied,
          root: graph.root,
          entities: filtered.entities,
          relations,
          depth: graph.depth
        }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400, cors);
      }
    }

    if (method === "GET" && path === "/v1/ontology/neighbors") {
      try {
        const graph = await queryGraph(db, tenant, {
          entity_id: url.searchParams.get("entity_id"),
          direction: url.searchParams.get("direction") || "both",
          rel_type: url.searchParams.get("rel_type"),
          depth: 1,
          limit: url.searchParams.get("limit") || 50
        });
        const filtered = await filterEntitiesByAcl(env, auth, graph.entities, "entity");
        const visible = new Set(filtered.entities.map((e) => e.id));
        return json({
          ok: true,
          tenant,
          mode: "neighbors",
          acl_enforced: true,
          denied_count: filtered.denied,
          root: graph.root,
          entities: filtered.entities,
          relations: (graph.relations || []).filter((r) => visible.has(r.from_id) && visible.has(r.to_id)),
          depth: 1
        }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400, cors);
      }
    }

    if (method === "GET" && path === "/v1/ontology/path") {
      try {
        const result = await findPath(
          db,
          tenant,
          url.searchParams.get("from") || url.searchParams.get("from_id"),
          url.searchParams.get("to") || url.searchParams.get("to_id"),
          url.searchParams.get("max_depth")
        );
        const filtered = await filterEntitiesByAcl(env, auth, result.entities, "entity");
        // If any hop denied, path is not fully visible
        if (filtered.denied > 0) {
          return json({
            ok: true,
            tenant,
            found: false,
            reason: "path_partially_classified",
            denied_count: filtered.denied,
            visible_entities: filtered.entities
          }, 200, cors);
        }
        return json({ ok: true, tenant, acl_enforced: true, ...result, entities: filtered.entities }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400, cors);
      }
    }

    if (method === "POST" && path === "/v1/ontology/extract") {
      const body = await readJson(request);
      const text = String(body?.text || "").trim();
      if (!text) return json({ ok: false, error: "text_required" }, 400, cors);
      const persist = body?.persist !== false;
      let extracted = heuristicExtract(text);
      if (env.AI && body?.use_ai) {
        try {
          const model = env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
          const response = await env.AI.run(model, {
            messages: [
              { role: "system", content: "Extract entities as JSON array only. Each: {\"type\":\"person|organization|account|product|order|location|supplier|store|other\",\"name\":\"...\"}. Max 20." },
              { role: "user", content: text.slice(0, 3000) }
            ]
          });
          const raw = typeof response === "string" ? response : (response?.response || "");
          const m = raw.match(/\[[\s\S]*\]/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            if (Array.isArray(parsed)) extracted = parsed.concat(extracted).slice(0, 40);
          }
        } catch (e) { console.error("ontology ai extract failed", e?.message || e); }
      }
      const ids = [];
      if (persist) {
        for (const ent of extracted) {
          try { ids.push(await upsertEntity(db, tenant, { ...ent, source: body?.source || "extract" })); } catch (_) {}
        }
      }
      return json({ ok: true, tenant, extracted, persisted_ids: ids, phase: "3.1" }, 200, cors);
    }

    if (method === "POST" && path === "/v1/ontology/warm" && env.ASTON_ONTOLOGY) {
      const stub = env.ASTON_ONTOLOGY.get(env.ASTON_ONTOLOGY.idFromName(`ont:${tenant}`));
      return stub.fetch(new Request("https://ontology.internal/warm", {
        method: "POST",
        headers: { "content-type": "application/json", "x-aston-tenant": tenant },
        body: JSON.stringify({ tenant })
      }));
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("ontology handler", e?.message || e);
    return json({ ok: false, error: "ontology_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}

export class AstonOntology {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    const tenant = request.headers.get("x-aston-tenant") || "default";
    if (request.method === "POST" && url.pathname.endsWith("/warm")) {
      if (!this.env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503);
      await ensureOntologySchema(this.env.ASTON_DB);
      const rows = await listEntities(this.env.ASTON_DB, tenant, { limit: 50 });
      await this.ctx.storage.put("recent", rows);
      await this.ctx.storage.put("warmed_at", new Date().toISOString());
      return json({ ok: true, tenant, cached: rows.length });
    }
    if (request.method === "GET") {
      return json({
        ok: true,
        tenant,
        recent: (await this.ctx.storage.get("recent")) || [],
        warmed_at: (await this.ctx.storage.get("warmed_at")) || null
      });
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
}

export async function ontologyToolSearch(env, tenant, q, limit = 10) {
  if (!env.ASTON_DB) return { error: "d1_unavailable" };
  await ensureOntologySchema(env.ASTON_DB);
  return { mode: "ontology", entities: await listEntities(env.ASTON_DB, tenant, { q, limit }) };
}

export async function ontologyToolTraverse(env, tenant, entity_id, depth = 1) {
  if (!env.ASTON_DB) return { error: "d1_unavailable" };
  await ensureOntologySchema(env.ASTON_DB);
  return queryGraph(env.ASTON_DB, tenant, { entity_id, depth, limit: 30 });
}

export async function ontologyToolUpsert(env, tenant, entity) {
  if (!env.ASTON_DB) return { error: "d1_unavailable" };
  await ensureOntologySchema(env.ASTON_DB);
  return { id: await upsertEntity(env.ASTON_DB, tenant, entity) };
}
