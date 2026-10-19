/**
 * Anti-Gap Phase 8 — SecOps fabric
 */

import { withDbFailover, ensureRoiSchema } from "./roi.js";
import { emitEvent } from "./webhooks.js";

export const SECOPS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS secops_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    source TEXT NOT NULL,
    severity TEXT,
    category TEXT,
    title TEXT,
    raw TEXT,
    normalized TEXT,
    risk_score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'open',
    playbook_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_secops_tenant ON secops_events (tenant_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS secops_playbooks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    match_source TEXT,
    match_category TEXT,
    min_severity TEXT,
    actions TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_secops_pb_tenant ON secops_playbooks (tenant_id, active)`,
  `CREATE TABLE IF NOT EXISTS secops_audit (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    action TEXT NOT NULL,
    ref_id TEXT,
    prev_hash TEXT,
    hash TEXT NOT NULL,
    meta TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_secops_audit_tenant ON secops_audit (tenant_id, created_at)`
];

export async function ensureSecopsSchema(db) {
  if (!db) return;
  await db.batch(SECOPS_SCHEMA.map((sql) => db.prepare(sql)));
}

const SEV_RANK = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };

export function normalizeSecurityEvent(source, body) {
  const src = String(source || body.source || "generic").toLowerCase();
  const now = new Date().toISOString();

  if (src === "cloudflare_waf" || src === "cloudflare") {
    return {
      source: "cloudflare_waf",
      severity: mapCfAction(body.Action || body.action),
      category: body.RuleID || body.rule_id ? "waf_rule" : "waf",
      title: String(body.RuleMessage || body.message || body.Action || "Cloudflare WAF event").slice(0, 300),
      actor: body.ClientIP || body.client_ip || null,
      resource: body.ClientRequestURI || body.url || null,
      raw_refs: { ray_id: body.RayID || body.ray_id }
    };
  }

  if (src === "crowdstrike" || src === "falcon") {
    const det = body.event || body.detection || body;
    return {
      source: "crowdstrike",
      severity: mapCsSeverity(det.SeverityName || det.severity || det.Severity),
      category: String(det.Tactic || det.technique || det.DetectName || "endpoint").slice(0, 80),
      title: String(det.DetectName || det.Name || det.description || "CrowdStrike detection").slice(0, 300),
      actor: det.UserName || det.user || null,
      resource: det.Hostname || det.host || det.aid || null,
      raw_refs: { detection_id: det.DetectionId || det.id }
    };
  }

  if (src === "okta") {
    return {
      source: "okta",
      severity: body.outcome?.result === "FAILURE" ? "medium" : "info",
      category: String(body.eventType || body.event_type || "identity").slice(0, 80),
      title: String(body.displayMessage || body.message || body.eventType || "Okta event").slice(0, 300),
      actor: body.actor?.alternateId || body.actor?.displayName || null,
      resource: body.target?.[0]?.alternateId || null,
      raw_refs: { uuid: body.uuid || body.eventId }
    };
  }

  return {
    source: src === "generic" ? "generic" : src,
    severity: String(body.severity || "medium").toLowerCase(),
    category: String(body.category || body.type || "custom").slice(0, 80),
    title: String(body.title || body.message || body.type || "Security event").slice(0, 300),
    actor: body.actor || body.user || null,
    resource: body.resource || body.host || null,
    raw_refs: body.refs || null,
    received_at: now
  };
}

function mapCfAction(action) {
  const a = String(action || "").toLowerCase();
  if (a.includes("block") || a.includes("challenge")) return "high";
  if (a.includes("jschallenge") || a.includes("managed_challenge")) return "medium";
  return "low";
}

function mapCsSeverity(s) {
  const v = String(s || "").toLowerCase();
  if (v.includes("critical") || v === "5") return "critical";
  if (v.includes("high") || v === "4") return "high";
  if (v.includes("medium") || v === "3") return "medium";
  if (v.includes("low") || v === "2") return "low";
  return "info";
}

export function computeRiskScore(normalized) {
  const base = (SEV_RANK[normalized.severity] || 2) * 15;
  let bonus = 0;
  if (normalized.source === "crowdstrike") bonus += 10;
  if (normalized.category?.includes("credential") || normalized.category?.includes("identity")) bonus += 8;
  if (normalized.category?.includes("ransomware") || normalized.category?.includes("malware")) bonus += 20;
  return Math.min(100, base + bonus);
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function appendAudit(env, tenant, action, refId, meta = {}) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let prevHash = "genesis";

  await withDbFailover(env, async (db) => {
    await ensureSecopsSchema(db);
    const last = await db
      .prepare(`SELECT hash FROM secops_audit WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(tenant)
      .first();
    if (last?.hash) prevHash = last.hash;

    const payload = JSON.stringify({ id, tenant, action, refId, prevHash, meta, createdAt });
    const hash = await sha256Hex(payload);

    await db
      .prepare(
        `INSERT INTO secops_audit (id, tenant_id, action, ref_id, prev_hash, hash, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, tenant, action, refId, prevHash, hash, JSON.stringify(meta).slice(0, 8000), createdAt)
      .run();
  });

  return { id, prev_hash: prevHash };
}

export async function ingestSecopsEvent(env, tenantId, source, body, opts = {}) {
  const tenant = String(tenantId || "").slice(0, 120);
  const normalized = normalizeSecurityEvent(source, body || {});
  const risk = computeRiskScore(normalized);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    await ensureSecopsSchema(db);
    await db
      .prepare(
        `INSERT INTO secops_events
         (id, tenant_id, source, severity, category, title, raw, normalized, risk_score, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .bind(
        id, tenant, normalized.source, normalized.severity, normalized.category, normalized.title,
        JSON.stringify(body || {}).slice(0, 50000),
        JSON.stringify(normalized).slice(0, 20000),
        risk, createdAt
      )
      .run();
  });

  await appendAudit(env, tenant, "secops.ingest", id, {
    source: normalized.source,
    severity: normalized.severity,
    risk
  });

  const playbook = await matchPlaybook(env, tenant, normalized);
  let playbookResult = null;
  if (playbook) {
    playbookResult = await runPlaybookActions(env, tenant, playbook, {
      event_id: id,
      normalized,
      risk
    }, opts.ctx);
    await withDbFailover(env, async (db) => {
      await db
        .prepare(`UPDATE secops_events SET playbook_id = ?, status = ? WHERE id = ?`)
        .bind(playbook.id, playbookResult?.status || "playbook_run", id)
        .run();
    });
  }

  if (opts.emit !== false) {
    await emitEvent(
      env,
      tenant,
      `secops.${normalized.severity}`,
      {
        event_id: id,
        source: normalized.source,
        title: normalized.title,
        risk_score: risk,
        category: normalized.category
      },
      { ctx: opts.ctx, max_attempts: 2 }
    );
  }

  return {
    ok: true,
    event_id: id,
    normalized,
    risk_score: risk,
    playbook: playbook ? { id: playbook.id, name: playbook.name, result: playbookResult } : null
  };
}

async function matchPlaybook(env, tenant, normalized) {
  const res = await withDbFailover(env, async (db) => {
    await ensureSecopsSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, name, match_source, match_category, min_severity, actions
         FROM secops_playbooks WHERE tenant_id = ? AND active = 1 LIMIT 50`
      )
      .bind(tenant)
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return null;

  const sev = SEV_RANK[normalized.severity] || 1;
  for (const pb of res.result || []) {
    if (pb.match_source && pb.match_source !== "*" && pb.match_source !== normalized.source) continue;
    if (pb.match_category && pb.match_category !== "*" && pb.match_category !== normalized.category) continue;
    const minSev = SEV_RANK[pb.min_severity] || 1;
    if (sev < minSev) continue;
    return {
      id: pb.id,
      name: pb.name,
      actions: (() => {
        try {
          return JSON.parse(pb.actions);
        } catch {
          return [];
        }
      })()
    };
  }
  return null;
}

async function runPlaybookActions(env, tenant, playbook, ctxData, waitCtx) {
  const results = [];
  const actions = Array.isArray(playbook.actions) ? playbook.actions : [];

  for (const act of actions.slice(0, 10)) {
    const type = act.type || act.action;
    try {
      if (type === "emit_event") {
        const r = await emitEvent(
          env,
          tenant,
          act.event_type || "secops.playbook",
          { ...ctxData, playbook_id: playbook.id, note: act.note },
          { ctx: waitCtx, max_attempts: 2 }
        );
        results.push({ type, ok: r.ok });
      } else if (type === "audit") {
        await appendAudit(env, tenant, act.action_name || "secops.playbook", ctxData.event_id, {
          playbook_id: playbook.id,
          note: act.note
        });
        results.push({ type, ok: true });
      } else if (type === "set_status") {
        await withDbFailover(env, async (db) => {
          await db
            .prepare(`UPDATE secops_events SET status = ? WHERE id = ? AND tenant_id = ?`)
            .bind(String(act.status || "triaged").slice(0, 40), ctxData.event_id, tenant)
            .run();
        });
        results.push({ type, ok: true, status: act.status });
      } else {
        results.push({ type, ok: false, error: "unknown_action" });
      }
    } catch (e) {
      results.push({ type, ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }

  await appendAudit(env, tenant, "secops.playbook_run", playbook.id, {
    event_id: ctxData.event_id,
    results
  });

  return { status: "playbook_run", results };
}

export async function savePlaybook(env, tenantId, body) {
  const tenant = String(tenantId || "").slice(0, 120);
  const id = body.id || crypto.randomUUID();
  const name = String(body.name || "playbook").slice(0, 120);
  const actions = Array.isArray(body.actions) ? body.actions.slice(0, 20) : [];
  const createdAt = new Date().toISOString();

  await withDbFailover(env, async (db) => {
    await ensureSecopsSchema(db);
    await db
      .prepare(
        `INSERT OR REPLACE INTO secops_playbooks
         (id, tenant_id, name, match_source, match_category, min_severity, actions, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .bind(
        id, tenant, name,
        body.match_source || "*",
        body.match_category || "*",
        body.min_severity || "medium",
        JSON.stringify(actions),
        createdAt
      )
      .run();
  });

  return {
    ok: true,
    playbook: {
      id, name,
      match_source: body.match_source || "*",
      match_category: body.match_category || "*",
      min_severity: body.min_severity || "medium",
      actions
    }
  };
}

export async function listPlaybooks(env, tenantId) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureSecopsSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, name, match_source, match_category, min_severity, actions, active, created_at
         FROM secops_playbooks WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`
      )
      .bind(tenant)
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "playbooks_unavailable" };
  return {
    ok: true,
    tenant,
    playbooks: (res.result || []).map((p) => ({
      ...p,
      actions: (() => {
        try {
          return JSON.parse(p.actions);
        } catch {
          return [];
        }
      })(),
      active: Boolean(p.active)
    }))
  };
}

export async function listSecopsEvents(env, tenantId, limit = 50) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureSecopsSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, source, severity, category, title, risk_score, status, playbook_id, created_at
         FROM secops_events WHERE tenant_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .bind(tenant, Math.min(100, Math.max(1, limit)))
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "events_unavailable" };
  return { ok: true, tenant, events: res.result };
}

export async function listAuditChain(env, tenantId, limit = 50) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureSecopsSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, action, ref_id, prev_hash, hash, created_at
         FROM secops_audit WHERE tenant_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .bind(tenant, Math.min(100, Math.max(1, limit)))
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "audit_unavailable" };
  return { ok: true, tenant, audit: res.result };
}
