/**
 * Anti-Gap Phase 11 — Compute fabric
 * Edge-first routing, $ cost guardrails, residency hints.
 */

import { withDbFailover, ensureRoiSchema } from "./roi.js";
import { appendAudit } from "./secops.js";
import { incrementUsage } from "./plans.js";

export const COMPUTE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS compute_policies (
    tenant_id TEXT PRIMARY KEY,
    default_tier TEXT DEFAULT 'edge',
    max_usd_per_day REAL DEFAULT 50,
    allow_byok INTEGER DEFAULT 1,
    allow_heavy INTEGER DEFAULT 0,
    residency TEXT,
    kill_switch INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS compute_cost_daily (
    tenant_id TEXT NOT NULL,
    day TEXT NOT NULL,
    tier TEXT NOT NULL,
    usd REAL NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, day, tier)
  )`
];

export async function ensureComputeSchema(db) {
  if (!db) return;
  await db.batch(COMPUTE_SCHEMA.map((sql) => db.prepare(sql)));
}

export const TIER_COST_USD = {
  edge: 0.0002,
  byok: 0.01,
  heavy: 0.05
};

export const TIERS = {
  edge: {
    id: "edge",
    name: "Cloudflare Workers AI / edge",
    description: "Default — no GPU CapEx, global PoPs, lowest cost",
    requires_byok: false
  },
  byok: {
    id: "byok",
    name: "Bring-your-own-key provider",
    description: "External OpenAI-compatible API under tenant key",
    requires_byok: true
  },
  heavy: {
    id: "heavy",
    name: "Heavy GPU cloud (explicit opt-in)",
    description: "Only when tenant enables; still routed via policy + budget",
    requires_byok: true
  },
  blocked: {
    id: "blocked",
    name: "Blocked",
    description: "Kill switch or budget exhausted"
  }
};

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export async function getComputePolicy(env, tenantId) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureComputeSchema(db);
    return await db
      .prepare(
        `SELECT default_tier, max_usd_per_day, allow_byok, allow_heavy, residency, kill_switch, updated_at
         FROM compute_policies WHERE tenant_id = ?`
      )
      .bind(tenant)
      .first();
  });

  if (!res.ok) return { ok: false, error: "compute_policy_unavailable" };

  if (!res.result) {
    return {
      ok: true,
      tenant,
      default_tier: "edge",
      max_usd_per_day: 50,
      allow_byok: true,
      allow_heavy: false,
      residency: null,
      kill_switch: false,
      default: true
    };
  }

  const r = res.result;
  return {
    ok: true,
    tenant,
    default_tier: r.default_tier || "edge",
    max_usd_per_day: Number(r.max_usd_per_day) || 50,
    allow_byok: Boolean(r.allow_byok),
    allow_heavy: Boolean(r.allow_heavy),
    residency: r.residency || null,
    kill_switch: Boolean(r.kill_switch),
    updated_at: r.updated_at
  };
}

export async function setComputePolicy(env, tenantId, body) {
  const tenant = String(tenantId || "").slice(0, 120);
  const defaultTier = ["edge", "byok", "heavy"].includes(body.default_tier)
    ? body.default_tier
    : "edge";
  const maxUsd = Math.min(100000, Math.max(0, Number(body.max_usd_per_day) ?? 50));
  const allowByok = body.allow_byok === false ? 0 : 1;
  const allowHeavy = body.allow_heavy === true ? 1 : 0;
  const residency = body.residency ? String(body.residency).slice(0, 40) : null;
  const kill = body.kill_switch === true ? 1 : 0;
  const updatedAt = new Date().toISOString();

  await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    await ensureComputeSchema(db);
    await db
      .prepare(
        `INSERT OR REPLACE INTO compute_policies
         (tenant_id, default_tier, max_usd_per_day, allow_byok, allow_heavy, residency, kill_switch, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(tenant, defaultTier, maxUsd, allowByok, allowHeavy, residency, kill, updatedAt)
      .run();
  });

  await appendAudit(env, tenant, "compute.policy_set", tenant, {
    default_tier: defaultTier,
    max_usd_per_day: maxUsd,
    kill_switch: Boolean(kill)
  });

  return getComputePolicy(env, tenant);
}

