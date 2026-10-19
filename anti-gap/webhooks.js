/**
 * Anti-Gap Phase 7 — reliable webhooks + event bus
 */

import { withDbFailover, ensureRoiSchema } from "./roi.js";

export const WEBHOOK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT,
    events TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wh_ep_tenant ON webhook_endpoints (tenant_id, active)`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_status INTEGER,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wh_del_tenant ON webhook_deliveries (tenant_id, created_at)`
];

export async function ensureWebhookSchema(db) {
  if (!db) return;
  await db.batch(WEBHOOK_SCHEMA.map((sql) => db.prepare(sql)));
}

function parseEvents(raw) {
  if (Array.isArray(raw)) return raw.map(String).slice(0, 30);
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) return j.map(String).slice(0, 30);
    } catch {
      return raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
    }
  }
  return ["*"];
}

export async function registerWebhook(env, tenantId, body) {
  const tenant = String(tenantId || "").slice(0, 120);
  const url = String(body.url || "").trim();
  if (!tenant) return { ok: false, error: "tenant_required" };
  if (!url.startsWith("https://")) return { ok: false, error: "url_must_be_https" };
  if (url.length > 500) return { ok: false, error: "url_too_long" };

  const id = body.id || crypto.randomUUID();
  const events = parseEvents(body.events ?? body.event_types ?? ["*"]);
  const secret = body.secret ? String(body.secret).slice(0, 200) : null;
  const createdAt = new Date().toISOString();

  await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    await ensureWebhookSchema(db);
    await db
      .prepare(
        `INSERT OR REPLACE INTO webhook_endpoints (id, tenant_id, url, secret, events, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .bind(id, tenant, url, secret, JSON.stringify(events), createdAt)
      .run();
  });

  return {
    ok: true,
    endpoint: { id, tenant, url, events, active: true, created_at: createdAt }
  };
}

export async function listWebhooks(env, tenantId) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureWebhookSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, url, events, active, created_at FROM webhook_endpoints
         WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`
      )
      .bind(tenant)
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "webhooks_unavailable" };
  return {
    ok: true,
    tenant,
    endpoints: (res.result || []).map((r) => ({
      id: r.id,
      url: r.url,
      events: parseEvents(r.events),
      active: Boolean(r.active),
      created_at: r.created_at
    }))
  };
}

export async function deleteWebhook(env, tenantId, endpointId) {
  const tenant = String(tenantId || "").slice(0, 120);
  const id = String(endpointId || "").slice(0, 80);
  await withDbFailover(env, async (db) => {
    await ensureWebhookSchema(db);
    await db
      .prepare(`DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenant)
      .run();
  });
  return { ok: true, deleted: id };
}

async function hmacSign(secret, body) {
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deliverOnce(url, secret, envelope) {
  const body = JSON.stringify(envelope);
  const headers = {
    "content-type": "application/json",
    "user-agent": "ASTON-OS-Webhooks/7",
    "x-aston-event": envelope.type,
    "x-aston-delivery": envelope.delivery_id
  };
  const sig = await hmacSign(secret, body);
  if (sig) headers["x-aston-signature"] = `sha256=${sig}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
    clearTimeout(timer);
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, error: ok ? null : `http_${res.status}` };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

export async function emitEvent(env, tenantId, type, data = {}, opts = {}) {
  const tenant = String(tenantId || "").slice(0, 120);
  const eventType = String(type || "custom").slice(0, 80);
  const eventId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const res = await withDbFailover(env, async (db) => {
    await ensureWebhookSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, url, secret, events FROM webhook_endpoints
         WHERE tenant_id = ? AND active = 1 LIMIT 20`
      )
      .bind(tenant)
      .all();
    return rows?.results || [];
  });

  if (!res.ok) return { ok: false, error: "webhooks_unavailable", detail: res.errors };

  const endpoints = (res.result || []).filter((ep) => {
    const ev = parseEvents(ep.events);
    return ev.includes("*") || ev.includes(eventType);
  });

  if (!endpoints.length) {
    return { ok: true, event_id: eventId, deliveries: [], note: "no_matching_endpoints" };
  }

  const deliveries = [];
  const maxAttempts = Math.min(5, Math.max(1, Number(opts.max_attempts) || 3));

  for (const ep of endpoints) {
    const deliveryId = crypto.randomUUID();
    const envelope = {
      id: eventId,
      delivery_id: deliveryId,
      type: eventType,
      tenant,
      created_at: createdAt,
      data
    };

    await withDbFailover(env, async (db) => {
      await db
        .prepare(
          `INSERT INTO webhook_deliveries
           (id, tenant_id, endpoint_id, event_type, payload, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .bind(
          deliveryId,
          tenant,
          ep.id,
          eventType,
          JSON.stringify(envelope).slice(0, 100000),
          "pending",
          createdAt,
          createdAt
        )
        .run();
    });

    deliveries.push({ delivery_id: deliveryId, endpoint_id: ep.id, url: ep.url });

    if (opts.schedule !== false) {
      const run = async () => {
        let last = { ok: false, status: 0, error: "not_attempted" };
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          last = await deliverOnce(ep.url, ep.secret, envelope);
          await withDbFailover(env, async (db) => {
            await db
              .prepare(
                `UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, updated_at = ?
                 WHERE id = ?`
              )
              .bind(
                last.ok ? "delivered" : attempt >= maxAttempts ? "failed" : "retrying",
                attempt,
                last.status,
                last.error,
                new Date().toISOString(),
                deliveryId
              )
              .run();
          });
          if (last.ok) break;
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 250 * attempt * attempt));
          }
        }
        return last;
      };
      if (opts.ctx?.waitUntil) {
        opts.ctx.waitUntil(run().catch((e) => console.error("[webhook]", e?.message || e)));
      } else {
        await run();
      }
    }
  }

  return {
    ok: true,
    event_id: eventId,
    type: eventType,
    tenant,
    deliveries
  };
}

export async function listDeliveries(env, tenantId, limit = 50) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureWebhookSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, endpoint_id, event_type, status, attempts, last_status, last_error, created_at, updated_at
         FROM webhook_deliveries WHERE tenant_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .bind(tenant, Math.min(100, Math.max(1, limit)))
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "deliveries_unavailable" };
  return { ok: true, tenant, deliveries: res.result };
}

export async function retryPendingDeliveries(env) {
  const res = await withDbFailover(env, async (db) => {
    await ensureWebhookSchema(db);
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const rows = await db
      .prepare(
        `SELECT d.id, d.tenant_id, d.endpoint_id, d.payload, d.attempts, e.url, e.secret
         FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.status IN ('pending', 'retrying', 'failed') AND d.attempts < 5
           AND d.created_at < ?
         ORDER BY d.created_at ASC LIMIT 20`
      )
      .bind(cutoff)
      .all();
    return rows?.results || [];
  });

  if (!res.ok) return { ok: false, error: "cron_unavailable" };
  const rows = res.result || [];
  let delivered = 0;

  for (const row of rows) {
    let envelope;
    try {
      envelope = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const result = await deliverOnce(row.url, row.secret, envelope);
    const attempts = (Number(row.attempts) || 0) + 1;
    await withDbFailover(env, async (db) => {
      await db
        .prepare(
          `UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(
          result.ok ? "delivered" : attempts >= 5 ? "failed" : "retrying",
          attempts,
          result.status,
          result.error,
          new Date().toISOString(),
          row.id
        )
        .run();
    });
    if (result.ok) delivered++;
  }

  return { ok: true, scanned: rows.length, delivered };
}
