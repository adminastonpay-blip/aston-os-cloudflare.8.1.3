// ASTON OS — Phase 5: Decision Twin
// Ontology branching · what-if simulation · scenario compare · decision receipts

const VERSION = "10.10.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function bearer(request) {
  const v = request.headers.get("Authorization") || "";
  return v.startsWith("Bearer ") ? v.slice(7).trim() : "";
}

function slugId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

async function hmacSign(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret || "aston-decision-twin"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ensureTwinSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS decision_scenarios (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      base_snapshot TEXT, mutations TEXT, status TEXT NOT NULL DEFAULT 'draft',
      score REAL, result_json TEXT, actor TEXT, parent_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_twin_tenant ON decision_scenarios (tenant, status, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS decision_receipts (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, scenario_id TEXT NOT NULL,
      decision TEXT NOT NULL, payload TEXT NOT NULL, signature TEXT NOT NULL,
      actor TEXT, created_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_twin_rcpt ON decision_receipts (tenant, scenario_id)")
  ]);
}

async function snapshotOntology(env, tenant, limit = 200) {
  if (!env.ASTON_DB) return { entities: [], edges: [], note: "d1_unavailable" };
  try {
    const entities = await env.ASTON_DB.prepare(
      "SELECT id, type, name, props, updated_at FROM ontology_entities WHERE tenant = ? ORDER BY updated_at DESC LIMIT ?"
    ).bind(tenant, limit).all();
    let edges = { results: [] };
    try {
      edges = await env.ASTON_DB.prepare(
        "SELECT id, from_id, to_id, rel_type, props FROM ontology_edges WHERE tenant = ? LIMIT ?"
      ).bind(tenant, limit).all();
    } catch (_) {}
    return {
      entities: (entities.results || []).map((e) => ({
        ...e,
        props: (() => { try { return JSON.parse(e.props || "{}"); } catch { return {}; } })()
      })),
      edges: edges.results || [],
      captured_at: new Date().toISOString()
    };
  } catch (e) {
    return { entities: [], edges: [], error: String(e.message || e).slice(0, 200) };
  }
}

function applyMutations(snapshot, mutations) {
  const state = JSON.parse(JSON.stringify(snapshot || { entities: [], edges: [] }));
  const entities = state.entities || [];
  const edges = state.edges || [];
  const log = [];
  for (const m of mutations || []) {
    const op = String(m.op || m.type || "").toLowerCase();
    if (op === "set_prop") {
      const ent = entities.find((e) => e.id === m.entity_id || e.name === m.name);
      if (ent) {
        ent.props = ent.props || {};
        const before = ent.props[m.key];
        ent.props[m.key] = m.value;
        log.push({ op, entity_id: ent.id, key: m.key, before, after: m.value });
      }
    } else if (op === "scale_prop") {
      const ent = entities.find((e) => e.id === m.entity_id || e.name === m.name);
      if (ent) {
        ent.props = ent.props || {};
        const before = Number(ent.props[m.key] || 0);
        const factor = Number(m.factor ?? 1);
        ent.props[m.key] = before * factor;
        log.push({ op, entity_id: ent.id, key: m.key, before, after: ent.props[m.key], factor });
      }
    } else if (op === "add_entity") {
      const id = m.id || slugId("virt");
      entities.push({ id, type: m.entity_type || m.type || "entity", name: m.name || id, props: m.props || {}, virtual: true });
      log.push({ op, entity_id: id });
    } else if (op === "remove_entity") {
      const idx = entities.findIndex((e) => e.id === m.entity_id || e.name === m.name);
      if (idx >= 0) {
        const [removed] = entities.splice(idx, 1);
        log.push({ op, entity_id: removed.id });
      }
    } else if (op === "add_edge") {
      const id = m.id || slugId("vedge");
      edges.push({ id, from_id: m.from_id, to_id: m.to_id, rel_type: m.rel_type || "related", props: m.props || {}, virtual: true });
      log.push({ op, edge_id: id });
    } else if (op === "set_status") {
      const ent = entities.find((e) => e.id === m.entity_id || e.name === m.name);
      if (ent) {
        ent.props = ent.props || {};
        ent.props.status = m.status;
        log.push({ op, entity_id: ent.id, status: m.status });
      }
    }
  }
  state.entities = entities;
  state.edges = edges;
  return { state, log };
}

function scoreState(state, goals = {}) {
  const entities = state.entities || [];
  let risk = 0, revenue = 0, delay = 0, capacity = 0, critical = 0;
  for (const e of entities) {
    const p = e.props || {};
    if (p.risk != null) risk += Number(p.risk) || 0;
    if (p.revenue != null) revenue += Number(p.revenue) || 0;
    if (p.delay_days != null) delay += Number(p.delay_days) || 0;
    if (p.capacity != null) capacity += Number(p.capacity) || 0;
    if (String(p.status || "").toLowerCase() === "critical") critical += 1;
  }
  const weights = {
    risk: goals.risk_weight ?? -1,
    revenue: goals.revenue_weight ?? 1,
    delay: goals.delay_weight ?? -0.5,
    capacity: goals.capacity_weight ?? 0.3,
    critical: goals.critical_weight ?? -2
  };
  const score = risk * weights.risk + revenue * weights.revenue + delay * weights.delay +
    capacity * weights.capacity + critical * weights.critical;
  return {
    score: Math.round(score * 1000) / 1000,
    metrics: { risk, revenue, delay_days: delay, capacity, critical_count: critical, entity_count: entities.length },
    weights
  };
}

async function simpleAuth(request, env) {
  const token = bearer(request);
  if (!token) return null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    return { tenant: request.headers.get("X-Tenant") || "default", actor: request.headers.get("X-Aston-Actor") || "api-token", scopes: ["read", "write", "ai", "admin"] };
  }
  return { tenant: request.headers.get("X-Tenant") || "default", actor: "token", scopes: ["read", "write"] };
}

