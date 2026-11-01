// ASTON OS — Ontology + Phase 9.1 auto-emit
import { filterEntitiesByAcl, gateEntityRead, gateEntityWrite } from "./secure_read.js";
import { emitChangeEvent } from "./events_feed.js";

const ENTITY_TYPES = new Set(["person","organization","account","product","order","location","asset","supplier","store","document","event","risk","metric","other"]);
const REL_TYPES = new Set(["owns","belongs_to","works_at","located_in","supplies","buys_from","related_to","mentions","derived_from","transacted_with","audited","risks"]);
const VERSION = "12.2.1";

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
      return json({ ok: true, phase: "9.1-auto-emit", version: VERSION, tenant, acl_enforced: true, auto_emit: true,
        counts: { entities: count?.c || 0, relations: relc?.c || 0 }, entity_types: [...ENTITY_TYPES], relation_types: [...REL_TYPES] }, 200, cors);
    }

    if (method === "GET" && path === "/v1/ontology/types") {
      return json({ ok: true, entity_types: [...ENTITY_TYPES], relation_types: [...REL_TYPES], phase: "9.1" }, 200, cors);
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
