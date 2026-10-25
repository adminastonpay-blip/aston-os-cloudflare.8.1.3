// ASTON OS — Phase 2: Universal Data Pipeline & Connector Factory
// Edge ingestion gateways + zero-copy style connectors → ontology

const VERSION = "10.7.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function slugId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

export const CONNECTOR_CATALOG = [
  { id: "webhook.generic", name: "Generic Webhook Gateway", kind: "ingestion",
    description: "Dynamic webhook URL per tenant; maps JSON payload to ontology entities",
    config_schema: { secret: "string?", map_type: "string?", map_name_field: "string?" } },
  { id: "webhook.shopify", name: "Shopify Webhook", kind: "ingestion",
    description: "Orders, customers, products → ontology (HMAC optional)",
    config_schema: { secret: "string?" } },
  { id: "http.json", name: "HTTP JSON Source", kind: "zero_copy",
    description: "Fetch remote JSON URL and project into ontology without storing raw blob",
    config_schema: { url: "string", headers: "object?", path: "string?" } },
  { id: "r2.objects", name: "R2 / S3-compatible Objects", kind: "zero_copy",
    description: "List/get objects from ASTON_R2; transform metadata + optional text to entities",
    config_schema: { prefix: "string?", max_keys: "number?" } },
  { id: "csv.upload", name: "CSV Ingest", kind: "ingestion",
    description: "Parse CSV body into records + entities",
    config_schema: { name_field: "string?", type_field: "string?", sector: "string?" } },
  { id: "json.batch", name: "JSON Batch Ingest", kind: "ingestion",
    description: "Array of items → records + ontology",
    config_schema: { default_type: "string?", sector: "string?" } },
  { id: "d1.query", name: "D1 Projection (internal)", kind: "zero_copy",
    description: "Project existing D1 tables into ontology view without duplicating rows",
    config_schema: { table: "string", name_col: "string?", type_col: "string?", limit: "number?" } }
];

export async function ensureConnectorSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, connector_type TEXT NOT NULL, name TEXT NOT NULL,
      config TEXT, status TEXT NOT NULL DEFAULT 'active', webhook_token TEXT,
      last_run_at TEXT, last_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_connectors_tenant ON connectors (tenant, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS connector_runs (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, connector_id TEXT, connector_type TEXT NOT NULL,
      status TEXT NOT NULL, stats TEXT, error TEXT, actor TEXT, created_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_connector_runs ON connector_runs (tenant, created_at)")
  ]);
}

async function upsertEntity(db, tenant, { type, name, props, source }) {
  const ename = String(name || "").trim().slice(0, 500);
  if (!ename) return null;
  const etype = String(type || "other").toLowerCase().slice(0, 40);
  const now = new Date().toISOString();
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS ontology_entities (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      props TEXT, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
  } catch (_) {}
  const existing = await db.prepare(
    "SELECT id FROM ontology_entities WHERE tenant = ? AND type = ? AND lower(name) = lower(?) LIMIT 1"
  ).bind(tenant, etype, ename).first();
  if (existing?.id) {
    await db.prepare(
      "UPDATE ontology_entities SET props = ?, source = COALESCE(?, source), updated_at = ? WHERE tenant = ? AND id = ?"
    ).bind(JSON.stringify(props || {}), source || null, now, tenant, existing.id).run();
    return existing.id;
  }
  const id = slugId("ent");
  await db.prepare(
    "INSERT INTO ontology_entities (id, tenant, type, name, props, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, tenant, etype, ename, JSON.stringify(props || {}), source || null, now, now).run();
  return id;
}

async function upsertRecord(db, tenant, sector, payload, text) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, sector TEXT NOT NULL, payload TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
  } catch (_) {}
  const id = slugId("rec");
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT INTO records (id, tenant, sector, payload, text, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, tenant, sector || "primary", JSON.stringify(payload || {}), String(text || "").slice(0, 4000), now).run();
  return id;
}

function normalizeItem(item, defaults = {}) {
  if (!item || typeof item !== "object") return null;
  const name = item.name || item.title || item.email || item.id || item.sku || item.key || null;
  const type = item.type || item.entity_type || defaults.type || "other";
  const text = item.text || item.description || item.body || [name, item.email].filter(Boolean).join(" ");
  return {
    name: name ? String(name) : null,
    type: String(type),
    text: String(text || ""),
    props: item.props && typeof item.props === "object" ? item.props : { ...item },
    sector: item.sector || defaults.sector || "primary"
  };
}

