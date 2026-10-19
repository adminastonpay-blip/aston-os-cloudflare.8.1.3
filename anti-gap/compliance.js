/**
 * Anti-Gap Phase 9 — Compliance fabric
 */

import { withDbFailover, ensureRoiSchema } from "./roi.js";
import { appendAudit } from "./secops.js";
import { emitEvent } from "./webhooks.js";

export const COMPLIANCE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS compliance_policies (
    tenant_id TEXT PRIMARY KEY,
    packs TEXT NOT NULL,
    retention_days INTEGER DEFAULT 365,
    ai_logging INTEGER DEFAULT 1,
    dsar_auto_export INTEGER DEFAULT 1,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS compliance_evidence_jobs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    r2_key TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comp_ev_tenant ON compliance_evidence_jobs (tenant_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS compliance_dsar (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_ref TEXT,
    status TEXT NOT NULL,
    export_key TEXT,
    purge_done INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comp_dsar_tenant ON compliance_dsar (tenant_id, created_at)`
];

export async function ensureComplianceSchema(db) {
  if (!db) return;
  await db.batch(COMPLIANCE_SCHEMA.map((sql) => db.prepare(sql)));
}

export const POLICY_PACKS = {
  gdpr: {
    id: "gdpr",
    name: "GDPR baseline",
    controls: ["data_export", "data_purge", "retention_policy", "access_scopes", "audit_chain", "breach_webhook"]
  },
  hipaa: {
    id: "hipaa",
    name: "HIPAA technical safeguards (subset)",
    controls: ["access_scopes", "audit_chain", "retention_policy", "encryption_transit", "breach_webhook", "minimum_necessary_scopes"]
  },
  ai_act: {
    id: "ai_act",
    name: "EU AI Act / ISO 42001 operational subset",
    controls: ["model_policy", "byok", "ai_budget", "inference_logging", "human_oversight_hook", "audit_chain"]
  },
  soc2: {
    id: "soc2",
    name: "SOC 2 evidence helpers",
    controls: ["roi_metering", "sla_metrics", "audit_chain", "change_via_flags", "backup_d1"]
  }
};

export function listPackCatalog() {
  return Object.values(POLICY_PACKS);
}

export async function getTenantPolicy(env, tenantId) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureComplianceSchema(db);
    return await db
      .prepare(`SELECT packs, retention_days, ai_logging, dsar_auto_export, updated_at FROM compliance_policies WHERE tenant_id = ?`)
      .bind(tenant)
      .first();
  });

  if (!res.ok) return { ok: false, error: "policy_unavailable" };

  if (!res.result) {
    return {
      ok: true,
      tenant,
      packs: [],
      retention_days: 365,
      ai_logging: true,
      dsar_auto_export: true,
      controls: [],
      default: true
    };
  }

  const row = res.result;
  let packs = [];
  try {
    packs = JSON.parse(row.packs);
  } catch {
    packs = [];
  }
  const controls = new Set();
  for (const p of packs) {
    const pack = POLICY_PACKS[p];
    if (pack) pack.controls.forEach((c) => controls.add(c));
  }

  return {
    ok: true,
    tenant,
    packs,
    retention_days: Number(row.retention_days) || 365,
    ai_logging: Boolean(row.ai_logging),
    dsar_auto_export: Boolean(row.dsar_auto_export),
    controls: [...controls],
    updated_at: row.updated_at
  };
}

export async function setTenantPolicy(env, tenantId, body) {
  const tenant = String(tenantId || "").slice(0, 120);
  const requested = Array.isArray(body.packs) ? body.packs.map(String) : [];
  const packs = requested.filter((p) => POLICY_PACKS[p]).slice(0, 10);
  const retentionDays = Math.min(3650, Math.max(1, Number(body.retention_days) || 365));
  const aiLogging = body.ai_logging === false ? 0 : 1;
  const dsarAuto = body.dsar_auto_export === false ? 0 : 1;
  const updatedAt = new Date().toISOString();

  await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    await ensureComplianceSchema(db);
    await db
      .prepare(
        `INSERT OR REPLACE INTO compliance_policies
         (tenant_id, packs, retention_days, ai_logging, dsar_auto_export, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(tenant, JSON.stringify(packs), retentionDays, aiLogging, dsarAuto, updatedAt)
      .run();
  });

  await appendAudit(env, tenant, "compliance.policy_set", tenant, { packs, retentionDays });
  return getTenantPolicy(env, tenant);
}

export async function buildEvidenceBundle(env, tenantId, opts = {}) {
  const tenant = String(tenantId || "").slice(0, 120);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const days = Math.min(90, Math.max(1, Number(opts.days) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  await withDbFailover(env, async (db) => {
    await ensureComplianceSchema(db);
    await db
      .prepare(`INSERT INTO compliance_evidence_jobs (id, tenant_id, status, created_at) VALUES (?, ?, 'running', ?)`)
      .bind(id, tenant, createdAt)
      .run();
  });

  const policy = await getTenantPolicy(env, tenant);
  const summary = {
    evidence_id: id,
    tenant,
    generated_at: createdAt,
    window_days: days,
    since,
    policy: policy.ok
      ? { packs: policy.packs, controls: policy.controls, retention_days: policy.retention_days }
      : null,
    counts: {},
    notes: [
      "Technical evidence from ASTON OS edge runtime",
      "Complement — not a substitute — for OneTrust/Vanta/Credo legal workflows"
    ]
  };

  await withDbFailover(env, async (db) => {
    try {
      const roi = await db
        .prepare(`SELECT COUNT(*) as c FROM roi_events WHERE tenant_id = ? AND created_at >= ?`)
        .bind(tenant, since)
        .first();
      summary.counts.roi_events = Number(roi?.c) || 0;
    } catch {
      summary.counts.roi_events = null;
    }
    try {
      const aud = await db
        .prepare(`SELECT COUNT(*) as c FROM secops_audit WHERE tenant_id = ? AND created_at >= ?`)
        .bind(tenant, since)
        .first();
      summary.counts.audit_entries = Number(aud?.c) || 0;
    } catch {
      summary.counts.audit_entries = null;
    }
    try {
      const del = await db
        .prepare(`SELECT COUNT(*) as c FROM webhook_deliveries WHERE tenant_id = ? AND created_at >= ?`)
        .bind(tenant, since)
        .first();
      summary.counts.webhook_deliveries = Number(del?.c) || 0;
    } catch {
      summary.counts.webhook_deliveries = null;
    }
    try {
      const sec = await db
        .prepare(`SELECT COUNT(*) as c FROM secops_events WHERE tenant_id = ? AND created_at >= ?`)
        .bind(tenant, since)
        .first();
      summary.counts.secops_events = Number(sec?.c) || 0;
    } catch {
      summary.counts.secops_events = null;
    }
  });

  let r2Key = null;
  if (env.R2) {
    r2Key = `compliance/${tenant}/evidence/${id}.json`;
    try {
      await env.R2.put(r2Key, JSON.stringify(summary, null, 2), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { tenant, type: "evidence_bundle" }
      });
    } catch (e) {
      summary.r2_error = String(e?.message || e).slice(0, 200);
      r2Key = null;
    }
  }

  const completedAt = new Date().toISOString();
  await withDbFailover(env, async (db) => {
    await db
      .prepare(
        `UPDATE compliance_evidence_jobs SET status = ?, r2_key = ?, summary = ?, completed_at = ? WHERE id = ?`
      )
      .bind("completed", r2Key, JSON.stringify(summary).slice(0, 100000), completedAt, id)
      .run();
  });

  await appendAudit(env, tenant, "compliance.evidence_bundle", id, { r2_key: r2Key, days });

  if (opts.ctx) {
    await emitEvent(
      env,
      tenant,
      "compliance.evidence_ready",
      { evidence_id: id, r2_key: r2Key },
      { ctx: opts.ctx, max_attempts: 2 }
    );
  }

  return { ok: true, evidence_id: id, r2_key: r2Key, summary };
}

export async function createDsar(env, tenantId, body, opts = {}) {
  const tenant = String(tenantId || "").slice(0, 120);
  const id = crypto.randomUUID();
  const subjectRef = String(body.subject_ref || body.email || body.user_id || "unknown").slice(0, 200);
  const createdAt = new Date().toISOString();

  await withDbFailover(env, async (db) => {
    await ensureComplianceSchema(db);
    await db
      .prepare(
        `INSERT INTO compliance_dsar (id, tenant_id, subject_ref, status, created_at)
         VALUES (?, ?, ?, 'open', ?)`
      )
      .bind(id, tenant, subjectRef, createdAt)
      .run();
  });

  await appendAudit(env, tenant, "compliance.dsar_open", id, { subject_ref: subjectRef });

  const policy = await getTenantPolicy(env, tenant);
  let exportHint = null;
  if (policy.ok && policy.dsar_auto_export) {
    exportHint =
      "Run POST /v1/export for tenant data, then POST /v1/compliance/dsar/" +
      id +
      "/complete with export_key";
  }

  if (opts.ctx) {
    await emitEvent(
      env,
      tenant,
      "compliance.dsar_opened",
      { dsar_id: id, subject_ref: subjectRef },
      { ctx: opts.ctx, max_attempts: 2 }
    );
  }

  return {
    ok: true,
    dsar_id: id,
    subject_ref: subjectRef,
    status: "open",
    next: exportHint,
    packs: policy.ok ? policy.packs : []
  };
}

export async function completeDsar(env, tenantId, dsarId, body = {}) {
  const tenant = String(tenantId || "").slice(0, 120);
  const id = String(dsarId || "").slice(0, 80);
  const exportKey = body.export_key ? String(body.export_key).slice(0, 500) : null;
  const purgeDone = body.purge_done ? 1 : 0;
  const completedAt = new Date().toISOString();

  await withDbFailover(env, async (db) => {
    await ensureComplianceSchema(db);
    await db
      .prepare(
        `UPDATE compliance_dsar SET status = ?, export_key = ?, purge_done = ?, completed_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
      .bind("completed", exportKey, purgeDone, completedAt, id, tenant)
      .run();
  });

  await appendAudit(env, tenant, "compliance.dsar_complete", id, {
    export_key: exportKey,
    purge_done: Boolean(purgeDone)
  });

  return { ok: true, dsar_id: id, status: "completed", export_key: exportKey, purge_done: Boolean(purgeDone) };
}

export async function listDsar(env, tenantId, limit = 50) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureComplianceSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, subject_ref, status, export_key, purge_done, created_at, completed_at
         FROM compliance_dsar WHERE tenant_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .bind(tenant, Math.min(100, Math.max(1, limit)))
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "dsar_unavailable" };
  return { ok: true, tenant, requests: res.result };
}

export async function listEvidenceJobs(env, tenantId, limit = 20) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureComplianceSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, status, r2_key, created_at, completed_at FROM compliance_evidence_jobs
         WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .bind(tenant, Math.min(50, Math.max(1, limit)))
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "evidence_unavailable" };
  return { ok: true, tenant, jobs: res.result };
}
