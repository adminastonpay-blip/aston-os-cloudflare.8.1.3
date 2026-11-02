// ASTON OS — Phase 12 Functions on Objects / Transforms
// Declarative transforms over object sets or entity lists (Foundry Functions lite)

import { filterEntitiesByAcl, gateEntityWrite } from "./secure_read.js";
import { emitChangeEvent } from "./events_feed.js";

const VERSION = "12.5.0";

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

/** Built-in function catalog */
export const FUNCTION_CATALOG = [
  {
    id: "tag_prop",
    title: "Set property tag",
    description: "Write a key/value into each entity props",
    risk: "low",
    writeback: true,
    params: ["key", "value"]
  },
  {
    id: "score_risk",
    title: "Heuristic risk score",
    description: "Compute risk_score from name/props keywords and write props.risk_score",
    risk: "low",
    writeback: true,
    params: []
  },
  {
    id: "normalize_name",
    title: "Normalize name",
    description: "Trim + collapse whitespace on entity name",
    risk: "low",
    writeback: true,
    params: []
  },
  {
    id: "derive_summary",
    title: "Derive summary entity",
    description: "Create a metric/document entity summarizing the input set",
    risk: "medium",
    writeback: true,
    params: ["title"]
  },
  {
    id: "count_by_type",
    title: "Count by type",
    description: "Aggregate counts — no writeback, returns stats only",
    risk: "low",
    writeback: false,
    params: []
  },
  {
    id: "flag_missing_props",
    title: "Flag missing required props",
    description: "Mark props._missing with required keys that are absent",
    risk: "low",
    writeback: true,
    params: ["required"]
  }
];

export async function ensureFunctionsSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS function_runs (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      function_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT,
      stats TEXT,
      error TEXT,
      actor TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_fn_runs ON function_runs (tenant, created_at)")
  ]);
}

function scoreRisk(entity) {
  const text = `${entity.name || ""} ${JSON.stringify(entity.props || {})}`.toLowerCase();
  let score = 10;
  if (/\b(sanction|ofac|blocked|fraud|launder)\b/.test(text)) score += 50;
  if (/\b(high.?risk|critical|urgent)\b/.test(text)) score += 25;
  if (/\b(supplier|vendor|offshore)\b/.test(text)) score += 10;
  if (/\b(compliant|verified|trusted)\b/.test(text)) score -= 15;
  return Math.max(0, Math.min(100, score));
}

async function loadEntitiesByIds(db, tenant, ids) {
  const out = [];
  for (const id of (ids || []).slice(0, 100)) {
    const row = await db.prepare(
      "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND id = ?"
    ).bind(tenant, id).first();
    if (row) out.push({ ...row, props: safeParse(row.props, {}) });
  }
  return out;
}

async function loadObjectSetMembers(env, auth, tenant, setId, limit = 50) {
  const db = env.ASTON_DB;
  const row = await db.prepare("SELECT * FROM object_sets WHERE tenant = ? AND id = ?").bind(tenant, setId).first();
  if (!row) return { error: "object_set_not_found", entities: [] };
  const filter = safeParse(row.filter_json, {});
  const staticIds = safeParse(row.static_ids, null);
  // reuse lightweight resolve
  if (Array.isArray(staticIds) && staticIds.length) {
    const entities = await loadEntitiesByIds(db, tenant, staticIds.slice(0, limit));
    const filtered = await filterEntitiesByAcl(env, auth, entities, "entity");
    return { entities: filtered.entities, denied_count: filtered.denied, set_name: row.name };
  }
  // dynamic: type/q path
  let rows = [];
  const type = filter.type;
  const q = filter.q;
  if (type && q) {
    rows = ((await db.prepare(
      "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?"
    ).bind(tenant, String(type).toLowerCase(), `%${String(q).slice(0, 80)}%`, limit * 2).all()).results || []);
  } else if (type) {
    rows = ((await db.prepare(
      "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? ORDER BY updated_at DESC LIMIT ?"
    ).bind(tenant, String(type).toLowerCase(), limit * 2).all()).results || []);
  } else if (q) {
    rows = ((await db.prepare(
      "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?"
    ).bind(tenant, `%${String(q).slice(0, 80)}%`, limit * 2).all()).results || []);
  } else {
    rows = ((await db.prepare(
      "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? ORDER BY updated_at DESC LIMIT ?"
    ).bind(tenant, limit * 2).all()).results || []);
  }
  const parsed = rows.map((r) => ({ ...r, props: safeParse(r.props, {}) }));
  const filtered = await filterEntitiesByAcl(env, auth, parsed, "entity");
  return { entities: filtered.entities.slice(0, limit), denied_count: filtered.denied, set_name: row.name };
}

