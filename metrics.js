// ASTON OS — Phase 7 Observability
// Request counters, latency buckets, error rates, per-tenant usage

const VERSION = "12.0.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

export async function ensureMetricsSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS metrics_events (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      path TEXT NOT NULL,
      method TEXT NOT NULL,
      status INTEGER NOT NULL,
      ms INTEGER NOT NULL,
      actor TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_metrics_tenant_ts ON metrics_events (tenant, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_metrics_path ON metrics_events (tenant, path, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS metrics_hourly (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      hour TEXT NOT NULL,
      path_group TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      sum_ms INTEGER NOT NULL DEFAULT 0,
      max_ms INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tenant, hour, path_group)
    )`)
  ]);
}

function slugId() {
  return `m_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

function pathGroup(path) {
  const p = String(path || "/");
  if (p.startsWith("/v1/ontology")) return "ontology";
  if (p.startsWith("/v1/foundry") || p === "/v1/search") return "foundry";
  if (p.startsWith("/v1/aip")) return "aip";
  if (p.startsWith("/v1/orchestrator")) return "orchestrator";
  if (p.startsWith("/v1/pipelines")) return "pipelines";
  if (p.startsWith("/v1/security")) return "security";
  if (p.startsWith("/v1/cases")) return "cases";
  if (p.startsWith("/v1/receipts")) return "receipts";
  if (p.startsWith("/v1/ops") || p.startsWith("/v1/metrics")) return "ops";
  if (p.startsWith("/ui")) return "ui";
  if (p === "/" || p === "/health") return "health";
  return "other";
}

function hourBucket(iso) {
  return String(iso || new Date().toISOString()).slice(0, 13); // YYYY-MM-DDTHH
}

/** Fire-and-forget friendly record */
export async function recordMetric(env, {
  tenant = "default",
  path,
  method = "GET",
  status = 200,
  ms = 0,
  actor = null,
  error_code = null
}) {
  if (!env?.ASTON_DB) return;
  try {
    await ensureMetricsSchema(env.ASTON_DB);
    const now = new Date().toISOString();
    const id = slugId();
    await env.ASTON_DB.prepare(
      `INSERT INTO metrics_events (id, tenant, path, method, status, ms, actor, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      String(tenant).slice(0, 120),
      String(path || "/").slice(0, 200),
      String(method || "GET").slice(0, 12),
      Number(status) || 0,
      Math.min(120000, Math.max(0, Number(ms) || 0)),
      actor ? String(actor).slice(0, 120) : null,
      error_code ? String(error_code).slice(0, 80) : null,
      now
    ).run();

    const hour = hourBucket(now);
    const group = pathGroup(path);
    const hid = `${tenant}|${hour}|${group}`;
    const isErr = Number(status) >= 400 ? 1 : 0;
    const latency = Math.min(120000, Math.max(0, Number(ms) || 0));

    // upsert hourly rollup
    const existing = await env.ASTON_DB.prepare(
      "SELECT count, errors, sum_ms, max_ms FROM metrics_hourly WHERE tenant = ? AND hour = ? AND path_group = ?"
    ).bind(tenant, hour, group).first();

    if (existing) {
      await env.ASTON_DB.prepare(
        `UPDATE metrics_hourly SET count = ?, errors = ?, sum_ms = ?, max_ms = ?
         WHERE tenant = ? AND hour = ? AND path_group = ?`
      ).bind(
        (existing.count || 0) + 1,
        (existing.errors || 0) + isErr,
        (existing.sum_ms || 0) + latency,
        Math.max(existing.max_ms || 0, latency),
        tenant, hour, group
      ).run();
    } else {
      await env.ASTON_DB.prepare(
        `INSERT INTO metrics_hourly (id, tenant, hour, path_group, count, errors, sum_ms, max_ms)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(hid.slice(0, 120), tenant, hour, group, isErr, latency, latency).run();
    }

    // optional KV pulse for live dashboard
    if (env.ASTON_KV) {
      try {
        await env.ASTON_KV.put(
          `metrics:last:${tenant}`,
          JSON.stringify({ path, status, ms: latency, at: now }),
          { expirationTtl: 86400 }
        );
      } catch (_) {}
    }
  } catch (e) {
    console.error("recordMetric", e?.message || e);
  }
}

/** Wrap a Response-producing handler and record timing */
export async function withMetrics(env, auth, path, method, fn) {
  const t0 = Date.now();
  let status = 500;
  let error_code = null;
  try {
    const res = await fn();
    status = res?.status || 200;
    return res;
  } catch (e) {
    error_code = String(e?.message || e).slice(0, 80);
    throw e;
  } finally {
    const ms = Date.now() - t0;
    // don't await hard — but Workers may cancel; await briefly
    await recordMetric(env, {
      tenant: auth?.tenant || "default",
      path,
      method,
      status,
      ms,
      actor: auth?.actor || null,
      error_code
    });
  }
}

export async function handleMetrics(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureMetricsSchema(env.ASTON_DB);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const db = env.ASTON_DB;

  if (method === "GET" && (path === "/v1/metrics" || path === "/v1/metrics/status")) {
    return json({
      ok: true,
      phase: "7-observability",
      version: VERSION,
      endpoints: {
        summary: "GET /v1/metrics/summary",
        hourly: "GET /v1/metrics/hourly?hours=24",
        recent: "GET /v1/metrics/recent?limit=30",
        groups: "GET /v1/metrics/groups"
      }
    }, 200, cors);
  }

  if (method === "GET" && path === "/v1/metrics/summary") {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const totals = await db.prepare(
      `SELECT COUNT(*) AS c,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              AVG(ms) AS avg_ms,
              MAX(ms) AS max_ms
       FROM metrics_events WHERE tenant = ? AND created_at >= ?`
    ).bind(tenant, since).first();

    const byGroup = await db.prepare(
      `SELECT path_group, SUM(count) AS c, SUM(errors) AS e, SUM(sum_ms) AS sum_ms
       FROM metrics_hourly WHERE tenant = ? AND hour >= ?
       GROUP BY path_group ORDER BY c DESC`
    ).bind(tenant, since.slice(0, 13)).all();

    let last = null;
    if (env.ASTON_KV) {
      try {
        const raw = await env.ASTON_KV.get(`metrics:last:${tenant}`);
        if (raw) last = JSON.parse(raw);
      } catch (_) {}
    }

    return json({
      ok: true,
      tenant,
      window: "24h",
      requests: totals?.c || 0,
      errors: totals?.errors || 0,
      error_rate: totals?.c ? Number(totals.errors || 0) / Number(totals.c) : 0,
      avg_ms: totals?.avg_ms != null ? Math.round(Number(totals.avg_ms)) : null,
      max_ms: totals?.max_ms != null ? Number(totals.max_ms) : null,
      by_group: (byGroup.results || []).map((r) => ({
        group: r.path_group,
        count: r.c,
        errors: r.e,
        avg_ms: r.c ? Math.round(Number(r.sum_ms) / Number(r.c)) : null
      })),
      last_request: last
    }, 200, cors);
  }

  if (method === "GET" && path === "/v1/metrics/hourly") {
    const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") || 24)));
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 13);
    const rows = await db.prepare(
      `SELECT hour, path_group, count, errors, sum_ms, max_ms
       FROM metrics_hourly WHERE tenant = ? AND hour >= ?
       ORDER BY hour DESC, path_group LIMIT 500`
    ).bind(tenant, since).all();
    return json({
      ok: true,
      tenant,
      hours,
      series: (rows.results || []).map((r) => ({
        hour: r.hour,
        group: r.path_group,
        count: r.count,
        errors: r.errors,
        avg_ms: r.count ? Math.round(Number(r.sum_ms) / Number(r.count)) : 0,
        max_ms: r.max_ms
      }))
    }, 200, cors);
  }

  if (method === "GET" && path === "/v1/metrics/recent") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
    const rows = await db.prepare(
      `SELECT path, method, status, ms, actor, error_code, created_at
       FROM metrics_events WHERE tenant = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(tenant, limit).all();
    return json({ ok: true, tenant, events: rows.results || [] }, 200, cors);
  }

  if (method === "GET" && path === "/v1/metrics/groups") {
    return json({
      ok: true,
      groups: ["ontology", "foundry", "aip", "orchestrator", "pipelines", "security", "cases", "receipts", "ops", "ui", "health", "other"]
    }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
