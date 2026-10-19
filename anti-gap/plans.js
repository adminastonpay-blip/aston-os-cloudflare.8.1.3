/**
 * Anti-Gap Phase 10 — Plans, quotas & trust signals
 */

import { withDbFailover, ensureRoiSchema } from "./roi.js";
import { appendAudit } from "./secops.js";

export const PLANS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tenant_plans (
    tenant_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    overrides TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plan_usage_daily (
    tenant_id TEXT NOT NULL,
    day TEXT NOT NULL,
    metric TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, day, metric)
  )`
];

export async function ensurePlansSchema(db) {
  if (!db) return;
  await db.batch(PLANS_SCHEMA.map((sql) => db.prepare(sql)));
}

export const PLAN_CATALOG = {
  free: {
    id: "free",
    name: "Free",
    features: ["chat", "health", "export_manual"],
    quotas: {
      ai_requests_per_day: 100,
      agent_runs_per_day: 10,
      kb_docs: 20,
      webhooks: 2,
      secops_events_per_day: 50
    }
  },
  pro: {
    id: "pro",
    name: "Pro",
    features: ["chat", "agent", "kb", "webhooks", "secops", "compliance_packs", "byok", "export"],
    quotas: {
      ai_requests_per_day: 5000,
      agent_runs_per_day: 500,
      kb_docs: 500,
      webhooks: 20,
      secops_events_per_day: 2000
    }
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    features: [
      "chat", "agent", "kb", "webhooks", "secops", "compliance_packs",
      "byok", "export", "sla", "audit_chain", "custom_quotas"
    ],
    quotas: {
      ai_requests_per_day: 100000,
      agent_runs_per_day: 10000,
      kb_docs: 10000,
      webhooks: 100,
      secops_events_per_day: 50000
    }
  }
};

export function listPlanCatalog() {
  return Object.values(PLAN_CATALOG);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export async function getTenantPlan(env, tenantId) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensurePlansSchema(db);
    return await db
      .prepare(`SELECT plan_id, overrides, updated_at FROM tenant_plans WHERE tenant_id = ?`)
      .bind(tenant)
      .first();
  });

  if (!res.ok) return { ok: false, error: "plans_unavailable" };

  let planId = "free";
  let overrides = {};
  let updatedAt = null;
  if (res.result) {
    planId = res.result.plan_id || "free";
    updatedAt = res.result.updated_at;
    try {
      overrides = JSON.parse(res.result.overrides || "{}");
    } catch {
      overrides = {};
    }
  }

  const base = PLAN_CATALOG[planId] || PLAN_CATALOG.free;
  const quotas = { ...base.quotas, ...(overrides.quotas || {}) };
  const features = [...new Set([...(base.features || []), ...(overrides.features || [])])];

  return {
    ok: true,
    tenant,
    plan_id: base.id,
    plan_name: base.name,
    features,
    quotas,
    updated_at: updatedAt
  };
}

export async function setTenantPlan(env, tenantId, body) {
  const tenant = String(tenantId || "").slice(0, 120);
  const planId = String(body.plan_id || body.plan || "free");
  if (!PLAN_CATALOG[planId]) {
    return { ok: false, error: "unknown_plan", allowed: Object.keys(PLAN_CATALOG) };
  }
  const overrides = body.overrides && typeof body.overrides === "object" ? body.overrides : {};
  const updatedAt = new Date().toISOString();

  await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    await ensurePlansSchema(db);
    await db
      .prepare(
        `INSERT OR REPLACE INTO tenant_plans (tenant_id, plan_id, overrides, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(tenant, planId, JSON.stringify(overrides), updatedAt)
      .run();
  });

  await appendAudit(env, tenant, "plans.set", tenant, { plan_id: planId });
  return getTenantPlan(env, tenant);
}

export async function incrementUsage(env, tenantId, metric, amount = 1) {
  const tenant = String(tenantId || "").slice(0, 120);
  const day = todayUTC();
  const m = String(metric || "custom").slice(0, 80);
  const amt = Number(amount) || 1;

  await withDbFailover(env, async (db) => {
    await ensurePlansSchema(db);
    await db
      .prepare(
        `INSERT INTO plan_usage_daily (tenant_id, day, metric, amount)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, day, metric) DO UPDATE SET amount = amount + excluded.amount`
      )
      .bind(tenant, day, m, amt)
      .run();
  });
}

export async function getUsage(env, tenantId, day = null) {
  const tenant = String(tenantId || "").slice(0, 120);
  const d = day || todayUTC();
  const res = await withDbFailover(env, async (db) => {
    await ensurePlansSchema(db);
    const rows = await db
      .prepare(`SELECT metric, amount FROM plan_usage_daily WHERE tenant_id = ? AND day = ?`)
      .bind(tenant, d)
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "usage_unavailable" };
  const usage = {};
  for (const r of res.result || []) usage[r.metric] = Number(r.amount) || 0;
  return { ok: true, tenant, day: d, usage };
}

export async function checkQuota(env, tenantId, metric, opts = {}) {
  const plan = await getTenantPlan(env, tenantId);
  if (!plan.ok) return { allowed: true, note: "plan_unavailable" };

  const limit = plan.quotas?.[metric];
  if (limit == null || limit < 0) {
    return { allowed: true, unlimited: true, plan_id: plan.plan_id };
  }

  const usageRes = await getUsage(env, tenantId);
  const used = usageRes.ok ? Number(usageRes.usage[metric] || 0) : 0;
  const remaining = Math.max(0, limit - used);
  const hard = opts.hard === true || opts.mode === "hard";
  const allowed = hard ? used < limit : true;
  const soft_exceeded = used >= limit;

  return {
    allowed,
    soft_exceeded,
    metric,
    used,
    limit,
    remaining,
    plan_id: plan.plan_id,
    mode: hard ? "hard" : "soft"
  };
}

export async function featureEnabled(env, tenantId, feature) {
  const plan = await getTenantPlan(env, tenantId);
  if (!plan.ok) return true;
  return plan.features.includes(feature) || plan.features.includes("*");
}

export async function buildTrustPayload(env) {
  const features = [];
  if (env.ANTI_GAP !== "false") {
    features.push("anti_gap");
    for (let i = 1; i <= 10; i++) {
      const key = i === 1 ? "ANTI_GAP" : `ANTI_GAP_P${i}`;
      if (i === 1 || env[key] !== "false") features.push(`p${i}`);
    }
  }

  return {
    ok: true,
    product: "ASTON OS",
    edge: "cloudflare_workers",
    trust: {
      multi_tenant: true,
      data_export: true,
      data_purge: true,
      audit_chain: true,
      webhook_retries: true,
      compliance_packs: ["gdpr", "hipaa", "ai_act", "soc2"],
      plans: Object.keys(PLAN_CATALOG),
      anti_gap_phases: features.filter((f) => f.startsWith("p")),
      notes: [
        "Technical controls at the edge; legal GRC remains with your compliance stack",
        "Evidence and DSAR helpers available under authenticated /v1/compliance/*"
      ]
    },
    generated_at: new Date().toISOString()
  };
}
