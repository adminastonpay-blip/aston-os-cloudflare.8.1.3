/**
 * ASTON OS Anti-Gap Phase 1 — ROI metering
 */
import { withDbFailover } from "./resilience.js";

export const ROI_SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS roi_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    route TEXT NOT NULL,
    model TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost_usd_micros INTEGER DEFAULT 0,
    latency_ms INTEGER,
    outcome TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_roi_tenant_created ON roi_events (tenant_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_roi_tenant_route ON roi_events (tenant_id, route, created_at)`,
  `CREATE TABLE IF NOT EXISTS tenant_budgets (
    tenant_id TEXT PRIMARY KEY,
    monthly_usd_micros INTEGER NOT NULL,
    soft_limit_pct INTEGER DEFAULT 80,
    hard_block INTEGER DEFAULT 0,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS export_jobs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    r2_key TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  )`
];

export function estimateCostMicros(model, tokensIn = 0, tokensOut = 0) {
  const total = Math.max(0, Number(tokensIn) || 0) + Math.max(0, Number(tokensOut) || 0);
  const perToken = 0.5;
  const modelFactor = /70b|opus|gpt-4/i.test(String(model || "")) ? 4 : 1;
  return Math.round(total * perToken * modelFactor);
}

export async function ensureRoiSchema(db) {
  if (!db) return;
  await db.batch(ROI_SCHEMA_STMTS.map((sql) => db.prepare(sql)));
}

export async function recordRoiEvent(env, event) {
  if (!env?.ASTON_DB && !env?.ASTON_DB_BACKUP) return false;
  const row = {
    id: event.id || crypto.randomUUID(),
    tenant_id: String(event.tenant_id || event.tenant || "default").slice(0, 120),
    route: String(event.route || "unknown").slice(0, 200),
    model: event.model ? String(event.model).slice(0, 120) : null,
    tokens_in: Number(event.tokens_in) || 0,
    tokens_out: Number(event.tokens_out) || 0,
    cost_usd_micros:
      event.cost_usd_micros != null
        ? Number(event.cost_usd_micros)
        : estimateCostMicros(event.model, event.tokens_in, event.tokens_out),
    latency_ms: event.latency_ms != null ? Number(event.latency_ms) : null,
    outcome: String(event.outcome || "ok").slice(0, 40),
    created_at: event.created_at || new Date().toISOString()
  };
  const res = await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    await db
      .prepare(
        `INSERT INTO roi_events (id, tenant_id, route, model, tokens_in, tokens_out, cost_usd_micros, latency_ms, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id, row.tenant_id, row.route, row.model,
        row.tokens_in, row.tokens_out, row.cost_usd_micros,
        row.latency_ms, row.outcome, row.created_at
      )
      .run();
    return true;
  });
  return Boolean(res.ok);
}

export async function summarizeRoi(env, tenantId, days = 30) {
  const tenant = String(tenantId || "default").slice(0, 120);
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
  const res = await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    const totals = await db
      .prepare(
        `SELECT COUNT(*) AS events,
           COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros,
           COALESCE(SUM(tokens_in), 0) AS tokens_in,
           COALESCE(SUM(tokens_out), 0) AS tokens_out,
           COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
         FROM roi_events WHERE tenant_id = ? AND created_at >= ?`
      )
      .bind(tenant, since)
      .first();
    const byRoute = await db
      .prepare(
        `SELECT route, COUNT(*) AS events,
           COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros,
           COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
         FROM roi_events WHERE tenant_id = ? AND created_at >= ?
         GROUP BY route ORDER BY cost_usd_micros DESC LIMIT 50`
      )
      .bind(tenant, since)
      .all();
    const outcomes = await db
      .prepare(
        `SELECT outcome, COUNT(*) AS c FROM roi_events
         WHERE tenant_id = ? AND created_at >= ? GROUP BY outcome`
      )
      .bind(tenant, since)
      .all();
    return { totals, byRoute: byRoute?.results || [], outcomes: outcomes?.results || [] };
  });
  if (!res.ok) return { ok: false, tenant, days, error: "roi_unavailable", detail: res.errors };
  const t = res.result.totals || {};
  return {
    ok: true,
    tenant,
    days,
    db: res.name,
    summary: {
      events: Number(t.events) || 0,
      cost_usd: (Number(t.cost_usd_micros) || 0) / 1_000_000,
      cost_usd_micros: Number(t.cost_usd_micros) || 0,
      tokens_in: Number(t.tokens_in) || 0,
      tokens_out: Number(t.tokens_out) || 0,
      avg_latency_ms: Math.round(Number(t.avg_latency_ms) || 0)
    },
    by_route: (res.result.byRoute || []).map((r) => ({
      route: r.route,
      events: Number(r.events) || 0,
      cost_usd: (Number(r.cost_usd_micros) || 0) / 1_000_000,
      avg_latency_ms: Math.round(Number(r.avg_latency_ms) || 0)
    })),
    outcomes: Object.fromEntries((res.result.outcomes || []).map((o) => [o.outcome, Number(o.c) || 0])),
    note: "cost_usd is an internal estimate for budgeting; not a Cloudflare bill"
  };
}

export async function checkBudget(env, tenantId) {
  const tenant = String(tenantId || "default").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    const budget = await db
      .prepare(`SELECT monthly_usd_micros, soft_limit_pct, hard_block FROM tenant_budgets WHERE tenant_id = ?`)
      .bind(tenant)
      .first();
    if (!budget) return { allowed: true, configured: false };
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const spent = await db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd_micros), 0) AS s FROM roi_events WHERE tenant_id = ? AND created_at >= ?`
      )
      .bind(tenant, monthStart.toISOString())
      .first();
    const spentMicros = Number(spent?.s) || 0;
    const limit = Number(budget.monthly_usd_micros) || 0;
    const softPct = Number(budget.soft_limit_pct) || 80;
    const soft = limit > 0 && spentMicros >= (limit * softPct) / 100;
    const hard = Boolean(budget.hard_block) && limit > 0 && spentMicros >= limit;
    return { allowed: !hard, configured: true, soft, hard, spent_micros: spentMicros, limit_micros: limit };
  });
  if (!res.ok) return { allowed: true, configured: false, fail_open: true };
  return res.result;
}