export async function getComputeCostToday(env, tenantId) {
  const tenant = String(tenantId || "").slice(0, 120);
  const day = todayUTC();
  const res = await withDbFailover(env, async (db) => {
    await ensureComputeSchema(db);
    const rows = await db
      .prepare(
        `SELECT tier, usd, requests FROM compute_cost_daily WHERE tenant_id = ? AND day = ?`
      )
      .bind(tenant, day)
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "cost_unavailable" };

  const byTier = {};
  let totalUsd = 0;
  let totalReq = 0;
  for (const r of res.result || []) {
    byTier[r.tier] = { usd: Number(r.usd) || 0, requests: Number(r.requests) || 0 };
    totalUsd += Number(r.usd) || 0;
    totalReq += Number(r.requests) || 0;
  }
  return { ok: true, tenant, day, by_tier: byTier, total_usd: totalUsd, total_requests: totalReq };
}

export async function recordComputeCost(env, tenantId, tier, usd = null, requests = 1) {
  const tenant = String(tenantId || "").slice(0, 120);
  const t = String(tier || "edge");
  const day = todayUTC();
  const cost = usd != null ? Number(usd) : TIER_COST_USD[t] || TIER_COST_USD.edge;
  const req = Number(requests) || 1;

  await withDbFailover(env, async (db) => {
    await ensureComputeSchema(db);
    await db
      .prepare(
        `INSERT INTO compute_cost_daily (tenant_id, day, tier, usd, requests)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, day, tier) DO UPDATE SET
           usd = usd + excluded.usd,
           requests = requests + excluded.requests`
      )
      .bind(tenant, day, t, cost * req, req)
      .run();
  });

  try {
    await incrementUsage(env, tenant, "ai_requests_per_day", req);
  } catch {
    /* optional */
  }
}

export async function resolveComputeRoute(env, tenantId, opts = {}) {
  const policy = await getComputePolicy(env, tenantId);
  if (!policy.ok) {
    return { tier: "edge", allowed: true, reason: "policy_unavailable_fallback_edge" };
  }

  if (policy.kill_switch) {
    return {
      tier: "blocked",
      allowed: false,
      reason: "kill_switch",
      policy,
      status: 503
    };
  }

  const costToday = await getComputeCostToday(env, tenantId);
  const spent = costToday.ok ? costToday.total_usd : 0;
  const maxUsd = policy.max_usd_per_day;

  if (maxUsd >= 0 && spent >= maxUsd) {
    return {
      tier: "blocked",
      allowed: false,
      reason: "daily_budget_exhausted",
      spent_usd: spent,
      max_usd_per_day: maxUsd,
      policy,
      status: 429
    };
  }

  let preferred = opts.preferred_tier || policy.default_tier || "edge";
  if (opts.force_edge) preferred = "edge";

  if (preferred === "heavy" && !policy.allow_heavy) {
    preferred = policy.allow_byok ? "byok" : "edge";
  }
  if (preferred === "byok" && !policy.allow_byok) {
    preferred = "edge";
  }

  const residency = policy.residency || opts.residency || null;
  const estimated = TIER_COST_USD[preferred] || TIER_COST_USD.edge;

  return {
    tier: preferred,
    allowed: true,
    reason: "ok",
    estimated_usd: estimated,
    remaining_budget_usd: maxUsd >= 0 ? Math.max(0, maxUsd - spent) : null,
    residency,
    policy,
    cost_today: costToday.ok
      ? { total_usd: costToday.total_usd, by_tier: costToday.by_tier }
      : null
  };
}

export function computeTrustNotes() {
  return {
    gpu_capex_dependency: false,
    default_compute: "cloudflare_workers_ai_edge",
    heavy_gpu: "opt_in_byok_only",
    cost_controls: ["max_usd_per_day", "kill_switch", "tier_routing"],
    avoids: [
      "hyperscaler_gpu_waitlists",
      "data_center_power_queues",
      "cuda_lock_in_for_control_plane"
    ],
    notes: [
      "ASTON OS control plane runs on Cloudflare edge — no GPU CapEx required",
      "Heavy inference only via BYOK when tenant explicitly allows",
      "Daily USD guardrails prevent runaway AI bills"
    ]
  };
}
