const SECTORS = new Set([
  "primary", "industry", "infrastructure", "fintech",
  "govtech", "health", "mobility", "media"
]);

const VERSION = "8.2.0";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
  if (allowed) {
    if (origin === allowed) headers["access-control-allow-origin"] = origin;
  } else if (origin) {
    headers["access-control-allow-origin"] = origin;
  } else {
    headers["access-control-allow-origin"] = "*";
  }
  return headers;
}

async function readJson(request) {
  try { return await request.json(); }
  catch { return null; }
}

function bearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function authorized(request, env, scope = "read") {
  const token = bearer(request);
  if (!token) return null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    return {
      tenant: request.headers.get("X-Tenant") || "default",
      scopes: ["read", "write", "ai", "admin"],
      actor: "api-token"
    };
  }
  if (!env.ASTON_JWT_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decode = (s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    if (header.alg !== "HS256" || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(env.ASTON_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const signature = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      "HMAC", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;
    const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
    if (!scopes.includes(scope) && !scopes.includes("admin")) return null;
    return {
      tenant: String(payload.tenant || "default"),
      scopes,
      actor: String(payload.sub || "jwt")
    };
  } catch { return null; }
}

async function audit(env, tenant, actor, action, detail = "") {
  if (!env.ASTON_DB) return;
  try {
    await env.ASTON_DB.prepare(
      "INSERT INTO audit_log (ts, tenant, actor, action, detail) VALUES (?, ?, ?, ?, ?)"
    ).bind(new Date().toISOString(), tenant, actor, action, String(detail).slice(0, 2000)).run();
  } catch (e) {
    console.error("audit_log write failed", e?.message || e);
  }
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, sector TEXT NOT NULL, payload TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_records_tenant_sector ON records (tenant, sector, created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, account TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, balance_after_minor INTEGER NOT NULL, reference TEXT, idem_key TEXT, created_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger (tenant, account, currency, created_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idem ON ledger (tenant, idem_key) WHERE idem_key IS NOT NULL"),
    db.prepare("CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, tenant TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, tenant TEXT NOT NULL, route TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, tenant, route))"),
    db.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT, model TEXT, r2_key TEXT, content_type TEXT, size_bytes INTEGER, created_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_tenant ON media (tenant, created_at)")
  ]);
}

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function detectCapabilities(env) {
  return {
    d1: Boolean(env.ASTON_DB),
    d1_backup: Boolean(env.ASTON_DB_BACKUP),
    kv: Boolean(env.ASTON_KV),
    r2: Boolean(env.ASTON_R2),
    ai: Boolean(env.AI),
    session_do: Boolean(env.ASTON_SESSION),
    rate_limiter_do: Boolean(env.ASTON_RATE_LIMITER),
    ledger_lock_do: Boolean(env.ASTON_LEDGER_LOCK),
    api_token_configured: Boolean(env.ASTON_API_TOKEN),
    jwt_secret_configured: Boolean(env.ASTON_JWT_SECRET),
    image_generation: Boolean(env.AI),
    image_storage: Boolean(env.ASTON_R2),
    public_chat: env.PUBLIC_CHAT === "true"
  };
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  const cors = corsHeaders(request, env);

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (method === "GET" && (path === "/" || path === "/health")) {
    const caps = detectCapabilities(env);
    const result = {
      ok: true,
      service: "ASTON OS Omni-Matrix Apex",
      version: VERSION,
      runtime: "cloudflare-workers",
      capabilities: caps,
      checks: { worker: true, ...caps }
    };
    if (url.searchParams.get("deep") === "1" && env.ASTON_DB) {
      try {
        await ensureSchema(env.ASTON_DB);
        await env.ASTON_DB.prepare("SELECT 1 AS ok").first();
        result.checks.d1_query = true;
      } catch (e) {
        result.checks.d1_query = false;
        result.d1_error = String(e?.message || e).slice(0, 300);
      }
    }
    return json(result, 200, cors);
  }

  if (method === "POST" && path === "/v1/auth/token") {
    const body = await readJson(request);
    if (!body || !env.ASTON_API_TOKEN || body.api_key !== env.ASTON_API_TOKEN) {
      return json({ ok: false, error: "unauthorized" }, 401, cors);
    }
    if (!env.ASTON_JWT_SECRET) {
      return json({ ok: false, error: "JWT issuance is not configured; use the API token as Bearer or set ASTON_JWT_SECRET and deploy the full JWT issuer." }, 501, cors);
    }
    return json({ ok: false, error: "JWT issuance endpoint is not enabled in this bootstrap build. Use the API token as Bearer." }, 501, cors);
  }

  if (method === "POST" && path === "/v1/ai/chat") {
    const auth = await authorized(request, env, "ai");
    const publicChat = env.PUBLIC_CHAT === "true";
    if (!auth && !publicChat) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const body = await readJson(request);
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json({ ok: false, error: "prompt_required" }, 400, cors);
    if (!env.AI) return json({ ok: false, error: "workers_ai_binding_unavailable", hint: "Bind Workers AI in the Cloudflare dashboard or wrangler.toml" }, 503, cors);
    try {
      const model = body.model || env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
      const response = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }]
      });
      if (auth) await audit(env, auth.tenant, auth.actor, "ai.chat", model);
      return json({ ok: true, model, result: response }, 200, cors);
    } catch (e) {
      console.error("Workers AI request failed", e?.message || e);
      return json({ ok: false, error: "ai_request_failed", detail: String(e?.message || e).slice(0, 300) }, 502, cors);
    }
  }

  if (method === "POST" && path === "/v1/ai/image") {
    const auth = await authorized(request, env, "ai");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.AI) {
      return json({ ok: false, error: "workers_ai_binding_unavailable", hint: "Enable Workers AI in your Cloudflare account and bind it as 'AI'" }, 503, cors);
    }
    const body = await readJson(request);
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json({ ok: false, error: "prompt_required" }, 400, cors);
    if (prompt.length > 2000) return json({ ok: false, error: "prompt_too_long", max: 2000 }, 400, cors);
    const model = body.model || env.AI_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
    const steps = Math.max(1, Math.min(20, Number(body.steps) || 4));
    const width = [512, 768, 1024].includes(Number(body.width)) ? Number(body.width) : 1024;
    const height = [512, 768, 1024].includes(Number(body.height)) ? Number(body.height) : 1024;
    try {
      const aiResult = await env.AI.run(model, { prompt, num_steps: steps, width, height });
      let imageBytes;
      let contentType = "image/png";
      if (aiResult instanceof ReadableStream || (aiResult && typeof aiResult.getReader === "function")) {
        const resp = new Response(aiResult);
        imageBytes = await resp.arrayBuffer();
        contentType = resp.headers.get("content-type") || "image/png";
      } else if (typeof aiResult === "string") {
        const binary = atob(aiResult.replace(/^data:image\/\w+;base64,/, ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        imageBytes = bytes.buffer;
      } else if (aiResult && typeof aiResult.image === "string") {
        const binary = atob(aiResult.image.replace(/^data:image\/\w+;base64,/, ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        imageBytes = bytes.buffer;
      } else if (aiResult && aiResult instanceof ArrayBuffer) {
        imageBytes = aiResult;
      } else {
        return json({ ok: false, error: "unexpected_ai_image_format", detail: "Workers AI returned an unsupported image payload shape" }, 502, cors);
      }
      const id = crypto.randomUUID();
      const r2Key = `${auth.tenant}/images/${id}.png`;
      let stored = false;
      let sizeBytes = imageBytes.byteLength;
      if (env.ASTON_R2) {
        try {
          await env.ASTON_R2.put(r2Key, imageBytes, {
            httpMetadata: { contentType },
            customMetadata: { tenant: auth.tenant, model, prompt: prompt.slice(0, 500), generated_at: new Date().toISOString() }
          });
          stored = true;
        } catch (r2Err) {
          console.error("R2 put failed", r2Err?.message || r2Err);
        }
      }
      if (env.ASTON_DB) {
        try {
          await ensureSchema(env.ASTON_DB);
          await env.ASTON_DB.prepare(
            "INSERT INTO media (id, tenant, kind, prompt, model, r2_key, content_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(id, auth.tenant, "image", prompt.slice(0, 2000), model, stored ? r2Key : null, contentType, sizeBytes, new Date().toISOString()).run();
        } catch (dbErr) {
          console.error("media insert failed", dbErr?.message || dbErr);
        }
      }
      await audit(env, auth.tenant, auth.actor, "ai.image", `${model}:${id}`);
      const responsePayload = {
        ok: true, id, model, prompt: prompt.slice(0, 200), content_type: contentType,
        size_bytes: sizeBytes, stored_in_r2: stored, r2_key: stored ? r2Key : null
      };
      if (body.return_base64 === true || body.return_base64 === "true") {
        responsePayload.image_base64 = arrayBufferToBase64(imageBytes);
      }
      return json(responsePayload, 201, cors);
    } catch (e) {
      console.error("Image generation failed", e?.message || e);
      return json({
        ok: false, error: "image_generation_failed",
        detail: String(e?.message || e).slice(0, 400),
        hint: "Check that the chosen model is available in your Workers AI account and that the account has image generation enabled."
      }, 502, cors);
    }
  }

  if (method === "GET" && path === "/v1/media") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
      const result = await env.ASTON_DB.prepare(
        "SELECT id, kind, prompt, model, r2_key, content_type, size_bytes, created_at FROM media WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(auth.tenant, limit).all();
      return json({ ok: true, tenant: auth.tenant, media: result.results || [] }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "media_list_failed" }, 500, cors);
    }
  }

  const recordsMatch = path.match(/^\/v1\/records\/([a-z0-9_-]+)$/i);
  if (recordsMatch && ["GET", "POST"].includes(method)) {
    const sector = recordsMatch[1].toLowerCase();
    if (!SECTORS.has(sector)) return json({ ok: false, error: "invalid_sector" }, 400, cors);
    const auth = await authorized(request, env, method === "GET" ? "read" : "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      if (method === "GET") {
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 25)));
        const q = (url.searchParams.get("q") || "").trim();
        const result = q
          ? await env.ASTON_DB.prepare("SELECT id, sector, payload, text, created_at FROM records WHERE tenant = ? AND sector = ? AND text LIKE ? ORDER BY created_at DESC LIMIT ?").bind(auth.tenant, sector, `%${q.slice(0, 200)}%`, limit).all()
          : await env.ASTON_DB.prepare("SELECT id, sector, payload, text, created_at FROM records WHERE tenant = ? AND sector = ? ORDER BY created_at DESC LIMIT ?").bind(auth.tenant, sector, limit).all();
        return json({ ok: true, tenant: auth.tenant, sector, records: result.results || [] }, 200, cors);
      }
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "json_object_required" }, 400, cors);
      const id = String(body.id || crypto.randomUUID());
      const payload = JSON.stringify(body);
      const searchable = String(body.text || body.title || payload).slice(0, 5000);
      await env.ASTON_DB.prepare("INSERT INTO records (id, tenant, sector, payload, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, auth.tenant, sector, payload, searchable, new Date().toISOString()).run();
      await audit(env, auth.tenant, auth.actor, "record.create", `${sector}:${id}`);
      return json({ ok: true, id, tenant: auth.tenant, sector }, 201, cors);
    } catch (e) {
      console.error("records operation failed", e?.message || e);
      return json({ ok: false, error: "records_operation_failed" }, 500, cors);
    }
  }

  if (method === "POST" && path === "/v1/ingest") {
    return json({ ok: false, error: "sector_path_required", usage: "POST /v1/ingest/:sector" }, 400, cors);
  }
  const ingestMatch = path.match(/^\/v1\/ingest\/([a-z0-9_-]+)$/i);
  if (method === "POST" && ingestMatch) {
    const sector = ingestMatch[1].toLowerCase();
    if (!SECTORS.has(sector)) return json({ ok: false, error: "invalid_sector" }, 400, cors);
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const body = await readJson(request);
    const items = Array.isArray(body) ? body : body?.records;
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
      return json({ ok: false, error: "records_array_required_max_50" }, 400, cors);
    }
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const now = new Date().toISOString();
      const statements = items.map(item => {
        const obj = item && typeof item === "object" && !Array.isArray(item) ? item : { value: item };
        const id = String(obj.id || crypto.randomUUID());
        const payload = JSON.stringify(obj);
        const text = String(obj.text || obj.title || payload).slice(0, 5000);
        return env.ASTON_DB.prepare("INSERT INTO records (id, tenant, sector, payload, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(id, auth.tenant, sector, payload, text, now);
      });
      await env.ASTON_DB.batch(statements);
      await audit(env, auth.tenant, auth.actor, "records.ingest", `${sector}:${items.length}`);
      return json({ ok: true, tenant: auth.tenant, sector, inserted: items.length }, 201, cors);
    } catch (e) {
      console.error("ingest failed", e?.message || e);
      return json({ ok: false, error: "ingest_failed" }, 500, cors);
    }
  }

  if (method === "POST" && path === "/v1/search") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const body = await readJson(request);
    const q = String(body?.q || body?.query || "").trim();
    if (!q) return json({ ok: false, error: "query_required" }, 400, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const result = await env.ASTON_DB.prepare("SELECT id, sector, text, payload, created_at FROM records WHERE tenant = ? AND text LIKE ? ORDER BY created_at DESC LIMIT 50")
        .bind(auth.tenant, `%${q.slice(0, 200)}%`).all();
      return json({ ok: true, mode: "keyword", results: result.results || [] }, 200, cors);
    } catch (e) {
      console.error("search failed", e?.message || e);
      return json({ ok: false, error: "search_failed" }, 500, cors);
    }
  }

  if (path === "/v1/session" && ["GET", "POST", "DELETE"].includes(method)) {
    const auth = await authorized(request, env, method === "GET" ? "read" : "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_SESSION) return json({ ok: false, error: "durable_object_binding_unavailable" }, 503, cors);
    const id = url.searchParams.get("id") || "default";
    const stub = env.ASTON_SESSION.get(env.ASTON_SESSION.idFromName(`${auth.tenant}:${id}`));
    const headers = new Headers(request.headers);
    headers.set("x-aston-tenant", auth.tenant);
    return stub.fetch(new Request(`https://session.internal/${method.toLowerCase()}`, {
      method, headers, body: method === "GET" || method === "DELETE" ? undefined : request.body
    }));
  }

  if (method === "POST" && path === "/v1/ledger") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    const body = await readJson(request);
    const account = String(body?.account || "").trim();
    const currency = String(body?.currency || "USD").toUpperCase();
    const amount = Number(body?.amount);
    const idem = body?.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null;
    if (!account || !Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency)) {
      return json({ ok: false, error: "account_amount_currency_required" }, 400, cors);
    }
    const amountMinor = Math.round(amount * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) return json({ ok: false, error: "invalid_amount" }, 400, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      if (idem) {
        const existing = await env.ASTON_DB.prepare("SELECT * FROM ledger WHERE tenant = ? AND idem_key = ?").bind(auth.tenant, idem).first();
        if (existing) return json({ ok: true, duplicate: true, entry: existing }, 200, cors);
      }
      const current = await env.ASTON_DB.prepare("SELECT balance_after_minor FROM ledger WHERE tenant = ? AND account = ? AND currency = ? ORDER BY created_at DESC LIMIT 1")
        .bind(auth.tenant, account, currency).first();
      const balance = Number(current?.balance_after_minor || 0) + amountMinor;
      if (balance < 0) return json({ ok: false, error: "insufficient_balance" }, 422, cors);
      const entry = {
        id: crypto.randomUUID(), tenant: auth.tenant, account, amount_minor: amountMinor,
        currency, balance_after_minor: balance, reference: body.reference ? String(body.reference).slice(0, 500) : null,
        idem_key: idem, created_at: new Date().toISOString()
      };
      await env.ASTON_DB.prepare("INSERT INTO ledger (id, tenant, account, amount_minor, currency, balance_after_minor, reference, idem_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(entry.id, entry.tenant, entry.account, entry.amount_minor, entry.currency, entry.balance_after_minor, entry.reference, entry.idem_key, entry.created_at).run();
      await audit(env, auth.tenant, auth.actor, "ledger.create", `${account}:${amountMinor}:${currency}`);
      return json({ ok: true, entry }, 201, cors);
    } catch (e) {
      console.error("ledger operation failed", e?.message || e);
      return json({ ok: false, error: "ledger_operation_failed" }, 500, cors);
    }
  }

  if (method === "GET" && path === "/v1/audit") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const result = await env.ASTON_DB.prepare("SELECT ts, tenant, actor, action, detail FROM audit_log WHERE tenant = ? ORDER BY id DESC LIMIT 100").bind(auth.tenant).all();
      return json({ ok: true, events: result.results || [] }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "audit_query_failed" }, 500, cors);
    }
  }

  if (method === "GET" && path === "/v1/stats") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const records = await env.ASTON_DB.prepare("SELECT COUNT(*) AS count FROM records WHERE tenant = ?").bind(auth.tenant).first();
      const ledger = await env.ASTON_DB.prepare("SELECT COUNT(*) AS count FROM ledger WHERE tenant = ?").bind(auth.tenant).first();
      const auditRows = await env.ASTON_DB.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE tenant = ?").bind(auth.tenant).first();
      const media = await env.ASTON_DB.prepare("SELECT COUNT(*) AS count FROM media WHERE tenant = ?").bind(auth.tenant).first().catch(() => ({ count: 0 }));
      return json({
        ok: true, tenant: auth.tenant,
        stats: { records: records?.count || 0, ledger_entries: ledger?.count || 0, audit_events: auditRows?.count || 0, media: media?.count || 0 }
      }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "stats_query_failed" }, 500, cors);
    }
  }

  if (method === "POST" && path === "/v1/diagnostics/storage") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const checks = {};
    const runCheck = async (name, fn) => {
      try { checks[name] = { ok: true, ...(await fn()) }; }
      catch (e) { checks[name] = { ok: false, error: String(e?.message || e).slice(0, 240) }; }
    };
    await runCheck("d1", async () => {
      if (!env.ASTON_DB) throw new Error("ASTON_DB binding unavailable");
      await ensureSchema(env.ASTON_DB);
      const row = await env.ASTON_DB.prepare("SELECT 1 AS ok").first();
      if (Number(row?.ok) !== 1) throw new Error("D1 query returned unexpected result");
      return { query: "SELECT 1", result: 1 };
    });
    await runCheck("kv", async () => {
      if (!env.ASTON_KV) throw new Error("ASTON_KV binding unavailable");
      const key = `aston-validation:${crypto.randomUUID()}`;
      const value = `ok:${crypto.randomUUID()}`;
      await env.ASTON_KV.put(key, value, { expirationTtl: 120 });
      const readBack = await env.ASTON_KV.get(key);
      await env.ASTON_KV.delete(key);
      if (readBack !== value) throw new Error("KV read-back mismatch");
      return { write: true, read: true, cleanup: true };
    });
    await runCheck("r2", async () => {
      if (!env.ASTON_R2) throw new Error("ASTON_R2 binding unavailable");
      const key = `aston-validation/${crypto.randomUUID()}.txt`;
      const value = `ASTON R2 validation ${new Date().toISOString()}`;
      await env.ASTON_R2.put(key, value, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: { purpose: "temporary-connectivity-check" }
      });
      const object = await env.ASTON_R2.get(key);
      if (!object) throw new Error("R2 object could not be read after write");
      const readBack = await object.text();
      await env.ASTON_R2.delete(key);
      if (readBack !== value) throw new Error("R2 read-back mismatch");
      return { write: true, read: true, cleanup: true };
    });
    await runCheck("ai", async () => {
      if (!env.AI) throw new Error("AI binding unavailable");
      return { bound: true };
    });
    const ok = Object.values(checks).every(c => c.ok === true);
    await audit(env, auth.tenant, auth.actor, "storage.diagnostics", JSON.stringify(checks));
    return json({ ok, service: "ASTON OS", version: VERSION, diagnostics: checks, timestamp: new Date().toISOString() }, ok ? 200 : 503, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error("Unhandled Worker error", error?.stack || error);
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    if (env.ASTON_KV) {
      try {
        await env.ASTON_KV.put("aston:last-cron", new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 14 });
      } catch (e) {
        console.error("cron kv write failed", e?.message || e);
      }
    }
  }
};

