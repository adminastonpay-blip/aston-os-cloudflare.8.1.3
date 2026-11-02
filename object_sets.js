// ASTON OS — Phase 11 Object Sets + Saved Views
// Named, persisted filters over ontology entities (Palantir Object Sets lite)

import { filterEntitiesByAcl } from "./secure_read.js";
import { emitChangeEvent } from "./events_feed.js";

const VERSION = "12.4.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function safeParse(s, fb) {
  try { return s ? JSON.parse(s) : fb; } catch { return fb; }
}

function slugId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

export async function ensureObjectSetsSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS object_sets (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      filter_json TEXT NOT NULL,
      static_ids TEXT,
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_objset_tenant ON object_sets (tenant, updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_objset_name ON object_sets (tenant, name)")
  ]);
}

/**
 * filter_json shape:
 * {
 *   type?: string | string[],
 *   q?: string,                 // name LIKE
 *   ids?: string[],             // explicit inclusion
 *   source?: string,
 *   props_contains?: { key, value },  // simple props match (JSON text)
 *   limit?: number
 * }
 * static_ids: optional frozen membership snapshot
 */
async function resolveMembers(env, auth, tenant, filter, staticIds, limit = 50) {
  const db = env.ASTON_DB;
  const lim = Math.min(100, Math.max(1, Number(limit) || Number(filter?.limit) || 50));
  let rows = [];

  if (Array.isArray(staticIds) && staticIds.length) {
    const ids = staticIds.slice(0, lim);
    for (const id of ids) {
      const row = await db.prepare(
        "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND id = ?"
      ).bind(tenant, id).first();
      if (row) rows.push({ ...row, props: safeParse(row.props, {}) });
    }
  } else {
    const type = filter?.type;
    const q = filter?.q ? String(filter.q).slice(0, 100) : null;
    const source = filter?.source ? String(filter.source).slice(0, 120) : null;
    const fetchLim = Math.min(200, lim * 2);

    if (Array.isArray(filter?.ids) && filter.ids.length) {
      for (const id of filter.ids.slice(0, lim)) {
        const row = await db.prepare(
          "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND id = ?"
        ).bind(tenant, String(id)).first();
        if (row) rows.push({ ...row, props: safeParse(row.props, {}) });
      }
    } else if (Array.isArray(type) && type.length) {
      // multi-type: fetch each and merge
      for (const t of type.slice(0, 8)) {
        const part = await db.prepare(
          "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? ORDER BY updated_at DESC LIMIT ?"
        ).bind(tenant, String(t).toLowerCase(), Math.ceil(fetchLim / type.length)).all();
        rows = rows.concat((part.results || []).map((r) => ({ ...r, props: safeParse(r.props, {}) })));
      }
    } else if (type && q) {
      rows = ((await db.prepare(
        "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?"
      ).bind(tenant, String(type).toLowerCase(), `%${q}%`, fetchLim).all()).results || [])
        .map((r) => ({ ...r, props: safeParse(r.props, {}) }));
    } else if (type) {
      rows = ((await db.prepare(
        "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? ORDER BY updated_at DESC LIMIT ?"
      ).bind(tenant, String(type).toLowerCase(), fetchLim).all()).results || [])
        .map((r) => ({ ...r, props: safeParse(r.props, {}) }));
    } else if (q) {
      rows = ((await db.prepare(
        "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?"
      ).bind(tenant, `%${q}%`, fetchLim).all()).results || [])
        .map((r) => ({ ...r, props: safeParse(r.props, {}) }));
    } else if (source) {
      rows = ((await db.prepare(
        "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND source = ? ORDER BY updated_at DESC LIMIT ?"
      ).bind(tenant, source, fetchLim).all()).results || [])
        .map((r) => ({ ...r, props: safeParse(r.props, {}) }));
    } else {
      rows = ((await db.prepare(
        "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? ORDER BY updated_at DESC LIMIT ?"
      ).bind(tenant, fetchLim).all()).results || [])
        .map((r) => ({ ...r, props: safeParse(r.props, {}) }));
    }

    // optional props_contains filter (client-side on fetched batch)
    const pc = filter?.props_contains;
    if (pc && typeof pc === "object" && pc.key != null) {
      const key = String(pc.key);
      const val = pc.value;
      rows = rows.filter((r) => {
        const p = r.props || {};
        if (val === undefined) return key in p;
        return String(p[key]) === String(val);
      });
    }
  }

  const filtered = await filterEntitiesByAcl(env, auth, rows, "entity");
  return {
    entities: filtered.entities.slice(0, lim),
    denied_count: filtered.denied,
    total_matched: rows.length,
    returned: Math.min(lim, filtered.entities.length),
    acl_enforced: true
  };
}

