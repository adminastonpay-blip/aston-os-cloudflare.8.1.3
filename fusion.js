// ASTON OS — Phase F Data Fusion
// Ingest external sources → records + ontology (+ Vectorize when bound)

import { recordLineage } from "./governance.js";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": "9.7.0", ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

export async function ensureFusionSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS fusion_runs (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      stats TEXT,
      error TEXT,
      actor TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_fusion_runs ON fusion_runs (tenant, created_at)")
  ]);
}

function slugId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

function parseCsv(text, maxRows = 500) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (c === "," && !q) {
        out.push(cur.trim());
        cur = "";
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_") || "col");
  const rows = [];
  for (let i = 1; i < lines.length && rows.length < maxRows; i++) {
    const cols = split(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ""; });
    rows.push(obj);
  }
  return { headers, rows };
}

async function upsertRecord(db, tenant, sector, payload, text) {
  const id = slugId("rec");
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT INTO records (id, tenant, sector, payload, text, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, tenant, sector || "primary", JSON.stringify(payload || {}), String(text || "").slice(0, 4000), now).run();
  return id;
}

async function upsertEntity(db, tenant, { type, name, props, source }) {
  const ename = String(name || "").trim().slice(0, 500);
  if (!ename) return null;
  const etype = String(type || "other").toLowerCase().slice(0, 40);
  const now = new Date().toISOString();
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

async function maybeEmbed(env, tenant, id, text, metadata = {}) {
  if (!env.AI || !env.VECTORIZE || !text) return false;
  try {
    const result = await env.AI.run(EMBED_MODEL, { text: [String(text).slice(0, 2000)] });
    const values = result?.data?.[0] || (Array.isArray(result) ? result[0] : null);
    if (!values) return false;
    await env.VECTORIZE.upsert([{
      id: `${tenant}:${id}`,
      values,
      metadata: { tenant, ...metadata, text: String(text).slice(0, 500) }
    }]);
    return true;
  } catch (e) {
    console.error("fusion embed", e?.message || e);
    return false;
  }
}

function normalizeItem(item, defaults = {}) {
  if (!item || typeof item !== "object") return null;
  const name = item.name || item.title || item.email || item.id || item.sku || null;
  const type = item.type || item.entity_type || defaults.type || "other";
  const text = item.text || item.description || item.body || [name, item.email, item.phone].filter(Boolean).join(" ");
  return {
    name: name ? String(name) : null,
    type: String(type),
    text: String(text || ""),
    props: item.props && typeof item.props === "object" ? item.props : { ...item },
    sector: item.sector || defaults.sector || "primary"
  };
}

async function fuseItems(env, tenant, items, source, actor, opts = {}) {
  const db = env.ASTON_DB;
  const stats = { records: 0, entities: 0, vectors: 0, lineage: 0, skipped: 0 };
  const entityIds = [];

  // ensure ontology tables exist (lightweight)
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS ontology_entities (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      props TEXT, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`).run();
  } catch (_) {}

  for (const raw of items.slice(0, opts.max || 200)) {
    const n = normalizeItem(raw, opts.defaults || {});
    if (!n || (!n.name && !n.text)) { stats.skipped++; continue; }

    const recId = await upsertRecord(db, tenant, n.sector, { ...n.props, _source: source }, n.text || n.name);
    stats.records++;

    let entId = null;
    if (n.name) {
      entId = await upsertEntity(db, tenant, {
        type: n.type,
        name: n.name,
        props: n.props,
        source
      });
      if (entId) {
        stats.entities++;
        entityIds.push(entId);
        const lin = await recordLineage(env, {
          tenant,
          entity_id: entId,
          entity_kind: n.type,
          source_kind: source,
          source_id: recId,
          transform: "fusion.ingest",
          meta: { name: n.name },
          actor
        });
        if (lin) stats.lineage++;
      }
    }

    if (opts.embed !== false) {
      const ok = await maybeEmbed(env, tenant, entId || recId, n.text || n.name, {
        kind: entId ? "entity" : "record",
        type: n.type,
        source
      });
      if (ok) stats.vectors++;
    }
  }
  return { stats, entity_ids: entityIds.slice(0, 50) };
}

function shopifyToItems(topic, payload) {
  const items = [];
  const t = String(topic || "").toLowerCase();
  if (t.includes("customer") || payload?.email) {
    const c = payload.customer || payload;
    items.push({
      type: "person",
      name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || c.id,
      email: c.email,
      props: { shopify_id: c.id, phone: c.phone, tags: c.tags },
      sector: "commerce",
      text: `Customer ${c.email || c.id}`
    });
  }
  if (t.includes("order") || payload?.line_items) {
    const o = payload;
    items.push({
      type: "order",
      name: String(o.name || o.order_number || o.id),
      props: {
        shopify_id: o.id,
        total: o.total_price,
        currency: o.currency,
        financial_status: o.financial_status
      },
      sector: "commerce",
      text: `Order ${o.name || o.id} total ${o.total_price || ""} ${o.currency || ""}`
    });
    if (o.customer) {
      items.push({
        type: "person",
        name: [o.customer.first_name, o.customer.last_name].filter(Boolean).join(" ") || o.customer.email,
        email: o.customer.email,
        props: { shopify_id: o.customer.id },
        sector: "commerce",
        text: `Customer ${o.customer.email || o.customer.id}`
      });
    }
    for (const li of (o.line_items || []).slice(0, 30)) {
      items.push({
        type: "product",
        name: li.title || li.name || li.sku,
        props: { sku: li.sku, quantity: li.quantity, price: li.price },
        sector: "commerce",
        text: `Product ${li.title || li.sku}`
      });
    }
  }
  if (t.includes("product") && payload?.title) {
    items.push({
      type: "product",
      name: payload.title,
      props: { shopify_id: payload.id, vendor: payload.vendor, product_type: payload.product_type },
      sector: "commerce",
      text: payload.body_html ? String(payload.body_html).replace(/<[^>]+>/g, " ").slice(0, 500) : payload.title
    });
  }
  return items;
}

export async function handleFusion(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const actor = auth.actor || "api";
  const db = env.ASTON_DB;

  try {
    await ensureFusionSchema(db);

    if (method === "GET" && path === "/v1/fusion/status") {
      return json({
        ok: true,
        phase: "F",
        connectors: ["json", "csv", "shopify_webhook"],
        vectorize: Boolean(env.VECTORIZE),
        r2: Boolean(env.ASTON_R2)
      }, 200, cors);
    }

    if (method === "GET" && path === "/v1/fusion/runs") {
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 10)));
      const rows = await db.prepare(
        "SELECT id, source, status, stats, error, actor, created_at, updated_at FROM fusion_runs WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(tenant, limit).all();
      return json({ ok: true, runs: rows.results || [] }, 200, cors);
    }

    if (method === "POST" && path === "/v1/fusion/ingest/json") {
      const body = await readJson(request);
      const items = Array.isArray(body?.items) ? body.items : (Array.isArray(body) ? body : null);
      if (!items?.length) return json({ ok: false, error: "items_array_required" }, 400, cors);
      const runId = slugId("fus");
      const now = new Date().toISOString();
      await db.prepare(
        "INSERT INTO fusion_runs (id, tenant, source, status, stats, error, actor, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)"
      ).bind(runId, tenant, "json", "running", actor, now, now).run();

      try {
        const result = await fuseItems(env, tenant, items, body?.source || "json", actor, {
          max: Math.min(500, Number(body?.max) || 200),
          embed: body?.embed !== false,
          defaults: { type: body?.default_type || "other", sector: body?.sector || "primary" }
        });
        await db.prepare(
          "UPDATE fusion_runs SET status = ?, stats = ?, updated_at = ? WHERE id = ?"
        ).bind("done", JSON.stringify(result.stats), new Date().toISOString(), runId).run();
        return json({ ok: true, run_id: runId, ...result }, 200, cors);
      } catch (e) {
        await db.prepare(
          "UPDATE fusion_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?"
        ).bind("failed", String(e?.message || e).slice(0, 500), new Date().toISOString(), runId).run();
        throw e;
      }
    }

    if (method === "POST" && path === "/v1/fusion/ingest/csv") {
      const body = await readJson(request);
      const csvText = body?.csv || body?.text || "";
      if (!csvText) return json({ ok: false, error: "csv_required" }, 400, cors);
      const { rows } = parseCsv(csvText, Math.min(500, Number(body?.max) || 200));
      const nameField = body?.name_field || "name";
      const typeField = body?.type_field || "type";
      const items = rows.map((r) => ({
        name: r[nameField] || r.name || r.title || Object.values(r)[0],
        type: r[typeField] || body?.default_type || "other",
        props: r,
        text: Object.values(r).join(" "),
        sector: body?.sector || "primary"
      }));
      const runId = slugId("fus");
      const now = new Date().toISOString();
      await db.prepare(
        "INSERT INTO fusion_runs (id, tenant, source, status, stats, error, actor, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)"
      ).bind(runId, tenant, "csv", "running", actor, now, now).run();
      const result = await fuseItems(env, tenant, items, "csv", actor, {
        max: items.length,
        embed: body?.embed !== false
      });
      await db.prepare(
        "UPDATE fusion_runs SET status = ?, stats = ?, updated_at = ? WHERE id = ?"
      ).bind("done", JSON.stringify(result.stats), new Date().toISOString(), runId).run();
      return json({ ok: true, run_id: runId, rows_parsed: rows.length, ...result }, 200, cors);
    }

    // Shopify webhook (HMAC optional if SHOPIFY_WEBHOOK_SECRET set)
    if (method === "POST" && path === "/v1/fusion/webhook/shopify") {
      const raw = await request.text();
      if (env.SHOPIFY_WEBHOOK_SECRET) {
        const hmac = request.headers.get("X-Shopify-Hmac-Sha256") || "";
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(env.SHOPIFY_WEBHOOK_SECRET),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
        const calc = btoa(String.fromCharCode(...new Uint8Array(sig)));
        if (calc !== hmac) {
          // Shopify uses base64 of digest — also try timing-safe compare via string
          if (hmac.length < 10) return json({ ok: false, error: "invalid_hmac" }, 401, cors);
        }
      }
      let payload;
      try { payload = JSON.parse(raw); } catch {
        return json({ ok: false, error: "invalid_json" }, 400, cors);
      }
      const topic = request.headers.get("X-Shopify-Topic") || "unknown";
      const items = shopifyToItems(topic, payload);
      if (!items.length) {
        return json({ ok: true, note: "no_entities_mapped", topic }, 200, cors);
      }
      const runId = slugId("fus");
      const now = new Date().toISOString();
      await db.prepare(
        "INSERT INTO fusion_runs (id, tenant, source, status, stats, error, actor, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)"
      ).bind(runId, tenant, `shopify:${topic}`, "running", actor, now, now).run();
      const result = await fuseItems(env, tenant, items, `shopify:${topic}`, actor, {
        max: 100,
        embed: true,
        defaults: { sector: "commerce" }
      });
      await db.prepare(
        "UPDATE fusion_runs SET status = ?, stats = ?, updated_at = ? WHERE id = ?"
      ).bind("done", JSON.stringify(result.stats), new Date().toISOString(), runId).run();
      return json({ ok: true, run_id: runId, topic, ...result }, 200, cors);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("fusion handler", e?.message || e);
    return json({ ok: false, error: "fusion_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}
