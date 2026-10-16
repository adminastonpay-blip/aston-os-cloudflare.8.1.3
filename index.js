const SECTORS = new Set([
  "primary", "industry", "infrastructure", "fintech",
  "govtech", "health", "mobility", "media"
]);

const VERSION = "8.5.1";

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
  try { return await request.json(); } catch { return null; }
}

function bearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function authorized(request, env, scope = "read") {
  const token = bearer(request);
  if (!token) return null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    return { tenant: request.headers.get("X-Tenant") || "default", scopes: ["read", "write", "ai", "admin"], actor: "api-token" };
  }
  if (!env.ASTON_JWT_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decode = (s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    if (header.alg !== "HS256" || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ASTON_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
    if (!scopes.includes(scope) && !scopes.includes("admin")) return null;
    return { tenant: String(payload.tenant || "default"), scopes, actor: String(payload.sub || "jwt") };
  } catch { return null; }
}

async function audit(env, tenant, actor, action, detail = "") {
  if (!env.ASTON_DB) return;
  try {
    await env.ASTON_DB.prepare("INSERT INTO audit_log (ts, tenant, actor, action, detail) VALUES (?, ?, ?, ?, ?)").bind(new Date().toISOString(), tenant, actor, action, String(detail).slice(0, 2000)).run();
  } catch (e) { console.error("audit_log write failed", e?.message || e); }
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
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_tenant ON media (tenant, created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS plugins_state (plugin_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, config TEXT, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, payload TEXT, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs (tenant, created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, url TEXT NOT NULL, secret TEXT, events TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)")
  ]);
}

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function detectCapabilities(env) {
  return {
    d1: Boolean(env.ASTON_DB), d1_backup: Boolean(env.ASTON_DB_BACKUP), kv: Boolean(env.ASTON_KV), r2: Boolean(env.ASTON_R2),
    ai: Boolean(env.AI), vectorize: Boolean(env.VECTORIZE), queue: Boolean(env.ASTON_QUEUE),
    session_do: Boolean(env.ASTON_SESSION), rate_limiter_do: Boolean(env.ASTON_RATE_LIMITER),
    ledger_lock_do: Boolean(env.ASTON_LEDGER_LOCK), agent_do: Boolean(env.ASTON_AGENT),
    api_token_configured: Boolean(env.ASTON_API_TOKEN), jwt_secret_configured: Boolean(env.ASTON_JWT_SECRET),
    image_generation: Boolean(env.AI), image_storage: Boolean(env.ASTON_R2),
    semantic_search: Boolean(env.AI) && Boolean(env.VECTORIZE),
    background_jobs: Boolean(env.ASTON_QUEUE),
    agents: Boolean(env.ASTON_AGENT) && Boolean(env.AI),
    public_chat: env.PUBLIC_CHAT === "true",
    public_agent: env.PUBLIC_AGENT === "true",
    public_agent_rate_limit: Boolean(env.ASTON_RATE_LIMITER)
  };
}

const PLUGIN_DEFINITIONS = [
  { id: "core", name: "ASTON Core", version: "8.5.1", description: "Health, records, ledger, audit, stats, jobs list", requires: [], routes: ["GET /", "GET /health", "GET /v1/plugins", "GET|POST /v1/records/:sector", "POST /v1/ingest/:sector", "POST /v1/search", "POST /v1/ledger", "GET /v1/audit", "GET /v1/stats", "POST /v1/diagnostics/storage", "GET /v1/jobs"] },
  { id: "session", name: "Session (Durable Object)", version: "8.5.1", description: "Tenant sessions", requires: ["ASTON_SESSION"], routes: ["GET|POST|DELETE /v1/session"] },
  { id: "ai-chat", name: "Workers AI Chat", version: "8.5.1", description: "Text generation", requires: ["AI"], routes: ["POST /v1/ai/chat"] },
  { id: "ai-image", name: "Workers AI Image Generation", version: "8.5.1", description: "Image generation + R2", requires: ["AI"], routes: ["POST /v1/ai/image"] },
  { id: "media", name: "Media Library", version: "8.5.1", description: "List media", requires: ["ASTON_DB"], routes: ["GET /v1/media"] },
  { id: "semantic-search", name: "Semantic Search (Vectorize)", version: "8.5.1", description: "Embeddings + vector retrieval", requires: ["AI", "VECTORIZE"], routes: ["POST /v1/search/semantic", "POST /v1/embed/reindex"] },
  { id: "jobs", name: "Background Jobs (Queues)", version: "8.5.1", description: "Async jobs", requires: ["ASTON_QUEUE"], routes: ["POST /v1/jobs"] },
  { id: "agent", name: "Agent Runtime", version: "8.5.1", description: "Per-tenant AI agent with tools and traces", requires: ["ASTON_AGENT", "AI"], routes: ["POST /v1/agent/run", "GET /v1/agent/memory", "GET /v1/agent/traces"] },
  { id: "public-agent", name: "Public Agent Gateway", version: "8.5.1", description: "Rate-limited advisory assistant; no private data tools or external actions", requires: ["AI", "ASTON_RATE_LIMITER"], routes: ["GET /v1/agent/capabilities", "POST /v1/agent/public"] }
];

function isPluginActive(plugin, env) {
  if (plugin.id === "public-agent" && env.PUBLIC_AGENT !== "true") return false;
  if (!plugin.requires || plugin.requires.length === 0) return true;
  return plugin.requires.every(binding => Boolean(env[binding]));
}

function listPlugins(env) {
  return PLUGIN_DEFINITIONS.map(p => ({
    id: p.id, name: p.name, version: p.version, description: p.description,
    requires: p.requires, active: isPluginActive(p, env), routes: p.routes
  }));
}

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

async function embedTexts(env, texts) {
  if (!env.AI) throw new Error("AI binding required for embeddings");
  const input = Array.isArray(texts) ? texts : [texts];
  const result = await env.AI.run(EMBED_MODEL, { text: input });
  if (result?.data) return result.data;
  if (Array.isArray(result) && Array.isArray(result[0])) return result;
  throw new Error("Unexpected embedding response shape");
}

async function upsertVector(env, id, values, metadata) {
  if (!env.VECTORIZE) return false;
  await env.VECTORIZE.upsert([{ id, values, metadata }]);
  return true;
}

async function enqueueJob(env, tenant, type, payload) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (env.ASTON_DB) {
    try {
      await ensureSchema(env.ASTON_DB);
      await env.ASTON_DB.prepare("INSERT INTO jobs (id, tenant, type, status, payload, result, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)").bind(id, tenant, type, "queued", JSON.stringify(payload || {}), now, now).run();
    } catch (e) { console.error("job insert failed", e?.message || e); }
  }
  if (env.ASTON_QUEUE) await env.ASTON_QUEUE.send({ id, tenant, type, payload: payload || {} });
  return id;
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  const cors = corsHeaders(request, env);
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (method === "GET" && (path === "/" || path === "/health")) {
    const caps = detectCapabilities(env);
    const plugins = listPlugins(env);
    const result = {
      ok: true, service: "ASTON OS Omni-Matrix Apex", version: VERSION, runtime: "cloudflare-workers",
      capabilities: caps,
      plugins: { total: plugins.length, active: plugins.filter(p => p.active).length, list: plugins.map(p => ({ id: p.id, name: p.name, active: p.active })) },
      checks: { worker: true, ...caps }
    };
    if (url.searchParams.get("deep") === "1" && env.ASTON_DB) {
      try { await ensureSchema(env.ASTON_DB); await env.ASTON_DB.prepare("SELECT 1 AS ok").first(); result.checks.d1_query = true; }
      catch (e) { result.checks.d1_query = false; result.d1_error = String(e?.message || e).slice(0, 300); }
    }
    return json(result, 200, cors);
  }

  if (method === "GET" && path === "/v1/plugins") {
    const auth = await authorized(request, env, "read");
    return json({ ok: true, tenant: auth?.tenant || "anonymous", version: VERSION, plugins: listPlugins(env) }, 200, cors);
  }

  if (method === "POST" && path === "/v1/auth/token") {
    const body = await readJson(request);
    if (!body || !env.ASTON_API_TOKEN || body.api_key !== env.ASTON_API_TOKEN) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_JWT_SECRET) return json({ ok: false, error: "JWT not configured; use API token Bearer" }, 501, cors);
    return json({ ok: false, error: "JWT issuance not enabled; use API token" }, 501, cors);
  }

  if (method === "POST" && path === "/v1/ai/chat") {
    const auth = await authorized(request, env, "ai");
    const publicChat = env.PUBLIC_CHAT === "true";
    if (!auth && !publicChat) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const body = await readJson(request);
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json({ ok: false, error: "prompt_required" }, 400, cors);
    if (!env.AI) return json({ ok: false, error: "plugin_inactive", plugin: "ai-chat", missing_bindings: ["AI"] }, 503, cors);
    try {
      const model = body.model || env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
      const response = await env.AI.run(model, { messages: [{ role: "user", content: prompt }] });
      if (auth) await audit(env, auth.tenant, auth.actor, "ai.chat", model);
      return json({ ok: true, model, result: response }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "ai_request_failed", detail: String(e?.message || e).slice(0, 300) }, 502, cors);
    }
  }

  if (method === "POST" && path === "/v1/ai/image") {
    const auth = await authorized(request, env, "ai");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.AI) return json({ ok: false, error: "plugin_inactive", plugin: "ai-image", missing_bindings: ["AI"] }, 503, cors);
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
      let imageBytes; let contentType = "image/png";
      if (aiResult instanceof ReadableStream || (aiResult && typeof aiResult.getReader === "function")) {
        const resp = new Response(aiResult); imageBytes = await resp.arrayBuffer(); contentType = resp.headers.get("content-type") || "image/png";
      } else if (typeof aiResult === "string") {
        const binary = atob(aiResult.replace(/^data:image\/\w+;base64,/, ""));
        const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); imageBytes = bytes.buffer;
      } else if (aiResult && typeof aiResult.image === "string") {
        const binary = atob(aiResult.image.replace(/^data:image\/\w+;base64,/, ""));
        const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); imageBytes = bytes.buffer;
      } else if (aiResult instanceof ArrayBuffer) { imageBytes = aiResult; }
      else return json({ ok: false, error: "unexpected_ai_image_format" }, 502, cors);
      const id = crypto.randomUUID(); const r2Key = `${auth.tenant}/images/${id}.png`; let stored = false; const sizeBytes = imageBytes.byteLength;
      if (env.ASTON_R2) {
        try { await env.ASTON_R2.put(r2Key, imageBytes, { httpMetadata: { contentType }, customMetadata: { tenant: auth.tenant, model, prompt: prompt.slice(0, 500) } }); stored = true; } catch (e) { console.error("R2 put failed", e?.message || e); }
      }
      if (env.ASTON_DB) {
        try { await ensureSchema(env.ASTON_DB); await env.ASTON_DB.prepare("INSERT INTO media (id, tenant, kind, prompt, model, r2_key, content_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, auth.tenant, "image", prompt.slice(0, 2000), model, stored ? r2Key : null, contentType, sizeBytes, new Date().toISOString()).run(); } catch (e) { console.error("media insert failed", e?.message || e); }
      }
      await audit(env, auth.tenant, auth.actor, "ai.image", `${model}:${id}`);
      const responsePayload = { ok: true, id, model, prompt: prompt.slice(0, 200), content_type: contentType, size_bytes: sizeBytes, stored_in_r2: stored, r2_key: stored ? r2Key : null, plugin: "ai-image" };
      if (body.return_base64 === true || body.return_base64 === "true") responsePayload.image_base64 = arrayBufferToBase64(imageBytes);
      return json(responsePayload, 201, cors);
    } catch (e) {
      return json({ ok: false, error: "image_generation_failed", detail: String(e?.message || e).slice(0, 400), hint: "Check Workers AI image model availability" }, 502, cors);
    }
  }

  if (method === "GET" && path === "/v1/media") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "plugin_inactive", plugin: "media", missing_bindings: ["ASTON_DB"] }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
      const result = await env.ASTON_DB.prepare("SELECT id, kind, prompt, model, r2_key, content_type, size_bytes, created_at FROM media WHERE tenant = ? ORDER BY created_at DESC LIMIT ?").bind(auth.tenant, limit).all();
      return json({ ok: true, tenant: auth.tenant, media: result.results || [] }, 200, cors);
    } catch (e) { return json({ ok: false, error: "media_list_failed" }, 500, cors); }
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
      if (env.AI && env.VECTORIZE && searchable) {
        try {
          const [vector] = await embedTexts(env, [searchable.slice(0, 1500)]);
          await upsertVector(env, `${auth.tenant}:${id}`, vector, { tenant: auth.tenant, sector, record_id: id, text: searchable.slice(0, 200) });
        } catch (e) { console.error("auto-embed failed", e?.message || e); }
      }
      return json({ ok: true, id, tenant: auth.tenant, sector }, 201, cors);
    } catch (e) { return json({ ok: false, error: "records_operation_failed" }, 500, cors); }
  }

  if (method === "POST" && path === "/v1/ingest") return json({ ok: false, error: "sector_path_required", usage: "POST /v1/ingest/:sector" }, 400, cors);
  const ingestMatch = path.match(/^\/v1\/ingest\/([a-z0-9_-]+)$/i);
  if (method === "POST" && ingestMatch) {
    const sector = ingestMatch[1].toLowerCase();
    if (!SECTORS.has(sector)) return json({ ok: false, error: "invalid_sector" }, 400, cors);
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const body = await readJson(request);
    const items = Array.isArray(body) ? body : body?.records;
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) return json({ ok: false, error: "records_array_required_max_50" }, 400, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const now = new Date().toISOString();
      const statements = items.map(item => {
        const obj = item && typeof item === "object" && !Array.isArray(item) ? item : { value: item };
        const id = String(obj.id || crypto.randomUUID());
        const payload = JSON.stringify(obj);
        const text = String(obj.text || obj.title || payload).slice(0, 5000);
        return env.ASTON_DB.prepare("INSERT INTO records (id, tenant, sector, payload, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, auth.tenant, sector, payload, text, now);
      });
      await env.ASTON_DB.batch(statements);
      await audit(env, auth.tenant, auth.actor, "records.ingest", `${sector}:${items.length}`);
      return json({ ok: true, tenant: auth.tenant, sector, inserted: items.length }, 201, cors);
    } catch (e) { return json({ ok: false, error: "ingest_failed" }, 500, cors); }
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
      const result = await env.ASTON_DB.prepare("SELECT id, sector, text, payload, created_at FROM records WHERE tenant = ? AND text LIKE ? ORDER BY created_at DESC LIMIT 50").bind(auth.tenant, `%${q.slice(0, 200)}%`).all();
      return json({ ok: true, mode: "keyword", results: result.results || [] }, 200, cors);
    } catch (e) { return json({ ok: false, error: "search_failed" }, 500, cors); }
  }

  if (method === "POST" && path === "/v1/search/semantic") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.AI || !env.VECTORIZE) return json({ ok: false, error: "plugin_inactive", plugin: "semantic-search", missing_bindings: ["AI", "VECTORIZE"].filter(b => !env[b]) }, 503, cors);
    const body = await readJson(request);
    const q = String(body?.q || body?.query || "").trim();
    if (!q) return json({ ok: false, error: "query_required" }, 400, cors);
    try {
      const [vector] = await embedTexts(env, [q.slice(0, 2000)]);
      const topK = Math.max(1, Math.min(20, Number(body?.top_k || 8)));
      const matches = await env.VECTORIZE.query(vector, { topK, returnMetadata: true, filter: { tenant: auth.tenant } });
      return json({ ok: true, mode: "semantic", query: q.slice(0, 200), matches: matches?.matches || matches || [], plugin: "semantic-search" }, 200, cors);
    } catch (e) { return json({ ok: false, error: "semantic_search_failed", detail: String(e?.message || e).slice(0, 300) }, 502, cors); }
  }

  if (method === "POST" && path === "/v1/embed/reindex") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.AI || !env.VECTORIZE || !env.ASTON_DB) return json({ ok: false, error: "plugin_inactive", plugin: "semantic-search", missing_bindings: ["AI", "VECTORIZE", "ASTON_DB"].filter(b => !env[b]) }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const rows = await env.ASTON_DB.prepare("SELECT id, sector, text FROM records WHERE tenant = ? ORDER BY created_at DESC LIMIT 100").bind(auth.tenant).all();
      const records = rows.results || [];
      if (!records.length) return json({ ok: true, indexed: 0 }, 200, cors);
      const texts = records.map(r => String(r.text || "").slice(0, 1500) || r.id);
      const vectors = await embedTexts(env, texts);
      const points = records.map((r, i) => ({ id: `${auth.tenant}:${r.id}`, values: vectors[i], metadata: { tenant: auth.tenant, sector: r.sector, record_id: r.id, text: String(r.text || "").slice(0, 200) } }));
      await env.VECTORIZE.upsert(points);
      await audit(env, auth.tenant, auth.actor, "embed.reindex", String(points.length));
      return json({ ok: true, indexed: points.length, plugin: "semantic-search" }, 200, cors);
    } catch (e) { return json({ ok: false, error: "reindex_failed", detail: String(e?.message || e).slice(0, 300) }, 502, cors); }
  }

  if (method === "POST" && path === "/v1/jobs") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_QUEUE) return json({ ok: false, error: "plugin_inactive", plugin: "jobs", missing_bindings: ["ASTON_QUEUE"] }, 503, cors);
    const body = await readJson(request);
    const type = String(body?.type || "").trim();
    const allowed = ["embed_record", "embed_tenant", "image_generate", "webhook_deliver"];
    if (!allowed.includes(type)) return json({ ok: false, error: "invalid_job_type", allowed }, 400, cors);
    const jobId = await enqueueJob(env, auth.tenant, type, body?.payload || body || {});
    await audit(env, auth.tenant, auth.actor, "job.enqueue", `${type}:${jobId}`);
    return json({ ok: true, job_id: jobId, type, status: "queued", plugin: "jobs" }, 202, cors);
  }

  if (method === "GET" && path === "/v1/jobs") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
      const result = await env.ASTON_DB.prepare("SELECT id, type, status, error, created_at, updated_at FROM jobs WHERE tenant = ? ORDER BY created_at DESC LIMIT ?").bind(auth.tenant, limit).all();
      return json({ ok: true, tenant: auth.tenant, jobs: result.results || [] }, 200, cors);
    } catch (e) { return json({ ok: false, error: "jobs_list_failed" }, 500, cors); }
  }

  if (method === "GET" && path === "/v1/agent/capabilities") {
    const enabled = env.PUBLIC_AGENT === "true" && Boolean(env.AI) && Boolean(env.ASTON_RATE_LIMITER);
    return json({
      ok: true,
      service: "ASTON OS Public Agent Gateway",
      version: VERSION,
      enabled,
      mode: "advisory",
      capabilities: {
        text_reasoning: Boolean(env.AI),
        rate_limited: Boolean(env.ASTON_RATE_LIMITER),
        private_data_access: false,
        external_actions: false,
        persistent_public_memory: false
      },
      limits: { prompt_chars: 3000, history_messages: 6, requests_per_minute: Math.max(1, Math.min(30, Number(env.PUBLIC_AGENT_RATE_LIMIT_PER_MINUTE) || 8)) }
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/agent/public") {
    if (env.PUBLIC_AGENT !== "true") return json({ ok: false, error: "public_agent_disabled" }, 503, cors);
    if (!env.AI) return json({ ok: false, error: "ai_unavailable" }, 503, cors);
    if (!env.ASTON_RATE_LIMITER) return json({ ok: false, error: "rate_limiter_unavailable" }, 503, cors);

    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "json_object_required" }, 400, cors);
    const prompt = String(body.prompt || body.message || "").trim();
    if (!prompt) return json({ ok: false, error: "prompt_required" }, 400, cors);
    if (prompt.length > 3000) return json({ ok: false, error: "prompt_too_long", max: 3000 }, 413, cors);

    const ip = String(request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 100);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    const ipKey = Array.from(new Uint8Array(digest)).slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
    const limiter = env.ASTON_RATE_LIMITER.get(env.ASTON_RATE_LIMITER.idFromName("public-agent:" + ipKey));
    const limit = Math.max(1, Math.min(30, Number(env.PUBLIC_AGENT_RATE_LIMIT_PER_MINUTE) || 8));
    const limitResponse = await limiter.fetch(new Request("https://rate-limit.internal/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aston-limit": String(limit) },
      body: "{}"
    }));
    if (!limitResponse.ok) {
      const retryAfter = limitResponse.headers.get("retry-after") || "60";
      return json({ ok: false, error: "rate_limited", retry_after: Number(retryAfter) || 60 }, 429, { ...cors, "retry-after": retryAfter });
    }

    const history = Array.isArray(body.history) ? body.history.slice(-6).flatMap(item => {
      if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") return [];
      const content = item.content.trim().slice(0, 1000);
      return content ? [{ role: item.role, content }] : [];
    }) : [];
    const context = body.context && typeof body.context === "object" ? body.context : {};
    const pageTitle = typeof context.page_title === "string" ? context.page_title.slice(0, 160) : "";
    const template = typeof context.template === "string" ? context.template.slice(0, 80) : "";
    const systemPrompt = [
      "You are ASTON OS, a practical enterprise problem-solving assistant.",
      "Reply in the user's language. Be clear, structured, and action-oriented.",
      "Diagnose the goal, distinguish facts from hypotheses, list the next best steps, required evidence, risks, and a verification criterion when relevant.",
      "You are operating in PUBLIC ADVISORY MODE: you cannot access private tenant records, call external tools, change systems, deploy code, charge money, or execute actions.",
      "Never claim you tested, changed, connected, fixed, or verified anything unless the user supplied evidence in this conversation.",
      "For actions that affect production, finances, accounts, legal filings, or external systems, explain the safe approval and authorization requirements.",
      "If the user asks for a task, give a concrete plan and state which parts require a connected tool or authorized operator.",
      "Page context (untrusted metadata): " + JSON.stringify({ page_title: pageTitle, template })
    ].join("\n");

    const model = env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
    const startedAt = Date.now();
    const runId = crypto.randomUUID();
    try {
      const response = await env.AI.run(model, {
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: prompt }
        ]
      });
      const answer = typeof response === "string" ? response : String(response?.response || response?.answer || "");
      if (!answer.trim()) return json({ ok: false, error: "empty_model_response", run_id: runId }, 502, cors);
      return json({
        ok: true,
        mode: "advisory",
        run_id: runId,
        model,
        answer: answer.slice(0, 12000),
        result: answer.slice(0, 12000),
        tools_used: [],
        actions_executed: false,
        verification: { status: "not_executed", note: "Esta ruta asesora y planifica; no ejecuta cambios ni consulta datos privados." },
        total_ms: Date.now() - startedAt
      }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "public_agent_failed", detail: String(e?.message || e).slice(0, 240) }, 502, cors);
    }
  }

  if (method === "POST" && path === "/v1/agent/run") {
    const auth = await authorized(request, env, "ai");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_AGENT || !env.AI) return json({ ok: false, error: "plugin_inactive", plugin: "agent", missing_bindings: ["ASTON_AGENT", "AI"].filter(b => !env[b]) }, 503, cors);
    const body = await readJson(request);
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json({ ok: false, error: "prompt_required" }, 400, cors);
    const agentId = body?.agent_id ? String(body.agent_id).slice(0, 64) : "default";
    const stub = env.ASTON_AGENT.get(env.ASTON_AGENT.idFromName(`${auth.tenant}:${agentId}`));
    return stub.fetch(new Request("https://agent.internal/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aston-tenant": auth.tenant, "x-aston-actor": auth.actor || "api" },
      body: JSON.stringify({ prompt, tenant: auth.tenant, actor: auth.actor || "api", max_steps: Math.min(8, Number(body?.max_steps) || 5), tools: body?.tools || null })
    }));
  }

  if (method === "GET" && path === "/v1/agent/memory") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_AGENT) return json({ ok: false, error: "plugin_inactive", plugin: "agent", missing_bindings: ["ASTON_AGENT"] }, 503, cors);
    const agentId = url.searchParams.get("agent_id") || "default";
    const stub = env.ASTON_AGENT.get(env.ASTON_AGENT.idFromName(`${auth.tenant}:${agentId}`));
    return stub.fetch(new Request("https://agent.internal/memory", { method: "GET", headers: { "x-aston-tenant": auth.tenant } }));
  }

  if (method === "GET" && path === "/v1/agent/traces") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_AGENT) return json({ ok: false, error: "plugin_inactive", plugin: "agent", missing_bindings: ["ASTON_AGENT"] }, 503, cors);
    const agentId = url.searchParams.get("agent_id") || "default";
    const stub = env.ASTON_AGENT.get(env.ASTON_AGENT.idFromName(`${auth.tenant}:${agentId}`));
    return stub.fetch(new Request("https://agent.internal/traces", { method: "GET", headers: { "x-aston-tenant": auth.tenant } }));
  }

  if (path === "/v1/session" && ["GET", "POST", "DELETE"].includes(method)) {
    const auth = await authorized(request, env, method === "GET" ? "read" : "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_SESSION) return json({ ok: false, error: "plugin_inactive", plugin: "session", missing_bindings: ["ASTON_SESSION"] }, 503, cors);
    const id = url.searchParams.get("id") || "default";
    const stub = env.ASTON_SESSION.get(env.ASTON_SESSION.idFromName(`${auth.tenant}:${id}`));
    const headers = new Headers(request.headers); headers.set("x-aston-tenant", auth.tenant);
    return stub.fetch(new Request(`https://session.internal/${method.toLowerCase()}`, { method, headers, body: method === "GET" || method === "DELETE" ? undefined : request.body }));
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
    if (!account || !Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency)) return json({ ok: false, error: "account_amount_currency_required" }, 400, cors);
    const amountMinor = Math.round(amount * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) return json({ ok: false, error: "invalid_amount" }, 400, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      if (idem) {
        const existing = await env.ASTON_DB.prepare("SELECT * FROM ledger WHERE tenant = ? AND idem_key = ?").bind(auth.tenant, idem).first();
        if (existing) return json({ ok: true, duplicate: true, entry: existing }, 200, cors);
      }
      const current = await env.ASTON_DB.prepare("SELECT balance_after_minor FROM ledger WHERE tenant = ? AND account = ? AND currency = ? ORDER BY created_at DESC LIMIT 1").bind(auth.tenant, account, currency).first();
      const balance = Number(current?.balance_after_minor || 0) + amountMinor;
      if (balance < 0) return json({ ok: false, error: "insufficient_balance" }, 422, cors);
      const entry = { id: crypto.randomUUID(), tenant: auth.tenant, account, amount_minor: amountMinor, currency, balance_after_minor: balance, reference: body.reference ? String(body.reference).slice(0, 500) : null, idem_key: idem, created_at: new Date().toISOString() };
      await env.ASTON_DB.prepare("INSERT INTO ledger (id, tenant, account, amount_minor, currency, balance_after_minor, reference, idem_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(entry.id, entry.tenant, entry.account, entry.amount_minor, entry.currency, entry.balance_after_minor, entry.reference, entry.idem_key, entry.created_at).run();
      await audit(env, auth.tenant, auth.actor, "ledger.create", `${account}:${amountMinor}:${currency}`);
      return json({ ok: true, entry }, 201, cors);
    } catch (e) { return json({ ok: false, error: "ledger_operation_failed" }, 500, cors); }
  }

  if (method === "GET" && path === "/v1/audit") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_binding_unavailable" }, 503, cors);
    try {
      await ensureSchema(env.ASTON_DB);
      const result = await env.ASTON_DB.prepare("SELECT ts, tenant, actor, action, detail FROM audit_log WHERE tenant = ? ORDER BY id DESC LIMIT 100").bind(auth.tenant).all();
      return json({ ok: true, events: result.results || [] }, 200, cors);
    } catch (e) { return json({ ok: false, error: "audit_query_failed" }, 500, cors); }
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
      return json({ ok: true, tenant: auth.tenant, stats: { records: records?.count || 0, ledger_entries: ledger?.count || 0, audit_events: auditRows?.count || 0, media: media?.count || 0 } }, 200, cors);
    } catch (e) { return json({ ok: false, error: "stats_query_failed" }, 500, cors); }
  }

  if (method === "POST" && path === "/v1/diagnostics/storage") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const checks = {};
    const runCheck = async (name, fn) => { try { checks[name] = { ok: true, ...(await fn()) }; } catch (e) { checks[name] = { ok: false, error: String(e?.message || e).slice(0, 240) }; } };
    await runCheck("d1", async () => { if (!env.ASTON_DB) throw new Error("ASTON_DB unavailable"); await ensureSchema(env.ASTON_DB); const row = await env.ASTON_DB.prepare("SELECT 1 AS ok").first(); if (Number(row?.ok) !== 1) throw new Error("bad d1"); return { query: 1 }; });
    await runCheck("kv", async () => { if (!env.ASTON_KV) throw new Error("KV unavailable"); const key = `v:${crypto.randomUUID()}`; await env.ASTON_KV.put(key, "1", { expirationTtl: 60 }); await env.ASTON_KV.delete(key); return { ok: true }; });
    await runCheck("r2", async () => { if (!env.ASTON_R2) throw new Error("R2 unavailable"); const key = `v/${crypto.randomUUID()}.txt`; await env.ASTON_R2.put(key, "ok"); await env.ASTON_R2.delete(key); return { ok: true }; });
    await runCheck("ai", async () => { if (!env.AI) throw new Error("AI unavailable"); return { bound: true }; });
    await runCheck("vectorize", async () => { if (!env.VECTORIZE) throw new Error("VECTORIZE unavailable"); return { bound: true }; });
    const ok = Object.values(checks).every(c => c.ok === true);
    await audit(env, auth.tenant, auth.actor, "storage.diagnostics", JSON.stringify(checks));
    return json({ ok, service: "ASTON OS", version: VERSION, diagnostics: checks, timestamp: new Date().toISOString() }, ok ? 200 : 503, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch (error) { console.error("Unhandled Worker error", error?.stack || error); return json({ ok: false, error: "internal_error" }, 500); }
  },
  async scheduled(controller, env, ctx) {
    if (env.ASTON_KV) { try { await env.ASTON_KV.put("aston:last-cron", new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 14 }); } catch (e) { console.error("cron kv write failed", e?.message || e); } }
  },
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const job = msg.body || {};
      const id = job.id || crypto.randomUUID();
      const tenant = job.tenant || "default";
      const type = job.type || "unknown";
      try {
        if (env.ASTON_DB) { try { await ensureSchema(env.ASTON_DB); await env.ASTON_DB.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").bind("running", new Date().toISOString(), id).run(); } catch (_) {} }
        if (type === "embed_tenant" && env.AI && env.VECTORIZE && env.ASTON_DB) {
          await ensureSchema(env.ASTON_DB);
          const rows = await env.ASTON_DB.prepare("SELECT id, sector, text FROM records WHERE tenant = ? ORDER BY created_at DESC LIMIT 50").bind(tenant).all();
          const records = rows.results || [];
          if (records.length) {
            const texts = records.map(r => String(r.text || "").slice(0, 1500) || r.id);
            const vectors = await embedTexts(env, texts);
            await env.VECTORIZE.upsert(records.map((r, i) => ({ id: `${tenant}:${r.id}`, values: vectors[i], metadata: { tenant, sector: r.sector, record_id: r.id } })));
          }
        }
        if (env.ASTON_DB) { try { await env.ASTON_DB.prepare("UPDATE jobs SET status = ?, result = ?, updated_at = ? WHERE id = ?").bind("done", JSON.stringify({ ok: true, type }), new Date().toISOString(), id).run(); } catch (_) {} }
        msg.ack();
      } catch (e) {
        console.error("queue job failed", type, e?.message || e);
        if (env.ASTON_DB) { try { await env.ASTON_DB.prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?").bind("failed", String(e?.message || e).slice(0, 500), new Date().toISOString(), id).run(); } catch (_) {} }
        msg.retry();
      }
    }
  }
};

export class AstonSession {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const key = "session";
    if (request.method === "GET") return json({ ok: true, session: (await this.ctx.storage.get(key)) ?? null });
    if (request.method === "DELETE") { await this.ctx.storage.deleteAll(); return json({ ok: true, deleted: true }); }
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
    const minute = Math.floor(Date.now() / 60000);
    const key = "rate-window";
    const saved = (await this.ctx.storage.get(key)) || {};
    const count = saved.minute === minute ? Number(saved.count) || 0 : 0;
    const limit = Math.max(1, Math.min(300, Number(request.headers.get("x-aston-limit")) || Number(this.env.RATE_LIMIT_PER_MINUTE) || 120));
    if (count >= limit) return json({ ok: false, error: "rate_limited" }, 429, { "retry-after": "60" });
    await this.ctx.storage.put(key, { minute, count: count + 1 });
    return json({ ok: true, remaining: limit - count - 1 });
  }
}

export class AstonLedgerLock {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const body = await readJson(request);
    if (!body || typeof body !== "object") return json({ ok: false, error: "json_object_required" }, 400);
    const key = String(body.key || "default");
    return json({ ok: true, key, value: (await this.ctx.storage.get(key)) ?? null });
  }
}

export { AstonAgent } from "./agent.js";