export async function handleObjectSets(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureObjectSetsSchema(env.ASTON_DB);
  // ontology tables assumed present from earlier phases
  try {
    await env.ASTON_DB.prepare(
      `CREATE TABLE IF NOT EXISTS ontology_entities (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
        props TEXT, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
    ).run();
  } catch (_) {}

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const actor = auth.actor || "api";
  const db = env.ASTON_DB;

  if (method === "GET" && (path === "/v1/object-sets" || path === "/v1/object-sets/status")) {
    return json({
      ok: true,
      phase: "11-object-sets",
      version: VERSION,
      endpoints: {
        list: "GET /v1/object-sets/list",
        create: "POST /v1/object-sets",
        get: "GET /v1/object-sets/:id",
        update: "PUT /v1/object-sets/:id",
        delete: "DELETE /v1/object-sets/:id",
        members: "GET /v1/object-sets/:id/members",
        preview: "POST /v1/object-sets/preview",
        snapshot: "POST /v1/object-sets/:id/snapshot"
      },
      filter_fields: ["type", "q", "ids", "source", "props_contains", "limit"]
    }, 200, cors);
  }

  // Preview filter without saving
  if (method === "POST" && path === "/v1/object-sets/preview") {
    const body = await readJson(request) || {};
    const filter = body.filter || body;
    const result = await resolveMembers(env, auth, tenant, filter, null, body.limit || filter.limit || 30);
    return json({ ok: true, preview: true, filter, ...result }, 200, cors);
  }

  // List sets
  if (method === "GET" && path === "/v1/object-sets/list") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const rows = await db.prepare(
      `SELECT id, name, description, filter_json, static_ids, created_by, updated_by, created_at, updated_at
       FROM object_sets WHERE tenant = ? ORDER BY updated_at DESC LIMIT ?`
    ).bind(tenant, limit).all();
    const sets = (rows.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      filter: safeParse(r.filter_json, {}),
      has_snapshot: Boolean(r.static_ids),
      snapshot_count: r.static_ids ? (safeParse(r.static_ids, []) || []).length : 0,
      created_by: r.created_by,
      updated_by: r.updated_by,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
    return json({ ok: true, tenant, sets }, 200, cors);
  }

  // Create
  if (method === "POST" && path === "/v1/object-sets") {
    const body = await readJson(request) || {};
    const name = String(body.name || "").trim().slice(0, 200);
    if (!name) return json({ ok: false, error: "name_required" }, 400, cors);
    const filter = body.filter && typeof body.filter === "object" ? body.filter : {};
    const id = slugId("oset");
    const now = new Date().toISOString();
    const staticIds = Array.isArray(body.static_ids) ? body.static_ids.slice(0, 500) : null;
    await db.prepare(
      `INSERT INTO object_sets (id, tenant, name, description, filter_json, static_ids, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, tenant, name,
      body.description ? String(body.description).slice(0, 500) : null,
      JSON.stringify(filter),
      staticIds ? JSON.stringify(staticIds) : null,
      actor, actor, now, now
    ).run();

    try {
      await emitChangeEvent(env, {
        tenant,
        event: "object_set.created",
        resource_kind: "object_set",
        resource_id: id,
        payload: { name, filter },
        actor
      });
    } catch (_) {}

    return json({ ok: true, id, name, filter, has_snapshot: Boolean(staticIds) }, 201, cors);
  }

  // Get one
  if (method === "GET" && /^\/v1\/object-sets\/[^/]+$/.test(path) && !path.endsWith("/members") && !path.endsWith("/snapshot")) {
    const id = path.split("/").pop();
    const row = await db.prepare("SELECT * FROM object_sets WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    return json({
      ok: true,
      set: {
        id: row.id,
        name: row.name,
        description: row.description,
        filter: safeParse(row.filter_json, {}),
        static_ids: safeParse(row.static_ids, null),
        created_by: row.created_by,
        updated_by: row.updated_by,
        created_at: row.created_at,
        updated_at: row.updated_at
      }
    }, 200, cors);
  }

  // Update
  if (method === "PUT" && /^\/v1\/object-sets\/[^/]+$/.test(path)) {
    const id = path.split("/").pop();
    const row = await db.prepare("SELECT * FROM object_sets WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    const body = await readJson(request) || {};
    const name = body.name != null ? String(body.name).trim().slice(0, 200) : row.name;
    const description = body.description !== undefined
      ? (body.description ? String(body.description).slice(0, 500) : null)
      : row.description;
    const filter = body.filter && typeof body.filter === "object" ? body.filter : safeParse(row.filter_json, {});
    let staticIds = row.static_ids;
    if (body.clear_snapshot === true) staticIds = null;
    else if (Array.isArray(body.static_ids)) staticIds = JSON.stringify(body.static_ids.slice(0, 500));
    const now = new Date().toISOString();
    await db.prepare(
      `UPDATE object_sets SET name = ?, description = ?, filter_json = ?, static_ids = ?, updated_by = ?, updated_at = ?
       WHERE tenant = ? AND id = ?`
    ).bind(name, description, JSON.stringify(filter), staticIds, actor, now, tenant, id).run();

    try {
      await emitChangeEvent(env, {
        tenant,
        event: "object_set.updated",
        resource_kind: "object_set",
        resource_id: id,
        payload: { name, filter },
        actor
      });
    } catch (_) {}

    return json({ ok: true, id, name, filter }, 200, cors);
  }

  // Delete
  if (method === "DELETE" && /^\/v1\/object-sets\/[^/]+$/.test(path)) {
    const id = path.split("/").pop();
    await db.prepare("DELETE FROM object_sets WHERE tenant = ? AND id = ?").bind(tenant, id).run();
    try {
      await emitChangeEvent(env, {
        tenant,
        event: "object_set.deleted",
        resource_kind: "object_set",
        resource_id: id,
        payload: {},
        actor
      });
    } catch (_) {}
    return json({ ok: true, id, deleted: true }, 200, cors);
  }

  // Resolve members
  if (method === "GET" && /^\/v1\/object-sets\/[^/]+\/members$/.test(path)) {
    const id = path.split("/")[3];
    const row = await db.prepare("SELECT * FROM object_sets WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    const filter = safeParse(row.filter_json, {});
    const staticIds = safeParse(row.static_ids, null);
    const limit = Number(url.searchParams.get("limit") || filter.limit || 50);
    const result = await resolveMembers(env, auth, tenant, filter, staticIds, limit);
    return json({
      ok: true,
      set_id: id,
      name: row.name,
      mode: staticIds ? "snapshot" : "dynamic",
      filter,
      ...result
    }, 200, cors);
  }

  // Freeze current membership as snapshot
  if (method === "POST" && /^\/v1\/object-sets\/[^/]+\/snapshot$/.test(path)) {
    const id = path.split("/")[3];
    const row = await db.prepare("SELECT * FROM object_sets WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    const filter = safeParse(row.filter_json, {});
    const result = await resolveMembers(env, auth, tenant, filter, null, 500);
    const ids = result.entities.map((e) => e.id);
    const now = new Date().toISOString();
    await db.prepare(
      "UPDATE object_sets SET static_ids = ?, updated_by = ?, updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind(JSON.stringify(ids), actor, now, tenant, id).run();

    try {
      await emitChangeEvent(env, {
        tenant,
        event: "object_set.snapshot",
        resource_kind: "object_set",
        resource_id: id,
        payload: { count: ids.length },
        actor
      });
    } catch (_) {}

    return json({ ok: true, set_id: id, snapshot_count: ids.length, ids }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
