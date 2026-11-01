// ASTON OS — Phase 8 Lineage & Audit Export
// Unified decision provenance: receipts + entity history + AIP + pipeline runs

const VERSION = "12.1.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

function safeParse(s, fb) {
  try { return s ? JSON.parse(s) : fb; } catch { return fb; }
}

export async function ensureLineageSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS lineage (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      entity_id TEXT,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      transform TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lineage_ent ON lineage (tenant, entity_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit_packages (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL
    )`)
  ]);
}

function slugId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

/** Record a lineage edge (best-effort) */
export async function recordLineage(env, {
  tenant,
  entity_id = null,
  source_kind,
  source_id = null,
  transform = null,
  actor = "system"
}) {
  if (!env?.ASTON_DB) return null;
  try {
    await ensureLineageSchema(env.ASTON_DB);
    const id = slugId("lin");
    await env.ASTON_DB.prepare(
      `INSERT INTO lineage (id, tenant, entity_id, source_kind, source_id, transform, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, tenant, entity_id, String(source_kind).slice(0, 80),
      source_id ? String(source_id).slice(0, 120) : null,
      transform ? String(transform).slice(0, 500) : null,
      actor, new Date().toISOString()
    ).run();
    return id;
  } catch (e) {
    console.error("recordLineage", e?.message || e);
    return null;
  }
}