export async function handleDecisionTwin(request, env, path, method, cors = {}) {
  const url = new URL(request.url);

  if (method === "GET" && path === "/v1/twin/status") {
    return json({
      ok: true, phase: "5-decision-twin", version: VERSION,
      endpoints: {
        status: "GET /v1/twin/status", scenarios: "GET|POST /v1/twin/scenarios",
        scenario: "GET /v1/twin/scenarios/:id", simulate: "POST /v1/twin/scenarios/:id/simulate",
        compare: "POST /v1/twin/compare", snapshot: "POST /v1/twin/snapshot",
        receipt: "GET /v1/twin/receipts/:id", decide: "POST /v1/twin/scenarios/:id/decide"
      }
    }, 200, cors);
  }

  const auth = await simpleAuth(request, env);
  if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureTwinSchema(env.ASTON_DB);
  const db = env.ASTON_DB;
  const tenant = auth.tenant;

  if (method === "POST" && path === "/v1/twin/snapshot") {
    const snap = await snapshotOntology(env, tenant);
    return json({ ok: true, tenant, snapshot: snap }, 200, cors);
  }

  if (method === "GET" && path === "/v1/twin/scenarios") {
    const limit = Math.min(50, Number(url.searchParams.get("limit") || 20));
    const rows = await db.prepare(
      "SELECT id, name, description, status, score, actor, parent_id, created_at, updated_at FROM decision_scenarios WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(tenant, limit).all();
    return json({ ok: true, scenarios: rows.results || [] }, 200, cors);
  }

  if (method === "POST" && path === "/v1/twin/scenarios") {
    const body = await readJson(request);
    const name = String(body?.name || "scenario").slice(0, 120);
    const description = body?.description ? String(body.description).slice(0, 500) : null;
    const mutations = Array.isArray(body?.mutations) ? body.mutations : [];
    const parentId = body?.parent_id || null;
    let base = body?.base_snapshot || null;
    if (!base) {
      if (parentId) {
        const parent = await db.prepare(
          "SELECT base_snapshot, result_json FROM decision_scenarios WHERE tenant = ? AND id = ?"
        ).bind(tenant, parentId).first();
        if (parent?.result_json) {
          try { base = JSON.parse(parent.result_json)?.state || JSON.parse(parent.base_snapshot); } catch { base = null; }
        }
        if (!base && parent?.base_snapshot) { try { base = JSON.parse(parent.base_snapshot); } catch { base = null; } }
      }
      if (!base) base = await snapshotOntology(env, tenant);
    }
    const id = slugId("scn");
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO decision_scenarios (id, tenant, name, description, base_snapshot, mutations, status, score, result_json, actor, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, ?, ?, ?)`
    ).bind(id, tenant, name, description, JSON.stringify(base), JSON.stringify(mutations), auth.actor, parentId, now, now).run();
    return json({ ok: true, id, name, status: "draft", mutations_count: mutations.length, base_entities: (base.entities || []).length }, 201, cors);
  }

  const scnMatch = path.match(/^\/v1\/twin\/scenarios\/([^/]+)$/);
  if (method === "GET" && scnMatch) {
    const id = scnMatch[1];
    const row = await db.prepare("SELECT * FROM decision_scenarios WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    let base_snapshot = null, mutations = [], result = null;
    try { base_snapshot = JSON.parse(row.base_snapshot || "null"); } catch {}
    try { mutations = JSON.parse(row.mutations || "[]"); } catch {}
    try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
    return json({ ok: true, scenario: {
      id: row.id, name: row.name, description: row.description, status: row.status, score: row.score,
      actor: row.actor, parent_id: row.parent_id, created_at: row.created_at, updated_at: row.updated_at,
      mutations, base_snapshot, result
    }}, 200, cors);
  }

  const simMatch = path.match(/^\/v1\/twin\/scenarios\/([^/]+)\/simulate$/);
  if (method === "POST" && simMatch) {
    const id = simMatch[1];
    const body = await readJson(request) || {};
    const row = await db.prepare("SELECT * FROM decision_scenarios WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    let base = {}, mutations = [];
    try { base = JSON.parse(row.base_snapshot || "{}"); } catch {}
    try { mutations = JSON.parse(row.mutations || "[]"); } catch {}
    if (Array.isArray(body.mutations) && body.mutations.length) mutations = [...mutations, ...body.mutations];
    const t0 = Date.now();
    const { state, log } = applyMutations(base, mutations);
    const scoring = scoreState(state, body.goals || {});
    const now = new Date().toISOString();
    const result = { state: { entities: state.entities, edges: state.edges, entity_count: (state.entities || []).length }, mutation_log: log, scoring, simulated_at: now, latency_ms: Date.now() - t0 };
    await db.prepare(
      "UPDATE decision_scenarios SET status = ?, score = ?, result_json = ?, mutations = ?, updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind("simulated", scoring.score, JSON.stringify(result), JSON.stringify(mutations), now, tenant, id).run();
    const receiptId = slugId("drcpt");
    const payload = JSON.stringify({ scenario_id: id, tenant, score: scoring.score, metrics: scoring.metrics, mutations, simulated_at: now, actor: auth.actor });
    const signature = await hmacSign(env.ASTON_RECEIPT_SECRET || env.ASTON_JWT_SECRET || env.ASTON_API_TOKEN, payload);
    await db.prepare(
      "INSERT INTO decision_receipts (id, tenant, scenario_id, decision, payload, signature, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(receiptId, tenant, id, body.decision || "simulate", payload, signature, auth.actor, now).run();
    return json({ ok: true, scenario_id: id, score: scoring.score, metrics: scoring.metrics, mutation_log: log, latency_ms: result.latency_ms, receipt_id: receiptId, signature: signature.slice(0, 16) + "…" }, 200, cors);
  }

  if (method === "POST" && path === "/v1/twin/compare") {
    const body = await readJson(request);
    const ids = Array.isArray(body?.scenario_ids) ? body.scenario_ids.slice(0, 10) : [];
    if (ids.length < 2) return json({ ok: false, error: "need_at_least_2_scenario_ids" }, 400, cors);
    const compared = [];
    for (const id of ids) {
      const row = await db.prepare(
        "SELECT id, name, status, score, result_json FROM decision_scenarios WHERE tenant = ? AND id = ?"
      ).bind(tenant, id).first();
      if (!row) { compared.push({ id, error: "not_found" }); continue; }
      let metrics = null;
      try { metrics = JSON.parse(row.result_json || "{}")?.scoring?.metrics || null; } catch {}
      compared.push({ id: row.id, name: row.name, status: row.status, score: row.score, metrics });
    }
    const ranked = compared.filter((c) => c.score != null).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    return json({ ok: true, compared, winner: ranked[0] || null, ranking: ranked.map((r) => r.id) }, 200, cors);
  }

  const rcptMatch = path.match(/^\/v1\/twin\/receipts\/([^/]+)$/);
  if (method === "GET" && rcptMatch) {
    const id = rcptMatch[1];
    const row = await db.prepare("SELECT * FROM decision_receipts WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    return json({ ok: true, receipt: row }, 200, cors);
  }

  const decideMatch = path.match(/^\/v1\/twin\/scenarios\/([^/]+)\/decide$/);
  if (method === "POST" && decideMatch) {
    const id = decideMatch[1];
    const body = await readJson(request) || {};
    const row = await db.prepare("SELECT id, status, score FROM decision_scenarios WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    if (row.status !== "simulated" && body.force !== true)
      return json({ ok: false, error: "simulate_first", status: row.status }, 409, cors);
    const now = new Date().toISOString();
    const decision = String(body.decision || "approve").slice(0, 80);
    await db.prepare("UPDATE decision_scenarios SET status = ?, updated_at = ? WHERE tenant = ? AND id = ?")
      .bind(decision === "reject" ? "rejected" : "decided", now, tenant, id).run();
    const payload = JSON.stringify({ scenario_id: id, tenant, decision, score: row.score, actor: auth.actor, at: now });
    const signature = await hmacSign(env.ASTON_RECEIPT_SECRET || env.ASTON_JWT_SECRET || env.ASTON_API_TOKEN, payload);
    const receiptId = slugId("drcpt");
    await db.prepare(
      "INSERT INTO decision_receipts (id, tenant, scenario_id, decision, payload, signature, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(receiptId, tenant, id, decision, payload, signature, auth.actor, now).run();
    return json({ ok: true, scenario_id: id, decision, receipt_id: receiptId, note: "Virtual branch only — live ontology not mutated." }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
