// ASTON OS — Phase 9 Change Feed + Webhooks
// Durable event log + outbound webhook delivery (Palantir-style notifications lite)

const VERSION = "12.2.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function slugId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

function safeParse(s, fb) {
  try { return s ? JSON.parse(s) : fb; } catch { return fb; }
}

export async function ensureEventsSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS change_events (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      event TEXT NOT NULL,
      resource_kind TEXT,
      resource_id TEXT,
      payload TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_chg_tenant ON change_events (tenant, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_chg_res ON change_events (tenant, resource_kind, resource_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT,
      events TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      fail_count INTEGER NOT NULL DEFAULT 0,
      last_status INTEGER,
      last_error TEXT,
      last_delivery_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_wh_tenant ON webhooks (tenant, active)")
  ]);
}

/** Emit a change event + fan-out to matching webhooks */
export async function emitChangeEvent(env, {
  tenant,
  event,
  resource_kind = null,
  resource_id = null,
  payload = null,
  actor = "system",
  deliver = true
}) {
  if (!env?.ASTON_DB) return null;
  try {
    await ensureEventsSchema(env.ASTON_DB);
    const id = slugId("evt");
    const now = new Date().toISOString();
    const body = payload && typeof payload === "object" ? payload : { value: payload };
    await env.ASTON_DB.prepare(
      `INSERT INTO change_events (id, tenant, event, resource_kind, resource_id, payload, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, tenant, String(event).slice(0, 80),
      resource_kind ? String(resource_kind).slice(0, 40) : null,
      resource_id ? String(resource_id).slice(0, 120) : null,
      JSON.stringify(body).slice(0, 8000),
      actor, now
    ).run();

    if (deliver) {
      // best-effort delivery (await for correctness in Worker)
      await dispatchWebhooks(env, tenant, event, {
        id,
        event,
        resource_kind,
        resource_id,
        payload: body,
        actor,
        created_at: now
      });
    }
    return id;
  } catch (e) {
    console.error("emitChangeEvent", e?.message || e);
    return null;
  }
}

async function dispatchWebhooks(env, tenant, eventName, data) {
  if (!env.ASTON_DB) return { sent: 0 };
  try {
    await ensureEventsSchema(env.ASTON_DB);
    const rows = await env.ASTON_DB.prepare(
      "SELECT id, url, secret, events, fail_count FROM webhooks WHERE tenant = ? AND active = 1"
    ).bind(tenant).all();
    let sent = 0;
    for (const wh of rows.results || []) {
      let events = [];
      try { events = JSON.parse(wh.events || "[]"); } catch { events = []; }
      if (Array.isArray(events) && events.length && !events.includes(eventName) && !events.includes("*")) continue;

      const envelope = JSON.stringify({
        event: eventName,
        tenant,
        ts: new Date().toISOString(),
        data
      });
      const headers = {
        "content-type": "application/json",
        "x-aston-event": eventName,
        "x-aston-event-id": data.id || "",
        "user-agent": "ASTON-OS-Webhooks/12.2"
      };
      if (wh.secret) {
        try {
          const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(String(wh.secret)),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
          );
          const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(envelope));
          const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
          headers["x-aston-signature"] = `sha256=${hex}`;
        } catch (_) {
          headers["x-aston-signature"] = String(wh.secret);
        }
      }

      let status = 0;
      let err = null;
      try {
        const res = await fetch(wh.url, { method: "POST", headers, body: envelope });
        status = res.status;
        if (!res.ok) err = `http_${res.status}`;
        else sent++;
      } catch (e) {
        err = String(e?.message || e).slice(0, 200);
        status = 0;
      }

      const failInc = err ? (Number(wh.fail_count) || 0) + 1 : 0;
      const deactivate = failInc >= 20 ? 0 : 1;
      try {
        await env.ASTON_DB.prepare(
          `UPDATE webhooks SET last_status = ?, last_error = ?, last_delivery_at = ?, fail_count = ?,
           active = CASE WHEN ? = 0 THEN 0 ELSE active END, updated_at = ? WHERE id = ?`
        ).bind(
          status, err, new Date().toISOString(),
          err ? failInc : 0, deactivate,
          new Date().toISOString(), wh.id
        ).run();
      } catch (_) {}
    }
    return { sent };
  } catch (e) {
    console.error("dispatchWebhooks", e?.message || e);
    return { sent: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

export async function handleEventsFeed(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureEventsSchema(env.ASTON_DB);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const actor = auth.actor || "api";
  const db = env.ASTON_DB;

  if (method === "GET" && (path === "/v1/events" || path === "/v1/events/status" || path === "/v1/webhooks/status")) {
    return json({
      ok: true,
      phase: "9-webhooks-feed",
      version: VERSION,
      endpoints: {
        feed: "GET /v1/events/feed?since=&limit=",
        emit: "POST /v1/events/emit",
        webhooks: "GET|POST /v1/webhooks",
        test: "POST /v1/webhooks/:id/test"
      },
      common_events: [
        "entity.created", "entity.updated", "relation.created",
        "aip.plan.proposed", "aip.plan.approved", "aip.plan.executed",
        "pipeline.completed", "case.created", "case.status_changed",
        "security.marking.set", "audit.exported"
      ]
    }, 200, cors);
  }

  // Change feed (poll)
  if (method === "GET" && path === "/v1/events/feed") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
    const since = url.searchParams.get("since");
    const eventFilter = url.searchParams.get("event");
    let rows;
    if (since && eventFilter) {
      rows = await db.prepare(
        `SELECT id, event, resource_kind, resource_id, payload, actor, created_at
         FROM change_events WHERE tenant = ? AND created_at > ? AND event = ?
         ORDER BY created_at ASC LIMIT ?`
      ).bind(tenant, since, eventFilter, limit).all();
    } else if (since) {
      rows = await db.prepare(
        `SELECT id, event, resource_kind, resource_id, payload, actor, created_at
         FROM change_events WHERE tenant = ? AND created_at > ?
         ORDER BY created_at ASC LIMIT ?`
      ).bind(tenant, since, limit).all();
    } else if (eventFilter) {
      rows = await db.prepare(
        `SELECT id, event, resource_kind, resource_id, payload, actor, created_at
         FROM change_events WHERE tenant = ? AND event = ?
         ORDER BY created_at DESC LIMIT ?`
      ).bind(tenant, eventFilter, limit).all();
    } else {
      rows = await db.prepare(
        `SELECT id, event, resource_kind, resource_id, payload, actor, created_at
         FROM change_events WHERE tenant = ?
         ORDER BY created_at DESC LIMIT ?`
      ).bind(tenant, limit).all();
    }
    const events = (rows.results || []).map((r) => ({
      ...r,
      payload: safeParse(r.payload, {})
    }));
    const cursor = events.length
      ? (events[events.length - 1].created_at || events[0].created_at)
      : null;
    return json({ ok: true, tenant, count: events.length, cursor, events }, 200, cors);
  }

  // Manual emit (for tests / external systems)
  if (method === "POST" && path === "/v1/events/emit") {
    const body = await readJson(request);
    if (!body?.event) return json({ ok: false, error: "event_required" }, 400, cors);
    const id = await emitChangeEvent(env, {
      tenant,
      event: body.event,
      resource_kind: body.resource_kind,
      resource_id: body.resource_id,
      payload: body.payload || body.data || {},
      actor: body.actor || actor,
      deliver: body.deliver !== false
    });
    if (!id) return json({ ok: false, error: "emit_failed" }, 500, cors);
    return json({ ok: true, event_id: id }, 201, cors);
  }

  // List webhooks
  if (method === "GET" && path === "/v1/webhooks") {
    const rows = await db.prepare(
      `SELECT id, url, events, active, fail_count, last_status, last_error, last_delivery_at, created_at, updated_at
       FROM webhooks WHERE tenant = ? ORDER BY created_at DESC LIMIT 50`
    ).bind(tenant).all();
    return json({
      ok: true,
      webhooks: (rows.results || []).map((w) => ({
        ...w,
        events: safeParse(w.events, []),
        active: Boolean(w.active)
      }))
    }, 200, cors);
  }

  // Create webhook
  if (method === "POST" && path === "/v1/webhooks") {
    const body = await readJson(request);
    const whUrl = String(body?.url || "").trim();
    if (!whUrl.startsWith("https://") && !whUrl.startsWith("http://"))
      return json({ ok: false, error: "url_must_be_http_s" }, 400, cors);
    const events = Array.isArray(body?.events) ? body.events : ["*"];
    const id = slugId("wh");
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO webhooks (id, tenant, url, secret, events, active, fail_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`
    ).bind(
      id, tenant, whUrl.slice(0, 500),
      body?.secret ? String(body.secret).slice(0, 200) : null,
      JSON.stringify(events),
      now, now
    ).run();
    return json({ ok: true, id, url: whUrl, events }, 201, cors);
  }

  // Delete / deactivate
  if (method === "DELETE" && /^\/v1\/webhooks\/[^/]+$/.test(path)) {
    const id = path.split("/").pop();
    await db.prepare("UPDATE webhooks SET active = 0, updated_at = ? WHERE tenant = ? AND id = ?")
      .bind(new Date().toISOString(), tenant, id).run();
    return json({ ok: true, id, active: false }, 200, cors);
  }

  // Test delivery
  if (method === "POST" && /^\/v1\/webhooks\/[^/]+\/test$/.test(path)) {
    const id = path.split("/")[3];
    const row = await db.prepare("SELECT * FROM webhooks WHERE tenant = ? AND id = ?").bind(tenant, id).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    // temporarily force active for test path by emitting with synthetic event
    const result = await emitChangeEvent(env, {
      tenant,
      event: "webhook.test",
      resource_kind: "webhook",
      resource_id: id,
      payload: { message: "ASTON webhook test" },
      actor,
      deliver: true
    });
    return json({ ok: true, test_event_id: result, webhook_id: id }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