async function ingestItems(env, tenant, items, source, opts = {}) {
  const db = env.ASTON_DB;
  const stats = { records: 0, entities: 0, skipped: 0 };
  for (const raw of items.slice(0, opts.max || 200)) {
    const n = normalizeItem(raw, opts.defaults || {});
    if (!n || (!n.name && !n.text)) { stats.skipped++; continue; }
    await upsertRecord(db, tenant, n.sector, { ...n.props, _source: source }, n.text || n.name);
    stats.records++;
    if (n.name) {
      const eid = await upsertEntity(db, tenant, { type: n.type, name: n.name, props: n.props, source });
      if (eid) stats.entities++;
    }
  }
  return stats;
}

function parseCsv(text, maxRows = 500) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { rows: [] };
  const split = (line) => {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === "," && !q) { out.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    out.push(cur.trim()); return out;
  };
  const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_") || "col");
  const rows = [];
  for (let i = 1; i < lines.length && rows.length < maxRows; i++) {
    const cols = split(lines[i]); const obj = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ""; });
    rows.push(obj);
  }
  return { rows };
}

function getByPath(obj, path) {
  if (!path) return obj;
  return String(path).split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
}

async function runHttpJson(env, tenant, config) {
  const url = config?.url;
  if (!url || typeof url !== "string") throw new Error("url_required");
  const headers = config.headers && typeof config.headers === "object" ? config.headers : {};
  const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`upstream_${res.status}`);
  const data = await res.json();
  let arr = getByPath(data, config.path);
  if (!Array.isArray(arr)) {
    if (arr && typeof arr === "object") arr = [arr];
    else if (Array.isArray(data)) arr = data;
    else arr = [data];
  }
  return ingestItems(env, tenant, arr, `http:${url.slice(0, 80)}`, {
    max: Math.min(300, Number(config.max) || 100),
    defaults: { type: config.default_type || "other", sector: config.sector || "primary" }
  });
}

async function runR2(env, tenant, config) {
  if (!env.ASTON_R2) throw new Error("r2_unavailable");
  const prefix = config?.prefix || "";
  const maxKeys = Math.min(100, Number(config?.max_keys) || 20);
  const listed = await env.ASTON_R2.list({ prefix, limit: maxKeys });
  const objects = listed.objects || [];
  const items = objects.map((o) => ({
    type: "document", name: o.key,
    props: { key: o.key, size: o.size, uploaded: o.uploaded?.toISOString?.() || null },
    text: `R2 object ${o.key}`, sector: "infrastructure"
  }));
  for (const o of objects.slice(0, 5)) {
    if (o.size && o.size < 32000 && /\.(txt|json|md|csv)$/i.test(o.key)) {
      try {
        const obj = await env.ASTON_R2.get(o.key);
        if (obj) {
          const text = await obj.text();
          items.push({ type: "document", name: o.key + ":content", props: { key: o.key, preview: true }, text: text.slice(0, 3000), sector: "infrastructure" });
        }
      } catch (_) {}
    }
  }
  return ingestItems(env, tenant, items, "r2", { max: items.length });
}

async function runD1Projection(env, tenant, config) {
  const db = env.ASTON_DB;
  const table = String(config?.table || "records").replace(/[^a-z0-9_]/gi, "");
  const limit = Math.min(200, Number(config?.limit) || 50);
  const allowed = new Set(["records", "ontology_entities", "cases", "media"]);
  if (!allowed.has(table)) throw new Error("table_not_allowed");
  const rows = await db.prepare(`SELECT * FROM ${table} WHERE tenant = ? LIMIT ?`).bind(tenant, limit).all();
  const results = rows.results || [];
  const nameCol = config?.name_col || (table === "ontology_entities" ? "name" : "id");
  const typeCol = config?.type_col || (table === "ontology_entities" ? "type" : null);
  const items = results.map((r) => ({
    name: r[nameCol] || r.id, type: (typeCol && r[typeCol]) || "record",
    props: r, text: r.text || r.title || r.name || r.id, sector: r.sector || "primary"
  }));
  if (table === "ontology_entities") {
    return { records: 0, entities: results.length, skipped: 0, projected: true, sample: items.slice(0, 5) };
  }
  return ingestItems(env, tenant, items, `d1:${table}`, { max: items.length });
}

