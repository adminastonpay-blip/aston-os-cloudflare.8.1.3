// ASTON OS — Phase Commerce: multi-revenue plans + feature gating
// Pilot · Core · Ops · Trust · Enterprise

const VERSION = "11.1.0";

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

function slugId(p) {
  return `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export const RATE_CARD = {
  currency: "USD",
  plans: [
    {
      id: "pilot", name: "Pilot", kind: "one_time", setup_usd: 3500, monthly_usd: 0, duration_days: 30,
      description: "1 flujo + receipts + 30 días. Puerta de entrada PyME.",
      features: ["ui", "connectors", "receipts", "predictive_basic", "twin_basic"]
    },
    {
      id: "core", name: "Core", kind: "saas", setup_usd: 0, monthly_usd: 1500,
      description: "Studio + connectors + security + predictive.",
      features: ["ui", "connectors", "security", "predictive", "receipts", "ai_fast"]
    },
    {
      id: "ops", name: "Ops", kind: "saas", setup_usd: 0, monthly_usd: 3000,
      description: "Core + Swarm + Decision Twin.",
      features: ["ui", "connectors", "security", "predictive", "receipts", "ai_fast", "swarm", "twin"]
    },
    {
      id: "trust", name: "Trust", kind: "saas", setup_usd: 0, monthly_usd: 5000,
      description: "Ops + Auto-Gov + Audit pack.",
      features: ["ui", "connectors", "security", "predictive", "receipts", "ai_fast", "ai_heavy", "swarm", "twin", "auto_gov", "audit"]
    },
    {
      id: "enterprise", name: "Enterprise", kind: "annual", setup_usd: 0, monthly_usd: null, annual_from_usd: 50000,
      description: "Todo + SSO + multi-tenant + SLA. Contrato grande.",
      features: ["ui", "connectors", "security", "predictive", "receipts", "ai_fast", "ai_heavy", "swarm", "twin", "auto_gov", "audit", "sso", "multi_tenant", "sla", "usage_volume"]
    }
  ],
  add_ons: [
    { id: "addon_swarm", name: "Swarm agents", monthly_usd: 800, feature: "swarm" },
    { id: "addon_twin", name: "Decision Twin", monthly_usd: 700, feature: "twin" },
    { id: "addon_gov", name: "Auto-Gov + Audit", monthly_usd: 1200, feature: "auto_gov" },
    { id: "addon_fraud", name: "Fraud shield pack", monthly_usd: 1500, feature: "fraud" },
    { id: "setup_integration", name: "ERP/Shopify setup", one_time_usd: 8000, feature: null }
  ],
  usage: [
    { id: "webhook_events", unit: "1k events", usd: 0.5 },
    { id: "ai_tokens", unit: "1k tokens", usd: 0.02 },
    { id: "swarm_runs", unit: "run", usd: 0.05 }
  ]
};

const FEATURE_ROUTES = {
  ui: ["/ui", "/v1/ui"],
  connectors: ["/v1/connectors"],
  security: ["/v1/security"],
  predictive: ["/v1/predictive"],
  ai_fast: ["/v1/ai"],
  swarm: ["/v1/swarm"],
  twin: ["/v1/twin"],
  auto_gov: ["/v1/gov"],
  audit: ["/v1/gov", "/v1/security/audit"],
  receipts: ["/v1/twin/receipts"]
};

export function planById(id) {
  return RATE_CARD.plans.find((p) => p.id === id) || null;
}

export function featuresForPlan(planId, addOns = []) {
  const plan = planById(planId) || planById("core");
  const set = new Set(plan?.features || []);
  for (const a of addOns) {
    const addon = RATE_CARD.add_ons.find((x) => x.id === a);
    if (addon?.feature) set.add(addon.feature);
  }
  return [...set];
}

export function pathAllowed(features, path) {
  if (path === "/" || path === "/health" || path.startsWith("/v1/billing")) return true;
  const checks = [
    ["/v1/swarm", "swarm"], ["/v1/twin", "twin"], ["/v1/gov", "auto_gov"],
    ["/v1/predictive", "predictive"], ["/v1/ai", "ai_fast"],
    ["/v1/security", "security"], ["/v1/connectors", "connectors"], ["/ui", "ui"]
  ];
  for (const [prefix, feat] of checks) {
    if (path.startsWith(prefix) || path === prefix) return features.includes(feat);
  }
  return true;
}

export async function ensureBillingSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS tenant_subscriptions (
      tenant TEXT PRIMARY KEY, plan_id TEXT NOT NULL, add_ons TEXT,
      status TEXT NOT NULL DEFAULT 'active', trial_ends_at TEXT, current_period_end TEXT,
      mrr_usd REAL, actor TEXT, updated_at TEXT NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS billing_events (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL,
      amount_usd REAL, detail TEXT, created_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_bill_ev ON billing_events (tenant, created_at)")
  ]);
}

async function getSub(db, tenant) {
  return db.prepare("SELECT * FROM tenant_subscriptions WHERE tenant = ?").bind(tenant).first();
}

export async function resolveTenantFeatures(env, tenant) {
  if (!env.ASTON_DB) return { plan_id: "trust", features: featuresForPlan("trust"), status: "dev_open" };
  try {
    await ensureBillingSchema(env.ASTON_DB);
    const sub = await getSub(env.ASTON_DB, tenant);
    if (!sub || sub.status === "canceled") {
      return { plan_id: "pilot", features: featuresForPlan("pilot"), status: sub?.status || "none" };
    }
    let addOns = [];
    try { addOns = JSON.parse(sub.add_ons || "[]"); } catch {}
    return {
      plan_id: sub.plan_id,
      features: featuresForPlan(sub.plan_id, addOns),
      status: sub.status,
      mrr_usd: sub.mrr_usd,
      trial_ends_at: sub.trial_ends_at,
      current_period_end: sub.current_period_end
    };
  } catch (e) {
    return { plan_id: "core", features: featuresForPlan("core"), status: "error", detail: String(e.message || e).slice(0, 100) };
  }
}

export async function handleBilling(request, env, path, method, cors = {}) {
  if (method === "GET" && (path === "/v1/billing/rate-card" || path === "/v1/billing/plans")) {
    return json({
      ok: true, version: VERSION, phase: "commerce", rate_card: RATE_CARD,
      path_to_enterprise: "Pilot → Core → Ops/Trust → Enterprise annual"
    }, 200, cors);
  }

  if (method === "GET" && path === "/v1/billing/status") {
    return json({
      ok: true, version: VERSION,
      endpoints: {
        rate_card: "GET /v1/billing/rate-card", me: "GET /v1/billing/me",
        subscribe: "POST /v1/billing/subscribe", add_on: "POST /v1/billing/add-on",
        check: "POST /v1/billing/check-feature", events: "GET /v1/billing/events"
      }
    }, 200, cors);
  }

  const token = bearer(request);
  if (!token) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const tenant = request.headers.get("X-Tenant") || "default";
  const actor = request.headers.get("X-Aston-Actor") || "api";

  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureBillingSchema(env.ASTON_DB);
  const db = env.ASTON_DB;

  if (method === "GET" && path === "/v1/billing/me") {
    const resolved = await resolveTenantFeatures(env, tenant);
    const plan = planById(resolved.plan_id);
    return json({
      ok: true, tenant, subscription: resolved, plan,
      allowed_routes: (resolved.features || []).map((f) => FEATURE_ROUTES[f] || []).flat()
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/billing/subscribe") {
    const body = await readJson(request);
    const planId = String(body?.plan_id || "core").toLowerCase();
    const plan = planById(planId);
    if (!plan) return json({ ok: false, error: "unknown_plan", plans: RATE_CARD.plans.map((p) => p.id) }, 400, cors);

    const now = new Date();
    const iso = now.toISOString();
    let trialEnds = null, periodEnd = null, mrr = plan.monthly_usd || 0;
    if (plan.id === "pilot") {
      trialEnds = new Date(now.getTime() + (plan.duration_days || 30) * 86400000).toISOString();
      mrr = 0;
    } else if (plan.kind === "annual") {
      periodEnd = new Date(now.getTime() + 365 * 86400000).toISOString();
      mrr = (plan.annual_from_usd || 50000) / 12;
    } else {
      periodEnd = new Date(now.getTime() + 30 * 86400000).toISOString();
    }

    const existing = await getSub(db, tenant);
    if (existing) {
      await db.prepare(
        `UPDATE tenant_subscriptions SET plan_id=?, status='active', trial_ends_at=?, current_period_end=?, mrr_usd=?, actor=?, updated_at=? WHERE tenant=?`
      ).bind(planId, trialEnds, periodEnd, mrr, actor, iso, tenant).run();
    } else {
      await db.prepare(
        `INSERT INTO tenant_subscriptions (tenant, plan_id, add_ons, status, trial_ends_at, current_period_end, mrr_usd, actor, updated_at, created_at)
         VALUES (?, ?, '[]', 'active', ?, ?, ?, ?, ?, ?)`
      ).bind(tenant, planId, trialEnds, periodEnd, mrr, actor, iso, iso).run();
    }

    const amount = plan.setup_usd || plan.monthly_usd || plan.annual_from_usd || 0;
    await db.prepare(
      "INSERT INTO billing_events (id, tenant, kind, amount_usd, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(slugId("bev"), tenant, `subscribe_${planId}`, amount, JSON.stringify({ plan_id: planId, actor }), iso).run();

    return json({
      ok: true, tenant, plan_id: planId, mrr_usd: mrr, setup_usd: plan.setup_usd || 0,
      trial_ends_at: trialEnds, current_period_end: periodEnd, features: featuresForPlan(planId),
      invoice_hint: plan.kind === "one_time" ? `Charge setup $${plan.setup_usd}` : plan.kind === "annual" ? `Annual from $${plan.annual_from_usd}` : `MRR $${plan.monthly_usd}`
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/billing/add-on") {
    const body = await readJson(request);
    const addonId = String(body?.add_on_id || body?.id || "");
    const addon = RATE_CARD.add_ons.find((a) => a.id === addonId);
    if (!addon) return json({ ok: false, error: "unknown_add_on", add_ons: RATE_CARD.add_ons }, 400, cors);
    const sub = await getSub(db, tenant);
    if (!sub) return json({ ok: false, error: "subscribe_first" }, 400, cors);
    let addOns = [];
    try { addOns = JSON.parse(sub.add_ons || "[]"); } catch {}
    if (!addOns.includes(addonId)) addOns.push(addonId);
    const plan = planById(sub.plan_id);
    let newMrr = plan?.monthly_usd || Number(sub.mrr_usd) || 0;
    if (plan?.kind === "annual") newMrr = (plan.annual_from_usd || 50000) / 12;
    for (const id of addOns) {
      const a = RATE_CARD.add_ons.find((x) => x.id === id);
      if (a?.monthly_usd) newMrr += a.monthly_usd;
    }
    const iso = new Date().toISOString();
    await db.prepare("UPDATE tenant_subscriptions SET add_ons=?, mrr_usd=?, updated_at=? WHERE tenant=?")
      .bind(JSON.stringify(addOns), newMrr, iso, tenant).run();
    await db.prepare(
      "INSERT INTO billing_events (id, tenant, kind, amount_usd, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(slugId("bev"), tenant, `addon_${addonId}`, addon.monthly_usd || addon.one_time_usd || 0, JSON.stringify({ addonId }), iso).run();
    return json({ ok: true, tenant, add_ons: addOns, mrr_usd: newMrr, features: featuresForPlan(sub.plan_id, addOns) }, 200, cors);
  }

  if (method === "POST" && path === "/v1/billing/check-feature") {
    const body = await readJson(request);
    const resolved = await resolveTenantFeatures(env, tenant);
    const okFeature = body?.feature ? resolved.features.includes(body.feature) : true;
    const okPath = body?.path ? pathAllowed(resolved.features, body.path) : true;
    return json({ ok: true, allowed: okFeature && okPath, plan_id: resolved.plan_id, features: resolved.features }, 200, cors);
  }

  if (method === "GET" && path === "/v1/billing/events") {
    const limit = Math.min(50, Number(new URL(request.url).searchParams.get("limit") || 20));
    const rows = await db.prepare(
      "SELECT id, kind, amount_usd, detail, created_at FROM billing_events WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(tenant, limit).all();
    return json({ ok: true, events: rows.results || [] }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