async function collectSubjectTimeline(db, tenant, subjectId, limit = 50) {
  const events = [];

  // Truth receipts
  try {
    const rows = await db.prepare(
      `SELECT id, kind, subject_id, actor, summary, decision, signature, created_at
       FROM truth_receipts WHERE tenant = ? AND (subject_id = ? OR id = ?)
       ORDER BY created_at DESC LIMIT ?`
    ).bind(tenant, subjectId, subjectId, limit).all();
    for (const r of rows.results || []) {
      events.push({
        source: "truth_receipt",
        id: r.id,
        kind: r.kind,
        actor: r.actor,
        summary: r.summary,
        at: r.created_at,
        signature: r.signature ? String(r.signature).slice(0, 24) + "…" : null
      });
    }
  } catch (_) {}

  // Entity history
  try {
    const rows = await db.prepare(
      `SELECT id, action, actor, created_at FROM entity_history
       WHERE tenant = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(tenant, subjectId, limit).all();
    for (const r of rows.results || []) {
      events.push({
        source: "entity_history",
        id: r.id,
        kind: r.action,
        actor: r.actor,
        at: r.created_at
      });
    }
  } catch (_) {}

  // Lineage table
  try {
    const rows = await db.prepare(
      `SELECT id, source_kind, source_id, transform, actor, created_at FROM lineage
       WHERE tenant = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(tenant, subjectId, limit).all();
    for (const r of rows.results || []) {
      events.push({
        source: "lineage",
        id: r.id,
        kind: r.source_kind,
        ref: r.source_id,
        transform: r.transform,
        actor: r.actor,
        at: r.created_at
      });
    }
  } catch (_) {}

  // AIP plans
  try {
    const rows = await db.prepare(
      `SELECT id, goal, status, orchestrator_run_id, receipt_id, created_at, updated_at
       FROM aip_plans WHERE tenant = ? AND (id = ? OR orchestrator_run_id = ?)
       ORDER BY created_at DESC LIMIT 20`
    ).bind(tenant, subjectId, subjectId).all();
    for (const r of rows.results || []) {
      events.push({
        source: "aip_plan",
        id: r.id,
        kind: r.status,
        summary: r.goal,
        ref: r.orchestrator_run_id,
        at: r.updated_at || r.created_at
      });
    }
  } catch (_) {}

  // Pipeline runs
  try {
    const rows = await db.prepare(
      `SELECT id, template_id, status, stats, created_at, finished_at
       FROM pipeline_runs WHERE tenant = ? AND id = ? LIMIT 5`
    ).bind(tenant, subjectId).all();
    for (const r of rows.results || []) {
      events.push({
        source: "pipeline_run",
        id: r.id,
        kind: r.template_id,
        summary: r.status,
        at: r.finished_at || r.created_at,
        stats: safeParse(r.stats, null)
      });
    }
  } catch (_) {}

  events.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return events.slice(0, limit);
}

async function buildAuditPackage(db, tenant, { since_hours = 24, include_metrics = true } = {}) {
  const since = new Date(Date.now() - since_hours * 3600 * 1000).toISOString();
  const pack = {
    version: VERSION,
    tenant,
    generated_at: new Date().toISOString(),
    window_hours: since_hours,
    sections: {}
  };

  try {
    const receipts = await db.prepare(
      `SELECT id, kind, subject_id, actor, summary, signature, alg, created_at
       FROM truth_receipts WHERE tenant = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200`
    ).bind(tenant, since).all();
    pack.sections.truth_receipts = receipts.results || [];
  } catch (_) {
    pack.sections.truth_receipts = [];
  }

  try {
    const hist = await db.prepare(
      `SELECT id, entity_id, action, actor, created_at FROM entity_history
       WHERE tenant = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200`
    ).bind(tenant, since).all();
    pack.sections.entity_history = hist.results || [];
  } catch (_) {
    pack.sections.entity_history = [];
  }

  try {
    const aip = await db.prepare(
      `SELECT id, goal, status, roles, orchestrator_run_id, receipt_id, requested_by, decided_by, created_at, updated_at
       FROM aip_plans WHERE tenant = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 100`
    ).bind(tenant, since).all();
    pack.sections.aip_plans = aip.results || [];
  } catch (_) {
    pack.sections.aip_plans = [];
  }

  try {
    const pipes = await db.prepare(
      `SELECT id, template_id, status, stats, actor, created_at, finished_at
       FROM pipeline_runs WHERE tenant = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 100`
    ).bind(tenant, since).all();
    pack.sections.pipeline_runs = pipes.results || [];
  } catch (_) {
    pack.sections.pipeline_runs = [];
  }

  try {
    const sec = await db.prepare(
      `SELECT id, actor, action, resource, created_at FROM security_audit
       WHERE tenant = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 100`
    ).bind(tenant, since).all();
    pack.sections.security_audit = sec.results || [];
  } catch (_) {
    pack.sections.security_audit = [];
  }

  if (include_metrics) {
    try {
      const m = await db.prepare(
        `SELECT path_group, SUM(count) AS c, SUM(errors) AS e, SUM(sum_ms) AS sum_ms
         FROM metrics_hourly WHERE tenant = ? AND hour >= ?
         GROUP BY path_group`
      ).bind(tenant, since.slice(0, 13)).all();
      pack.sections.metrics_by_group = m.results || [];
    } catch (_) {
      pack.sections.metrics_by_group = [];
    }
  }

  pack.counts = Object.fromEntries(
    Object.entries(pack.sections).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
  );
  return pack;
}

export async function handleLineageAudit(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureLineageSchema(env.ASTON_DB);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const db = env.ASTON_DB;
  const actor = auth.actor || "api";

  if (method === "GET" && (path === "/v1/lineage" || path === "/v1/lineage/status" || path === "/v1/audit")) {
    return json({
      ok: true,
      phase: "8-lineage-audit",
      version: VERSION,
      endpoints: {
        subject: "GET /v1/lineage/subject/:id",
        entity: "GET /v1/lineage/entity/:id",
        export: "POST /v1/audit/export",
        packages: "GET /v1/audit/packages",
        record: "POST /v1/lineage/record"
      },
      note: "Unified provenance across receipts, history, AIP, pipelines"
    }, 200, cors);
  }

  // Timeline for any subject id (entity, plan, run, receipt)
  if (method === "GET" && /^\/v1\/lineage\/(subject|entity)\/[^/]+$/.test(path)) {
    const id = path.split("/").pop();
    const limit = Math.min(100, Number(url.searchParams.get("limit") || 50));
    const events = await collectSubjectTimeline(db, tenant, id, limit);
    return json({
      ok: true,
      tenant,
      subject_id: id,
      event_count: events.length,
      timeline: events
    }, 200, cors);
  }

  // Manual lineage edge
  if (method === "POST" && path === "/v1/lineage/record") {
    let body;
    try { body = await request.json(); } catch { body = null; }
    if (!body?.source_kind) return json({ ok: false, error: "source_kind_required" }, 400, cors);
    const id = await recordLineage(env, {
      tenant,
      entity_id: body.entity_id || null,
      source_kind: body.source_kind,
      source_id: body.source_id || null,
      transform: body.transform || null,
      actor: body.actor || actor
    });
    if (!id) return json({ ok: false, error: "record_failed" }, 500, cors);
    return json({ ok: true, id }, 201, cors);
  }

  // Export audit package
  if (method === "POST" && path === "/v1/audit/export") {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const since_hours = Math.min(720, Math.max(1, Number(body?.since_hours || 24)));
    const pack = await buildAuditPackage(db, tenant, {
      since_hours,
      include_metrics: body?.include_metrics !== false
    });
    const id = slugId("aud");
    await db.prepare(
      `INSERT INTO audit_packages (id, tenant, kind, payload, created_by, created_at)
       VALUES (?, ?, 'full', ?, ?, ?)`
    ).bind(id, tenant, JSON.stringify(pack).slice(0, 900000), actor, pack.generated_at).run();

    // optional R2 store
    let r2_key = null;
    if (env.ASTON_R2) {
      try {
        r2_key = `audit/${tenant}/${id}.json`;
        await env.ASTON_R2.put(r2_key, JSON.stringify(pack, null, 2), {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { tenant, package_id: id }
        });
      } catch (e) {
        console.error("audit r2", e?.message || e);
      }
    }

    return json({
      ok: true,
      package_id: id,
      counts: pack.counts,
      generated_at: pack.generated_at,
      r2_key,
      package: body?.include_body === false ? undefined : pack
    }, 201, cors);
  }

  if (method === "GET" && path === "/v1/audit/packages") {
    const limit = Math.min(50, Number(url.searchParams.get("limit") || 20));
    const rows = await db.prepare(
      `SELECT id, kind, created_by, created_at FROM audit_packages
       WHERE tenant = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(tenant, limit).all();
    return json({ ok: true, packages: rows.results || [] }, 200, cors);
  }

  if (method === "GET" && /^\/v1\/audit\/packages\/[^/]+$/.test(path)) {
    const id = path.split("/").pop();
    const row = await db.prepare(
      "SELECT * FROM audit_packages WHERE tenant = ? AND id = ?"
    ).bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    return json({
      ok: true,
      package_id: row.id,
      kind: row.kind,
      created_by: row.created_by,
      created_at: row.created_at,
      package: safeParse(row.payload, {})
    }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