async function runConnector(env, tenant, connectorType, config, actor) {
  switch (connectorType) {
    case "http.json": return runHttpJson(env, tenant, config || {});
    case "r2.objects": return runR2(env, tenant, config || {});
    case "d1.query": return runD1Projection(env, tenant, config || {});
    case "json.batch": {
      const items = Array.isArray(config?.items) ? config.items : [];
      return ingestItems(env, tenant, items, "json.batch", {
        max: 200, defaults: { type: config?.default_type || "other", sector: config?.sector || "primary" }
      });
    }
    case "csv.upload": {
      const { rows } = parseCsv(config?.csv || config?.text || "", 500);
      const nameField = config?.name_field || "name";
      const typeField = config?.type_field || "type";
      const items = rows.map((r) => ({
        name: r[nameField] || r.name || r.title || Object.values(r)[0],
        type: r[typeField] || config?.default_type || "other",
        props: r, text: Object.values(r).join(" "), sector: config?.sector || "primary"
      }));
      return ingestItems(env, tenant, items, "csv", { max: items.length });
    }
    default: throw new Error(`unsupported_connector:${connectorType}`);
  }
}

function bearer(request) {
  const v = request.headers.get("Authorization") || "";
  return v.startsWith("Bearer ") ? v.slice(7).trim() : "";
}

async function simpleAuth(request, env) {
  const token = bearer(request);
  if (!token) return null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    return {
      tenant: request.headers.get("X-Tenant") || "default",
      actor: request.headers.get("X-Aston-Actor") || "api-token",
      scopes: ["read", "write", "admin"]
    };
  }
  return {
    tenant: request.headers.get("X-Tenant") || "default",
    actor: "token",
    scopes: ["read", "write"]
  };
}

