/**
 * Anti-Gap Phase 3 — tenant export (R2) + purge (anti lock-in)
 */

import { ensureRoiSchema, withDbFailover } from "./roi.js";

const EXPORT_TABLES = [
  { name: "records", tenantCol: "tenant" },
  { name: "ledger", tenantCol: "tenant" },
  { name: "audit_log", tenantCol: "tenant" },
  { name: "usage", tenantCol: "tenant" },
  { name: "media", tenantCol: "tenant" },
  { name: "jobs", tenantCol: "tenant" },
  { name: "webhooks", tenantCol: "tenant" },
  { name: "roi_events", tenantCol: "tenant_id" }
];

async function safeSelect(db, table, tenantCol, tenant, limit = 5000) {
  try {
    const r = await db
      .prepare(`SELECT * FROM ${table} WHERE ${tenantCol} = ? LIMIT ?`)
      .bind(tenant, limit)
      .all();
    return r?.results || [];
  } catch {
    return [];
  }
}

export async function exportTenant(env, tenantId, actor = "api") {
  const tenant = String(tenantId || "").slice(0, 120);
  if (!tenant) return { ok: false, error: "tenant_required" };
  if (!env.ASTON_R2) return { ok: false, error: "r2_required" };

  const jobId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const day = createdAt.slice(0, 10);
  const r2Key = `exports/${tenant}/${day}/${jobId}.jsonl`;

  await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    try {
      await db
        .prepare(
          `INSERT INTO export_jobs (id, tenant_id, status, r2_key, created_at, finished_at)
           VALUES (?, ?, ?, ?, ?, NULL)`
        )
        .bind(jobId, tenant, "running", r2Key, createdAt)
        .run();
    } catch {
      /* table may lag */
    }
  });

  const lines = [];
  lines.push(
    JSON.stringify({
      type: "meta",
      job_id: jobId,
      tenant,
      actor,
      created_at: createdAt,
      format: "jsonl",
      note: "ASTON OS anti-lock-in export"
    })
  );

  const counts = {};
  await withDbFailover(env, async (db) => {
    for (const t of EXPORT_TABLES) {
      const rows = await safeSelect(db, t.name, t.tenantCol, tenant);
      counts[t.name] = rows.length;
      for (const row of rows) {
        lines.push(JSON.stringify({ type: "row", table: t.name, data: row }));
      }
    }
  });

  try {
    const listed = await env.ASTON_R2.list({ prefix: `${tenant}/`, limit: 500 });
    const objects = listed?.objects || [];
    counts.r2_objects = objects.length;
    for (const obj of objects) {
      lines.push(
        JSON.stringify({
          type: "r2_object",
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded
        })
      );
    }
  } catch {
    counts.r2_objects = 0;
  }

  lines.push(JSON.stringify({ type: "summary", counts, finished_at: new Date().toISOString() }));

  const body = lines.join("\n");
  await env.ASTON_R2.put(r2Key, body, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { tenant, job_id: jobId, actor }
  });

  await withDbFailover(env, async (db) => {
    try {
      await db
        .prepare(`UPDATE export_jobs SET status = ?, finished_at = ? WHERE id = ?`)
        .bind("done", new Date().toISOString(), jobId)
        .run();
    } catch {
      /* ignore */
    }
  });

  return {
    ok: true,
    job_id: jobId,
    tenant,
    r2_key: r2Key,
    counts,
    bytes: body.length,
    download: {
      note: "Fetch via Worker GET /v1/export/download?job_id=... or R2 console",
      path: `/v1/export/download?job_id=${jobId}`
    }
  };
}

export async function downloadExport(env, tenantId, jobId) {
  const tenant = String(tenantId || "").slice(0, 120);
  const id = String(jobId || "").slice(0, 80);
  if (!env.ASTON_R2) return { ok: false, error: "r2_required" };

  let r2Key = null;
  await withDbFailover(env, async (db) => {
    try {
      await ensureRoiSchema(db);
      const row = await db
        .prepare(`SELECT r2_key, tenant_id, status FROM export_jobs WHERE id = ?`)
        .bind(id)
        .first();
      if (row && row.tenant_id === tenant) r2Key = row.r2_key;
    } catch {
      /* ignore */
    }
  });

  if (!r2Key) return { ok: false, error: "export_not_found" };

  const obj = await env.ASTON_R2.get(r2Key);
  if (!obj) return { ok: false, error: "export_missing_in_r2" };

  return {
    ok: true,
    body: obj.body,
    contentType: obj.httpMetadata?.contentType || "application/x-ndjson",
    r2_key: r2Key
  };
}

export async function purgeTenant(env, tenantId, opts = {}) {
  const tenant = String(tenantId || "").slice(0, 120);
  if (!tenant) return { ok: false, error: "tenant_required" };
  if (tenant === "default" && opts.allow_default !== true) {
    return { ok: false, error: "refuse_purge_default_without_flag" };
  }

  const deleted = {};
  const purgeR2 = opts.purge_r2 !== false;

  await withDbFailover(env, async (db) => {
    for (const t of EXPORT_TABLES) {
      try {
        const r = await db
          .prepare(`DELETE FROM ${t.name} WHERE ${t.tenantCol} = ?`)
          .bind(tenant)
          .run();
        deleted[t.name] = r?.meta?.changes ?? r?.changes ?? 0;
      } catch {
        deleted[t.name] = "skip";
      }
    }
  });

  let r2Deleted = 0;
  if (purgeR2 && env.ASTON_R2) {
    try {
      const listed = await env.ASTON_R2.list({ prefix: `${tenant}/`, limit: 1000 });
      const keys = (listed?.objects || []).map((o) => o.key);
      if (keys.length) {
        await env.ASTON_R2.delete(keys);
        r2Deleted = keys.length;
      }
    } catch {
      r2Deleted = -1;
    }
  }

  if (env.ASTON_KV) {
    try {
      await env.ASTON_KV.delete(`aston:policy:models:${tenant}`);
      await env.ASTON_KV.delete(`aston:sla:snap:${tenant}`);
    } catch {
      /* ignore */
    }
  }

  return {
    ok: true,
    tenant,
    deleted,
    r2_deleted: r2Deleted,
    purged_at: new Date().toISOString()
  };
}