export class AstonSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    const key = "session";
    if (request.method === "GET") {
      const value = await this.ctx.storage.get(key);
      return json({ ok: true, session: value ?? null });
    }
    if (request.method === "DELETE") {
      await this.ctx.storage.deleteAll();
      return json({ ok: true, deleted: true });
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "json_object_required" }, 400);
      const current = (await this.ctx.storage.get(key)) || {};
      const next = { ...current, ...body, updated_at: new Date().toISOString() };
      await this.ctx.storage.put(key, next);
      return json({ ok: true, session: next });
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
}

export class AstonRateLimiter {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const key = `count:${minute}`;
    const count = (await this.ctx.storage.get(key)) || 0;
    const limit = Number(this.env.RATE_LIMIT_PER_MINUTE || 120);
    if (count >= limit) return json({ ok: false, error: "rate_limited" }, 429, { "retry-after": "60" });
    await this.ctx.storage.put(key, count + 1);
    return json({ ok: true, remaining: limit - count - 1 });
  }
}

export class AstonLedgerLock {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const body = await readJson(request);
    if (!body || typeof body !== "object") return json({ ok: false, error: "json_object_required" }, 400);
    const key = String(body.key || "default");
    const value = await this.ctx.storage.get(key);
    return json({ ok: true, key, value: value ?? null });
  }
}
