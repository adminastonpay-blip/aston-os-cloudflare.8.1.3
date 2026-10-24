// ASTON OS — Phase G Foundry Core (Worker-side maximum toward Palantir parity)
// Object types, actions, global search, mutation history, human approvals

const DEFAULT_OBJECT_TYPES = [
  { id: "organization", title: "Organization", properties: ["name", "country", "domain"] },
  { id: "person", title: "Person", properties: ["name", "email", "phone"] },
  { id: "product", title: "Product", properties: ["name", "sku", "price"] },
  { id: "order", title: "Order", properties: ["name", "total", "currency", "status"] },
  { id: "account", title: "Account", properties: ["name", "currency", "balance"] },
  { id: "supplier", title: "Supplier", properties: ["name", "country", "risk_score"] },
  { id: "other", title: "Other", properties: ["name"] }
];

const DEFAULT_LINK_TYPES = [
  { id: "owns", from: "organization", to: "product" },
  { id: "placed", from: "person", to: "order" },
  { id: "contains", from: "order", to: "product" },
  { id: "supplies", from: "supplier", to: "organization" },
  { id: "related_to", from: "*", to: "*" }
];

const BUILTIN_ACTIONS = {
  open_case: {
    id: "open_case",
    title: "Open operational case",
    risk: "medium",
    requires_approval: false,
    description: "Create a case linked to this object"
  },
  flag_risk: {
    id: "flag_risk",
    title: "Flag risk",
    risk: "low",
    requires_approval: false,
    description: "Annotate object with risk flag"
  },
  link_objects: {
    id: "link_objects",
    title: "Link to another object",
    risk: "low",
    requires_approval: false,
    description: "Create ontology relation"
  },
  run_investigation: {
    id: "run_investigation",
    title: "Run multi-agent investigation",
    risk: "high",
    requires_approval: true,
    description: "Orchestrator plan; high-impact → approval queue"
  },
  export_snapshot: {
    id: "export_snapshot",
    title: "Export object snapshot",
    risk: "high",
    requires_approval: true,
    description: "Mark export intent (approval required)"
  }
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": "10.0.0", ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

export async function ensureFoundrySchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS object_types (
      id TEXT NOT NULL,
      tenant TEXT NOT NULL,
      title TEXT NOT NULL,
      properties TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant, id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS link_types (
      id TEXT NOT NULL,
      tenant TEXT NOT NULL,
      from_type TEXT NOT NULL,
      to_type TEXT NOT NULL,
      title TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant, id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS entity_history (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ent_hist ON entity_history (tenant, entity_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS object_actions_log (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      entity_id TEXT,
      action_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT,
      result TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_obj_act ON object_actions_log (tenant, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      payload TEXT,
      decision_note TEXT,
      requested_by TEXT,
      decided_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_approvals ON approvals (tenant, status, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS sync_schedules (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      name TEXT NOT NULL,
      connector TEXT NOT NULL,
      config TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
  ]);
}

async function seedTypes(db, tenant) {
  const now = new Date().toISOString();
  for (const t of DEFAULT_OBJECT_TYPES) {
    await db.prepare(
      `INSERT OR IGNORE INTO object_types (id, tenant, title, properties, version, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`
    ).bind(t.id, tenant, t.title, JSON.stringify(t.properties), now, now).run();
  }
  for (const l of DEFAULT_LINK_TYPES) {
    await db.prepare(
      `INSERT OR IGNORE INTO link_types (id, tenant, from_type, to_type, title, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).bind(l.id, tenant, l.from, l.to, l.id, now).run();
  }
}

async function recordHistory(db, tenant, entityId, action, before, after, actor) {
  await db.prepare(
    `INSERT INTO entity_history (id, tenant, entity_id, action, before_json, after_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    newId("hist"),
    tenant,
    entityId,
    action,
    before ? JSON.stringify(before).slice(0, 4000) : null,
    after ? JSON.stringify(after).slice(0, 4000) : null,
    actor || "system",
    new Date().toISOString()
  ).run();
}

async function getEntity(db, tenant, id) {
  return db.prepare("SELECT * FROM ontology_entities WHERE tenant = ? AND id = ?").bind(tenant, id).first();
}

export async function handleFoundry(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const actor = auth.actor || "api";
  const db = env.ASTON_DB;

  try {
    await ensureFoundrySchema(db);
    await seedTypes(db, tenant);

    // ---- Status ----
    if (method === "GET" && (path === "/v1/foundry" || path === "/v1/foundry/status")) {
      return json({
        ok: true,
        phase: "G",
        version: "10.0.0",
        modules: ["object_types", "link_types", "actions", "search", "history", "approvals", "sync_schedules"],
        note: "Worker-side Foundry core — UI and enterprise compliance still external"
      }, 200, cors);
    }

    // ---- Object types ----
    if (method === "GET" && path === "/v1/foundry/types") {
      const rows = await db.prepare(
        "SELECT id, title, properties, version, active, updated_at FROM object_types WHERE tenant = ? ORDER BY id"
      ).bind(tenant).all();
      const links = await db.prepare(
        "SELECT id, from_type, to_type, title, active FROM link_types WHERE tenant = ? ORDER BY id"
      ).bind(tenant).all();
      return json({
        ok: true,
        object_types: (rows.results || []).map((r) => ({
          ...r,
          properties: safeParse(r.properties, [])
        })),
        link_types: links.results || []
      }, 200, cors);
    }

    if (method === "POST" && path === "/v1/foundry/types") {
      const body = await readJson(request);
      const id = String(body?.id || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
      if (!id) return json({ ok: false, error: "id_required" }, 400, cors);
      const title = String(body?.title || id).slice(0, 120);
      const properties = Array.isArray(body?.properties) ? body.properties : [];
      const now = new Date().toISOString();
      const existing = await db.prepare(
        "SELECT version FROM object_types WHERE tenant = ? AND id = ?"
      ).bind(tenant, id).first();
      if (existing) {
        await db.prepare(
          "UPDATE object_types SET title = ?, properties = ?, version = version + 1, updated_at = ? WHERE tenant = ? AND id = ?"
        ).bind(title, JSON.stringify(properties), now, tenant, id).run();
      } else {
        await db.prepare(
          `INSERT INTO object_types (id, tenant, title, properties, version, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 1, ?, ?)`
        ).bind(id, tenant, title, JSON.stringify(properties), now, now).run();
      }
      return json({ ok: true, id, title, properties }, 200, cors);
    }

    // ---- Global search ----
    if (method === "GET" && (path === "/v1/foundry/search" || path === "/v1/search")) {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q || q.length < 2) return json({ ok: false, error: "q_min_2_chars" }, 400, cors);
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || 10)));
      const like = `%${q.replace(/%/g, "")}%`;

      const entities = await db.prepare(
        "SELECT id, type, name, source, updated_at FROM ontology_entities WHERE tenant = ? AND (name LIKE ? OR id LIKE ?) ORDER BY updated_at DESC LIMIT ?"
      ).bind(tenant, like, like, limit).all();

      let cases = { results: [] };
      try {
        cases = await db.prepare(
          "SELECT id, title, status, priority, playbook, updated_at FROM cases WHERE tenant = ? AND title LIKE ? ORDER BY updated_at DESC LIMIT ?"
        ).bind(tenant, like, limit).all();
      } catch (_) {}

      let records = { results: [] };
      try {
        records = await db.prepare(
          "SELECT id, sector, text, created_at FROM records WHERE tenant = ? AND text LIKE ? ORDER BY created_at DESC LIMIT ?"
        ).bind(tenant, like, limit).all();
      } catch (_) {}

      return json({
        ok: true,
        q,
        results: {
          entities: entities.results || [],
          cases: cases.results || [],
          records: (records.results || []).map((r) => ({
            id: r.id,
            sector: r.sector,
            text: String(r.text || "").slice(0, 200),
            created_at: r.created_at
          }))
        }
      }, 200, cors);
    }

    // ---- Entity history ----
    if (method === "GET" && /^\/v1\/foundry\/objects\/[^/]+\/history$/.test(path)) {
      const entityId = path.split("/")[4];
      const rows = await db.prepare(
        "SELECT id, action, before_json, after_json, actor, created_at FROM entity_history WHERE tenant = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 50"
      ).bind(tenant, entityId).all();
      return json({ ok: true, entity_id: entityId, history: rows.results || [] }, 200, cors);
    }

    // ---- Object snapshot (Palantir-like object view API) ----
    if (method === "GET" && /^\/v1\/foundry\/objects\/[^/]+$/.test(path)) {
      const entityId = path.split("/").pop();
      const entity = await getEntity(db, tenant, entityId);
      if (!entity) return json({ ok: false, error: "not_found" }, 404, cors);
      const relsFrom = await db.prepare(
        "SELECT id, rel_type, to_id, props, created_at FROM ontology_relations WHERE tenant = ? AND from_id = ? LIMIT 50"
      ).bind(tenant, entityId).all();
      const relsTo = await db.prepare(
        "SELECT id, rel_type, from_id, props, created_at FROM ontology_relations WHERE tenant = ? AND to_id = ? LIMIT 50"
      ).bind(tenant, entityId).all();
      let lineage = { results: [] };
      try {
        lineage = await db.prepare(
          "SELECT id, source_kind, source_id, transform, actor, created_at FROM lineage WHERE tenant = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 20"
        ).bind(tenant, entityId).all();
      } catch (_) {}
      return json({
        ok: true,
        object: {
          ...entity,
          props: safeParse(entity.props, {})
        },
        relations: {
          out: relsFrom.results || [],
          in: relsTo.results || []
        },
        lineage: lineage.results || [],
        actions: Object.values(BUILTIN_ACTIONS)
      }, 200, cors);
    }

    // ---- Patch entity + history ----
    if (method === "POST" && /^\/v1\/foundry\/objects\/[^/]+$/.test(path) && !path.includes("/actions")) {
      const entityId = path.split("/").pop();
      const entity = await getEntity(db, tenant, entityId);
      if (!entity) return json({ ok: false, error: "not_found" }, 404, cors);
      const body = await readJson(request) || {};
      const before = { name: entity.name, props: entity.props, type: entity.type };
      const name = body.name != null ? String(body.name).slice(0, 500) : entity.name;
      let props = safeParse(entity.props, {});
      if (body.props && typeof body.props === "object") props = { ...props, ...body.props };
      const now = new Date().toISOString();
      await db.prepare(
        "UPDATE ontology_entities SET name = ?, props = ?, updated_at = ? WHERE tenant = ? AND id = ?"
      ).bind(name, JSON.stringify(props), now, tenant, entityId).run();
      const after = { name, props, type: entity.type };
      await recordHistory(db, tenant, entityId, "update", before, after, actor);
      return json({ ok: true, id: entityId, name, props }, 200, cors);
    }

    // ---- List / execute actions ----
    if (method === "GET" && path === "/v1/foundry/actions") {
      return json({ ok: true, actions: Object.values(BUILTIN_ACTIONS) }, 200, cors);
    }

    if (method === "POST" && /^\/v1\/foundry\/objects\/[^/]+\/actions\/[^/]+$/.test(path)) {
      const parts = path.split("/");
      const entityId = parts[4];
      const actionId = parts[6];
      const action = BUILTIN_ACTIONS[actionId];
      if (!action) return json({ ok: false, error: "unknown_action", actions: Object.keys(BUILTIN_ACTIONS) }, 400, cors);
      const entity = await getEntity(db, tenant, entityId);
      if (!entity) return json({ ok: false, error: "entity_not_found" }, 404, cors);
      const body = await readJson(request) || {};

      if (action.requires_approval && !body.approved_id) {
        const apprId = newId("appr");
        const now = new Date().toISOString();
        await db.prepare(
          `INSERT INTO approvals (id, tenant, kind, status, title, payload, decision_note, requested_by, decided_by, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, NULL, ?, ?)`
        ).bind(
          apprId, tenant, actionId,
          `${action.title}: ${entity.name}`,
          JSON.stringify({ entity_id: entityId, action_id: actionId, body }).slice(0, 4000),
          actor, now, now
        ).run();
        await db.prepare(
          `INSERT INTO object_actions_log (id, tenant, entity_id, action_id, status, payload, result, actor, created_at)
           VALUES (?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?)`
        ).bind(newId("oal"), tenant, entityId, actionId, JSON.stringify(body).slice(0, 2000),
          JSON.stringify({ approval_id: apprId }), actor, now).run();
        return json({
          ok: true,
          status: "pending_approval",
          approval_id: apprId,
          message: "High-risk action queued for human approval"
        }, 202, cors);
      }

      const result = await executeAction(env, auth, actionId, entity, body, actor);
      const now = new Date().toISOString();
      await db.prepare(
        `INSERT INTO object_actions_log (id, tenant, entity_id, action_id, status, payload, result, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        newId("oal"), tenant, entityId, actionId, result.ok ? "done" : "failed",
        JSON.stringify(body).slice(0, 2000),
        JSON.stringify(result).slice(0, 4000),
        actor, now
      ).run();
      await recordHistory(db, tenant, entityId, `action:${actionId}`, null, result, actor);
      return json({ ok: result.ok !== false, action: actionId, entity_id: entityId, result }, result.ok === false ? 500 : 200, cors);
    }

    // ---- Approvals ----
    if (method === "GET" && path === "/v1/foundry/approvals") {
      const status = url.searchParams.get("status") || "pending";
      const rows = await db.prepare(
        "SELECT * FROM approvals WHERE tenant = ? AND status = ? ORDER BY created_at DESC LIMIT 50"
      ).bind(tenant, status).all();
      return json({ ok: true, approvals: rows.results || [] }, 200, cors);
    }

    if (method === "POST" && /^\/v1\/foundry\/approvals\/[^/]+\/(approve|reject)$/.test(path)) {
      const apprId = path.split("/")[4];
      const decision = path.split("/")[5];
      const body = await readJson(request) || {};
      const row = await db.prepare("SELECT * FROM approvals WHERE tenant = ? AND id = ?").bind(tenant, apprId).first();
      if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
      if (row.status !== "pending") return json({ ok: false, error: "already_decided", status: row.status }, 409, cors);
      const now = new Date().toISOString();
      const newStatus = decision === "approve" ? "approved" : "rejected";
      await db.prepare(
        "UPDATE approvals SET status = ?, decision_note = ?, decided_by = ?, updated_at = ? WHERE tenant = ? AND id = ?"
      ).bind(newStatus, body.note ? String(body.note).slice(0, 500) : null, actor, now, tenant, apprId).run();

      let execResult = null;
      if (newStatus === "approved") {
        const payload = safeParse(row.payload, {});
        const entity = payload.entity_id ? await getEntity(db, tenant, payload.entity_id) : null;
        if (entity && payload.action_id) {
          execResult = await executeAction(env, auth, payload.action_id, entity, { ...(payload.body || {}), approved_id: apprId }, actor);
        }
      }
      return json({ ok: true, id: apprId, status: newStatus, execution: execResult }, 200, cors);
    }

    // ---- Sync schedules (config only; cron can call run) ----
    if (method === "GET" && path === "/v1/foundry/sync") {
      const rows = await db.prepare(
        "SELECT id, name, connector, config, enabled, last_run_at, last_status, updated_at FROM sync_schedules WHERE tenant = ? ORDER BY name"
      ).bind(tenant).all();
      return json({ ok: true, schedules: rows.results || [] }, 200, cors);
    }

    if (method === "POST" && path === "/v1/foundry/sync") {
      const body = await readJson(request);
      const name = String(body?.name || "").slice(0, 120);
      const connector = String(body?.connector || "json").slice(0, 40);
      if (!name) return json({ ok: false, error: "name_required" }, 400, cors);
      const id = newId("sync");
      const now = new Date().toISOString();
      await db.prepare(
        `INSERT INTO sync_schedules (id, tenant, name, connector, config, enabled, last_run_at, last_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)`
      ).bind(id, tenant, name, connector, JSON.stringify(body?.config || {}).slice(0, 4000), now, now).run();
      return json({ ok: true, id, name, connector }, 201, cors);
    }

    if (method === "POST" && /^\/v1\/foundry\/sync\/[^/]+\/run$/.test(path)) {
      const id = path.split("/")[4];
      const sched = await db.prepare("SELECT * FROM sync_schedules WHERE tenant = ? AND id = ?").bind(tenant, id).first();
      if (!sched) return json({ ok: false, error: "not_found" }, 404, cors);
      const config = safeParse(sched.config, {});
      let result = { note: "no_items" };
      if (sched.connector === "json" && Array.isArray(config.items)) {
        const { handleFusion } = await import("./fusion.js");
        const fake = new Request("https://foundry.internal/v1/fusion/ingest/json", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: config.items, source: `sync:${sched.name}`, embed: config.embed !== false })
        });
        const res = await handleFusion(fake, env, auth, {});
        result = await res.json().catch(() => ({ ok: false }));
      } else {
        result = { ok: true, note: "schedule_recorded_only", connector: sched.connector, hint: "Put items in config.items for json connector" };
      }
      const now = new Date().toISOString();
      await db.prepare(
        "UPDATE sync_schedules SET last_run_at = ?, last_status = ?, updated_at = ? WHERE tenant = ? AND id = ?"
      ).bind(now, result.ok === false ? "failed" : "ok", now, tenant, id).run();
      return json({ ok: true, schedule_id: id, result }, 200, cors);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("foundry handler", e?.message || e);
    return json({ ok: false, error: "foundry_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}

function safeParse(s, fallback) {
  try { return typeof s === "string" ? JSON.parse(s) : (s ?? fallback); } catch { return fallback; }
}

async function executeAction(env, auth, actionId, entity, body, actor) {
  const tenant = auth.tenant;
  const db = env.ASTON_DB;

  if (actionId === "flag_risk") {
    const props = safeParse(entity.props, {});
    props.risk_flag = true;
    props.risk_note = String(body?.note || "flagged").slice(0, 500);
    props.risk_at = new Date().toISOString();
    await db.prepare(
      "UPDATE ontology_entities SET props = ?, updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind(JSON.stringify(props), props.risk_at, tenant, entity.id).run();
    return { ok: true, risk_flag: true };
  }

  if (actionId === "link_objects") {
    const toId = body?.to_id;
    const relType = String(body?.rel_type || "related_to").slice(0, 40);
    if (!toId) return { ok: false, error: "to_id_required" };
    const id = newId("rel");
    await db.prepare(
      `INSERT INTO ontology_relations (id, tenant, rel_type, from_id, to_id, props, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, tenant, relType, entity.id, String(toId), JSON.stringify(body?.props || {}), new Date().toISOString()).run();
    return { ok: true, relation_id: id };
  }

  if (actionId === "open_case") {
    const { handleCases } = await import("./cases.js");
    const fake = new Request("https://foundry.internal/v1/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: body?.title || `Case: ${entity.name}`,
        playbook: body?.playbook || "ontology_alert",
        priority: body?.priority || "medium",
        ontology_ids: [entity.id],
        run_orchestrator: body?.run_orchestrator === true,
        payload: { entity_id: entity.id, entity_type: entity.type }
      })
    });
    const res = await handleCases(fake, env, auth, {});
    const data = await res.json().catch(() => null);
    return { ok: Boolean(data?.ok), case: data?.case || data };
  }

  if (actionId === "run_investigation") {
    const { handleOrchestrator } = await import("./orchestrator.js");
    const goal = body?.goal || `Investigate ${entity.type} ${entity.name} (${entity.id})`;
    const fake = new Request("https://foundry.internal/v1/orchestrator/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal, max_roles: body?.max_roles || 3, store_artifact: true })
    });
    const res = await handleOrchestrator(fake, env, auth, {});
    const data = await res.json().catch(() => null);
    return { ok: Boolean(data?.ok || data?.run_id), orchestrator: data };
  }

  if (actionId === "export_snapshot") {
    return {
      ok: true,
      export: {
        entity_id: entity.id,
        name: entity.name,
        type: entity.type,
        props: safeParse(entity.props, {}),
        exported_at: new Date().toISOString(),
        actor
      }
    };
  }

  return { ok: false, error: "unhandled_action" };
}