async function writeProps(db, tenant, entityId, props) {
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE ontology_entities SET props = ?, updated_at = ? WHERE tenant = ? AND id = ?"
  ).bind(JSON.stringify(props), now, tenant, entityId).run();
}

async function writeName(db, tenant, entityId, name) {
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE ontology_entities SET name = ?, updated_at = ? WHERE tenant = ? AND id = ?"
  ).bind(String(name).slice(0, 500), now, tenant, entityId).run();
}

async function runFunction(env, auth, fnId, entities, params = {}, dryRun = false) {
  const tenant = auth.tenant;
  const actor = auth.actor || "function";
  const db = env.ASTON_DB;
  const stats = { processed: 0, written: 0, skipped: 0, derived: [] };
  const results = [];

  for (const ent of entities) {
    stats.processed++;
    if (!dryRun) {
      const gate = await gateEntityWrite(env, auth, ent.id, "write", "entity");
      if (!gate.allowed) {
        stats.skipped++;
        results.push({ id: ent.id, ok: false, reason: "forbidden" });
        continue;
      }
    }

    try {
      if (fnId === "tag_prop") {
        const key = String(params.key || params.prop || "tag").slice(0, 80);
        const value = params.value != null ? params.value : true;
        const next = { ...(ent.props || {}), [key]: value };
        if (!dryRun) {
          await writeProps(db, tenant, ent.id, next);
          try {
            await emitChangeEvent(env, {
              tenant, event: "entity.updated", resource_kind: "entity", resource_id: ent.id,
              payload: { function: fnId, key }, actor
            });
          } catch (_) {}
        }
        stats.written++;
        results.push({ id: ent.id, ok: true, props: { [key]: value } });
      } else if (fnId === "score_risk") {
        const score = scoreRisk(ent);
        const next = { ...(ent.props || {}), risk_score: score, risk_scored_at: new Date().toISOString() };
        if (!dryRun) {
          await writeProps(db, tenant, ent.id, next);
          try {
            await emitChangeEvent(env, {
              tenant, event: "entity.updated", resource_kind: "entity", resource_id: ent.id,
              payload: { function: fnId, risk_score: score }, actor
            });
          } catch (_) {}
        }
        stats.written++;
        results.push({ id: ent.id, ok: true, risk_score: score });
      } else if (fnId === "normalize_name") {
        const normalized = String(ent.name || "").trim().replace(/\s+/g, " ");
        if (!normalized) {
          stats.skipped++;
          results.push({ id: ent.id, ok: false, reason: "empty_name" });
          continue;
        }
        if (!dryRun && normalized !== ent.name) {
          await writeName(db, tenant, ent.id, normalized);
          try {
            await emitChangeEvent(env, {
              tenant, event: "entity.updated", resource_kind: "entity", resource_id: ent.id,
              payload: { function: fnId, name: normalized }, actor
            });
          } catch (_) {}
          stats.written++;
        } else if (normalized === ent.name) {
          stats.skipped++;
        } else {
          stats.written++;
        }
        results.push({ id: ent.id, ok: true, name: normalized });
      } else if (fnId === "flag_missing_props") {
        const required = Array.isArray(params.required) ? params.required : String(params.required || "").split(",").map((s) => s.trim()).filter(Boolean);
        const missing = required.filter((k) => ent.props == null || ent.props[k] === undefined || ent.props[k] === null || ent.props[k] === "");
        const next = { ...(ent.props || {}), _missing: missing, _missing_checked_at: new Date().toISOString() };
        if (!dryRun) {
          await writeProps(db, tenant, ent.id, next);
          try {
            await emitChangeEvent(env, {
              tenant, event: "entity.updated", resource_kind: "entity", resource_id: ent.id,
              payload: { function: fnId, missing }, actor
            });
          } catch (_) {}
        }
        stats.written++;
        results.push({ id: ent.id, ok: true, missing });
      } else if (fnId === "count_by_type") {
        // handled after loop
        results.push({ id: ent.id, type: ent.type });
      } else if (fnId === "derive_summary") {
        // one-shot after loop
        results.push({ id: ent.id, type: ent.type, name: ent.name });
      } else {
        stats.skipped++;
        results.push({ id: ent.id, ok: false, reason: "unknown_function" });
      }
    } catch (e) {
      stats.skipped++;
      results.push({ id: ent.id, ok: false, reason: String(e.message || e).slice(0, 120) });
    }
  }

  if (fnId === "count_by_type") {
    const byType = {};
    for (const r of results) {
      if (r.type) byType[r.type] = (byType[r.type] || 0) + 1;
    }
    stats.by_type = byType;
    return { stats, results: [], aggregate: byType };
  }

  if (fnId === "derive_summary") {
    const title = String(params.title || `Summary ${new Date().toISOString().slice(0, 10)}`).slice(0, 200);
    const byType = {};
    for (const e of entities) byType[e.type] = (byType[e.type] || 0) + 1;
    const summaryProps = {
      count: entities.length,
      by_type: byType,
      source_ids: entities.map((e) => e.id).slice(0, 100),
      generated_by: "function:derive_summary"
    };
    if (!dryRun) {
      const id = slugId("ent");
      const now = new Date().toISOString();
      await db.prepare(
        "INSERT INTO ontology_entities (id, tenant, type, name, props, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, tenant, "metric", title, JSON.stringify(summaryProps), "function:derive_summary", now, now).run();
      stats.written++;
      stats.derived.push(id);
      try {
        await emitChangeEvent(env, {
          tenant, event: "entity.created", resource_kind: "entity", resource_id: id,
          payload: { function: fnId, title }, actor
        });
      } catch (_) {}
      return { stats, results, derived_id: id, summary: summaryProps };
    }
    return { stats, results, summary: summaryProps, dry_run: true };
  }

  return { stats, results };
}

export async function handleFunctions(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureFunctionsSchema(env.ASTON_DB);
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

  if (method === "GET" && (path === "/v1/functions" || path === "/v1/functions/status" || path === "/v1/functions/catalog")) {
    return json({
      ok: true,
      phase: "12-functions",
      version: VERSION,
      catalog: FUNCTION_CATALOG,
      endpoints: {
        catalog: "GET /v1/functions/catalog",
        run: "POST /v1/functions/run",
        run_named: "POST /v1/functions/run/:function_id",
        runs: "GET /v1/functions/runs"
      }
    }, 200, cors);
  }

  if (method === "GET" && path === "/v1/functions/runs") {
    const limit = Math.min(40, Number(url.searchParams.get("limit") || 15));
    const rows = await db.prepare(
      "SELECT id, function_id, status, stats, error, actor, created_at, finished_at FROM function_runs WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(tenant, limit).all();
    return json({ ok: true, runs: rows.results || [] }, 200, cors);
  }

  const runMatch = path.match(/^\/v1\/functions\/run(?:\/([^/]+))?$/);
  if (method === "POST" && runMatch) {
    const body = await readJson(request) || {};
    const fnId = runMatch[1] || body.function_id || body.function || body.id;
    const meta = FUNCTION_CATALOG.find((f) => f.id === fnId);
    if (!meta) {
      return json({ ok: false, error: "unknown_function", catalog: FUNCTION_CATALOG.map((f) => f.id) }, 400, cors);
    }

    const dryRun = body.dry_run === true;
    const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));
    let entities = [];
    let sourceMeta = {};

    if (body.object_set_id) {
      const loaded = await loadObjectSetMembers(env, auth, tenant, body.object_set_id, limit);
      if (loaded.error) return json({ ok: false, error: loaded.error }, 404, cors);
      entities = loaded.entities;
      sourceMeta = { object_set_id: body.object_set_id, set_name: loaded.set_name, denied_count: loaded.denied_count };
    } else if (Array.isArray(body.entity_ids) && body.entity_ids.length) {
      const raw = await loadEntitiesByIds(db, tenant, body.entity_ids.slice(0, limit));
      const filtered = await filterEntitiesByAcl(env, auth, raw, "entity");
      entities = filtered.entities;
      sourceMeta = { entity_ids: body.entity_ids.length, denied_count: filtered.denied };
    } else if (body.filter && typeof body.filter === "object") {
      // ad-hoc filter via object-set style
      const type = body.filter.type;
      const q = body.filter.q;
      let rows = [];
      if (type) {
        rows = ((await db.prepare(
          "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND type = ? ORDER BY updated_at DESC LIMIT ?"
        ).bind(tenant, String(type).toLowerCase(), limit * 2).all()).results || []);
      } else if (q) {
        rows = ((await db.prepare(
          "SELECT id, type, name, props, source, created_at, updated_at FROM ontology_entities WHERE tenant = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?"
        ).bind(tenant, `%${String(q).slice(0, 80)}%`, limit * 2).all()).results || []);
      }
      const parsed = rows.map((r) => ({ ...r, props: safeParse(r.props, {}) }));
      const filtered = await filterEntitiesByAcl(env, auth, parsed, "entity");
      entities = filtered.entities.slice(0, limit);
      sourceMeta = { filter: body.filter, denied_count: filtered.denied };
    } else {
      return json({
        ok: false,
        error: "input_required",
        hint: "Provide object_set_id, entity_ids[], or filter{}"
      }, 400, cors);
    }

    if (!entities.length) {
      return json({ ok: true, function_id: fnId, dry_run: dryRun, stats: { processed: 0 }, source: sourceMeta, message: "no_entities" }, 200, cors);
    }

    const runId = slugId("fnr");
    const now = new Date().toISOString();
    if (!dryRun) {
      await db.prepare(
        `INSERT INTO function_runs (id, tenant, function_id, status, input_json, stats, error, actor, created_at, finished_at)
         VALUES (?, ?, ?, 'running', ?, NULL, NULL, ?, ?, NULL)`
      ).bind(runId, tenant, fnId, JSON.stringify({ ...sourceMeta, params: body.params || {} }).slice(0, 4000), actor, now).run();
    }

    try {
      const outcome = await runFunction(env, auth, fnId, entities, body.params || body, dryRun);
      if (!dryRun) {
        await db.prepare(
          "UPDATE function_runs SET status = ?, stats = ?, finished_at = ? WHERE id = ?"
        ).bind("done", JSON.stringify(outcome.stats).slice(0, 4000), new Date().toISOString(), runId).run();
        try {
          await emitChangeEvent(env, {
            tenant,
            event: "function.completed",
            resource_kind: "function_run",
            resource_id: runId,
            payload: { function_id: fnId, stats: outcome.stats },
            actor
          });
        } catch (_) {}
      }

      return json({
        ok: true,
        phase: "12-functions",
        function_id: fnId,
        run_id: dryRun ? null : runId,
        dry_run: dryRun,
        source: sourceMeta,
        ...outcome
      }, 200, cors);
    } catch (e) {
      if (!dryRun) {
        await db.prepare(
          "UPDATE function_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?"
        ).bind("failed", String(e.message || e).slice(0, 500), new Date().toISOString(), runId).run();
      }
      return json({ ok: false, error: "function_failed", detail: String(e.message || e).slice(0, 300) }, 500, cors);
    }
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