export async function handleConnectors(request, env, path, method, cors = {}) {
  const url = new URL(request.url);

  if (method === "GET" && (path === "/v1/connectors/catalog" || path === "/v1/connectors")) {
    return json({
      ok: true, phase: "2-connectors", version: VERSION, catalog: CONNECTOR_CATALOG,
      endpoints: {
        catalog: "GET /v1/connectors/catalog", list: "GET /v1/connectors/list",
        create: "POST /v1/connectors", run: "POST /v1/connectors/:id/run",
        webhook: "POST /v1/connectors/webhook/:token",
        zero_copy_http: "POST /v1/connectors/run/http",
        zero_copy_r2: "POST /v1/connectors/run/r2", status: "GET /v1/connectors/status"
      }
    }, 200, cors);
  }

  if (method === "GET" && path === "/v1/connectors/status") {
    return json({
      ok: true, phase: "2-connectors", version: VERSION,
      bindings: { d1: Boolean(env.ASTON_DB), r2: Boolean(env.ASTON_R2), kv: Boolean(env.ASTON_KV), vectorize: Boolean(env.VECTORIZE) },
      catalog_count: CONNECTOR_CATALOG.length
    }, 200, cors);
  }

  if (method === "POST" && path.startsWith("/v1/connectors/webhook/")) {
    const token = path.split("/").pop();
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
    await ensureConnectorSchema(env.ASTON_DB);
    const row = await env.ASTON_DB.prepare(
      "SELECT id, tenant, connector_type, config, name FROM connectors WHERE webhook_token = ? AND status = 'active' LIMIT 1"
    ).bind(token).first();
    if (!row) return json({ ok: false, error: "webhook_not_found" }, 404, cors);
    let config = {}; try { config = JSON.parse(row.config || "{}"); } catch (_) {}
    const body = await readJson(request);
    const mapType = config.map_type || "event";
    const nameField = config.map_name_field || "name";
    let items = [];
    if (Array.isArray(body)) items = body;
    else if (Array.isArray(body?.items)) items = body.items;
    else if (body && typeof body === "object") {
      items = [{ type: mapType, name: body[nameField] || body.id || body.event || body.type || slugId("evt"), props: body, text: JSON.stringify(body).slice(0, 1500) }];
    }
    const stats = await ingestItems(env, row.tenant, items, `webhook:${row.name}`, { max: 100 });
    const runId = slugId("crun"); const now = new Date().toISOString();
    await env.ASTON_DB.prepare(
      "INSERT INTO connector_runs (id, tenant, connector_id, connector_type, status, stats, error, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)"
    ).bind(runId, row.tenant, row.id, row.connector_type, "done", JSON.stringify(stats), "webhook", now).run();
    await env.ASTON_DB.prepare("UPDATE connectors SET last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?").bind(now, "done", now, row.id).run();
    return json({ ok: true, run_id: runId, connector_id: row.id, stats }, 200, cors);
  }

  const auth = await simpleAuth(request, env);
  if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  const tenant = auth.tenant; const actor = auth.actor; const db = env.ASTON_DB;
  await ensureConnectorSchema(db);

  if (method === "GET" && path === "/v1/connectors/list") {
    const rows = await db.prepare(
      "SELECT id, connector_type, name, status, webhook_token, last_run_at, last_status, created_at, updated_at FROM connectors WHERE tenant = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(tenant).all();
    return json({ ok: true, connectors: rows.results || [] }, 200, cors);
  }

  if (method === "GET" && path === "/v1/connectors/runs") {
    const limit = Math.min(30, Number(url.searchParams.get("limit") || 15));
    const rows = await db.prepare(
      "SELECT id, connector_id, connector_type, status, stats, error, actor, created_at FROM connector_runs WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(tenant, limit).all();
    return json({ ok: true, runs: rows.results || [] }, 200, cors);
  }

  if (method === "POST" && path === "/v1/connectors") {
    const body = await readJson(request);
    const connectorType = body?.connector_type || body?.type;
    if (!connectorType || !CONNECTOR_CATALOG.find((c) => c.id === connectorType)) {
      return json({ ok: false, error: "invalid_connector_type", catalog: CONNECTOR_CATALOG.map((c) => c.id) }, 400, cors);
    }
    const id = slugId("conn"); const now = new Date().toISOString();
    const name = String(body?.name || connectorType).slice(0, 200);
    const config = body?.config || {};
    const webhookToken = connectorType.startsWith("webhook.") ? crypto.randomUUID().replace(/-/g, "") : null;
    await db.prepare(
      "INSERT INTO connectors (id, tenant, connector_type, name, config, status, webhook_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"
    ).bind(id, tenant, connectorType, name, JSON.stringify(config), webhookToken, now, now).run();
    const webhookUrl = webhookToken ? `${url.origin}/v1/connectors/webhook/${webhookToken}` : null;
    return json({ ok: true, id, connector_type: connectorType, name, webhook_url: webhookUrl, webhook_token: webhookToken }, 201, cors);
  }

  if (method === "POST" && path === "/v1/connectors/run/http") {
    const body = await readJson(request);
    try { const stats = await runHttpJson(env, tenant, body || {}); return json({ ok: true, connector_type: "http.json", stats }, 200, cors); }
    catch (e) { return json({ ok: false, error: String(e.message || e).slice(0, 200) }, 400, cors); }
  }
  if (method === "POST" && path === "/v1/connectors/run/r2") {
    const body = await readJson(request);
    try { const stats = await runR2(env, tenant, body || {}); return json({ ok: true, connector_type: "r2.objects", stats }, 200, cors); }
    catch (e) { return json({ ok: false, error: String(e.message || e).slice(0, 200) }, 400, cors); }
  }
  if (method === "POST" && path === "/v1/connectors/run/d1") {
    const body = await readJson(request);
    try { const stats = await runD1Projection(env, tenant, body || {}); return json({ ok: true, connector_type: "d1.query", stats }, 200, cors); }
    catch (e) { return json({ ok: false, error: String(e.message || e).slice(0, 200) }, 400, cors); }
  }

  const runMatch = path.match(/^\/v1\/connectors\/([^/]+)\/run$/);
  if (method === "POST" && runMatch) {
    const id = runMatch[1];
    const row = await db.prepare("SELECT * FROM connectors WHERE tenant = ? AND id = ? LIMIT 1").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    let config = {}; try { config = JSON.parse(row.config || "{}"); } catch (_) {}
    const body = await readJson(request);
    if (body?.config) config = { ...config, ...body.config };
    if (body?.items) config.items = body.items;
    if (body?.csv) config.csv = body.csv;
    const runId = slugId("crun"); const now = new Date().toISOString();
    try {
      const stats = await runConnector(env, tenant, row.connector_type, config, actor);
      await db.prepare(
        "INSERT INTO connector_runs (id, tenant, connector_id, connector_type, status, stats, error, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)"
      ).bind(runId, tenant, id, row.connector_type, "done", JSON.stringify(stats), actor, now).run();
      await db.prepare("UPDATE connectors SET last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?").bind(now, "done", now, id).run();
      return json({ ok: true, run_id: runId, connector_id: id, stats }, 200, cors);
    } catch (e) {
      await db.prepare(
        "INSERT INTO connector_runs (id, tenant, connector_id, connector_type, status, stats, error, actor, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)"
      ).bind(runId, tenant, id, row.connector_type, "failed", String(e.message || e).slice(0, 500), actor, now).run();
      return json({ ok: false, error: String(e.message || e).slice(0, 200), run_id: runId }, 400, cors);
    }
  }

  const delMatch = path.match(/^\/v1\/connectors\/([^/]+)$/);
  if (method === "DELETE" && delMatch) {
    await db.prepare("UPDATE connectors SET status = 'deleted', updated_at = ? WHERE tenant = ? AND id = ?")
      .bind(new Date().toISOString(), tenant, delMatch[1]).run();
    return json({ ok: true, deleted: delMatch[1] }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
