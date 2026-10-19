/**
 * Anti-Gap Phase 4 — data retention policies + enforcement helper
 */

const RET_PREFIX = "aston:policy:retention:";

export async function loadRetention(env, tenant) {
  if (!env?.ASTON_KV) return defaultRetention();
  try {
    const raw = await env.ASTON_KV.get(`${RET_PREFIX}${tenant}`);
    if (!raw) return defaultRetention();
    const p = JSON.parse(raw);
    return normalize(p);
  } catch {
    return defaultRetention();
  }
}

export function defaultRetention() {
  return {
    audit_days: 365,
    roi_days: 90,
    jobs_days: 30,
    media_days: 180,
    export_days: 30,
    auto_purge: false,
    updated_at: null,
    source: "defaults"
  };
}

function normalize(p) {
  const clamp = (n, d) => Math.min(3650, Math.max(1, Number(n) || d));
  return {
    audit_days: clamp(p.audit_days, 365),
    roi_days: clamp(p.roi_days, 90),
    jobs_days: clamp(p.jobs_days, 30),
    media_days: clamp(p.media_days, 180),
    export_days: clamp(p.export_days, 30),
    auto_purge: Boolean(p.auto_purge),
    updated_at: p.updated_at || null,
    source: "tenant"
  };
}

export async function saveRetention(env, tenant, body) {
  if (!env?.ASTON_KV) return { ok: false, error: "kv_missing" };
  const clean = normalize({ ...body, updated_at: new Date().toISOString() });
  clean.source = "tenant";
  await env.ASTON_KV.put(`${RET_PREFIX}${tenant}`, JSON.stringify(clean), {
    expirationTtl: 60 * 60 * 24 * 365
  });
  return { ok: true, policy: clean };
}

export async function enforceRetention(env, tenantId) {
  const tenant = String(tenantId || "").slice(0, 120);
  if (!tenant) return { ok: false, error: "tenant_required" };

  const { withDbFailover, ensureRoiSchema } = await import("./roi.js");
  const policy = await loadRetention(env, tenant);
  const now = Date.now();
  const deleted = {};

  const cuts = {
    roi_events: new Date(now - policy.roi_days * 86400000).toISOString(),
    audit_log: new Date(now - policy.audit_days * 86400000).toISOString(),
    jobs: new Date(now - policy.jobs_days * 86400000).toISOString(),
    export_jobs: new Date(now - policy.export_days * 86400000).toISOString()
  };

  const targets = [
    { table: "roi_events", col: "tenant_id", time: "created_at", before: cuts.roi_events },
    { table: "audit_log", col: "tenant", time: "created_at", before: cuts.audit_log },
    { table: "jobs", col: "tenant", time: "created_at", before: cuts.jobs },
    { table: "export_jobs", col: "tenant_id", time: "created_at", before: cuts.export_jobs }
  ];

  await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    for (const t of targets) {
      try {
        const r = await db
          .prepare(`DELETE FROM ${t.table} WHERE ${t.col} = ? AND ${t.time} < ?`)
          .bind(tenant, t.before)
          .run();
        deleted[t.table] = r?.meta?.changes ?? r?.changes ?? 0;
      } catch {
        deleted[t.table] = "skip";
      }
    }
  });

  return {
    ok: true,
    tenant,
    policy,
    deleted,
    enforced_at: new Date().toISOString()
  };
}
