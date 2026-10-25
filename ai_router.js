// ASTON OS — Phase 4: Multi-Model AI Orchestration Engine
// Intelligent LLM router (cost/latency) + Edge RAG (Vectorize + ontology)

const VERSION = "10.9.0";

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

export const MODEL_CATALOG = [
  { id: "workers-llama-8b", provider: "workers_ai", model: "@cf/meta/llama-3.1-8b-instruct", tier: "fast", latency_ms: 40, cost_per_1k: 0.0, max_tokens: 2048, strengths: ["chat", "classify", "summarize"] },
  { id: "workers-llama-70b", provider: "workers_ai", model: "@cf/meta/llama-3.1-70b-instruct", tier: "balanced", latency_ms: 120, cost_per_1k: 0.0, max_tokens: 4096, strengths: ["reason", "plan", "analyze"] },
  { id: "workers-qwen", provider: "workers_ai", model: "@cf/qwen/qwen1.5-14b-chat-awq", tier: "fast", latency_ms: 50, cost_per_1k: 0.0, max_tokens: 2048, strengths: ["chat", "multilingual"] },
  { id: "openai-gpt4o", provider: "openai", model: "gpt-4o", tier: "heavy", latency_ms: 800, cost_per_1k: 0.005, max_tokens: 8192, strengths: ["reason", "code", "analyze"], requires: "OPENAI_API_KEY" },
  { id: "openai-gpt4o-mini", provider: "openai", model: "gpt-4o-mini", tier: "balanced", latency_ms: 400, cost_per_1k: 0.0003, max_tokens: 8192, strengths: ["chat", "classify"], requires: "OPENAI_API_KEY" },
  { id: "anthropic-sonnet", provider: "anthropic", model: "claude-3-5-sonnet-20241022", tier: "heavy", latency_ms: 900, cost_per_1k: 0.003, max_tokens: 8192, strengths: ["reason", "analyze", "long_context"], requires: "ANTHROPIC_API_KEY" }
];

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

function scoreTask(prompt, opts = {}) {
  const p = String(prompt || "").toLowerCase();
  const len = p.length;
  let complexity = 0;
  if (len > 2000) complexity += 2;
  else if (len > 500) complexity += 1;
  if (/\b(analy[sz]e|reason|compare|strategy|plan|why|explain in detail)\b/.test(p)) complexity += 2;
  if (/\b(code|refactor|architecture|prove|legal)\b/.test(p)) complexity += 2;
  if (opts.force_tier === "heavy") complexity = 5;
  if (opts.force_tier === "fast") complexity = 0;
  if (opts.max_latency_ms && opts.max_latency_ms < 100) complexity = Math.min(complexity, 1);
  return complexity;
}

export function selectModel(prompt, env, opts = {}) {
  const complexity = scoreTask(prompt, opts);
  const available = MODEL_CATALOG.filter((m) => {
    if (m.provider === "workers_ai") return Boolean(env.AI);
    if (m.requires) return Boolean(env[m.requires]);
    return true;
  });
  if (!available.length) return null;
  let pool;
  if (complexity >= 4) {
    pool = available.filter((m) => m.tier === "heavy");
    if (!pool.length) pool = available.filter((m) => m.tier === "balanced");
  } else if (complexity >= 2) {
    pool = available.filter((m) => m.tier === "balanced" || m.tier === "fast");
  } else {
    pool = available.filter((m) => m.tier === "fast");
  }
  if (!pool.length) pool = available;
  if (opts.max_latency_ms) {
    const tight = pool.filter((m) => m.latency_ms <= opts.max_latency_ms);
    if (tight.length) pool = tight;
  }
  if (opts.prefer_provider) {
    const pref = pool.filter((m) => m.provider === opts.prefer_provider);
    if (pref.length) pool = pref;
  }
  pool.sort((a, b) => a.cost_per_1k - b.cost_per_1k || a.latency_ms - b.latency_ms);
  return { model: pool[0], complexity, candidates: pool.map((m) => m.id) };
}

async function runWorkersAI(env, modelId, messages, opts = {}) {
  const result = await env.AI.run(modelId, {
    messages, max_tokens: opts.max_tokens || 1024, temperature: opts.temperature ?? 0.3
  });
  const text = result?.response || result?.result?.response || (typeof result === "string" ? result : JSON.stringify(result));
  return { text: String(text), raw: result };
}

async function runOpenAI(env, modelId, messages, opts = {}) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, messages, max_tokens: opts.max_tokens || 1024, temperature: opts.temperature ?? 0.3 })
  });
  if (!res.ok) throw new Error(`openai_${res.status}:${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content || "", raw: data };
}

async function runAnthropic(env, modelId, messages, opts = {}) {
  const system = messages.find((m) => m.role === "system")?.content;
  const userMsgs = messages.filter((m) => m.role !== "system");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId, max_tokens: opts.max_tokens || 1024, system: system || undefined,
      messages: userMsgs.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }))
    })
  });
  if (!res.ok) throw new Error(`anthropic_${res.status}:${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { text: data.content?.map((c) => c.text).filter(Boolean).join("\n") || "", raw: data };
}

async function runModel(env, entry, messages, opts = {}) {
  if (entry.provider === "workers_ai") return runWorkersAI(env, entry.model, messages, opts);
  if (entry.provider === "openai") return runOpenAI(env, entry.model, messages, opts);
  if (entry.provider === "anthropic") return runAnthropic(env, entry.model, messages, opts);
  throw new Error(`unknown_provider:${entry.provider}`);
}

async function embedQuery(env, text) {
  if (!env.AI) return null;
  const result = await env.AI.run(EMBED_MODEL, { text: [String(text).slice(0, 2000)] });
  return result?.data?.[0] || (Array.isArray(result) ? result[0] : null);
}

async function retrieveContext(env, tenant, query, opts = {}) {
  const chunks = [];
  const topK = Math.min(12, Number(opts.top_k) || 5);
  if (env.VECTORIZE && env.AI) {
    try {
      const values = await embedQuery(env, query);
      if (values) {
        const matches = await env.VECTORIZE.query(values, { topK, returnMetadata: true });
        for (const m of matches?.matches || []) {
          chunks.push({ source: "vectorize", id: m.id, score: m.score, text: m.metadata?.text || m.metadata?.content || "", metadata: m.metadata || {} });
        }
      }
    } catch (e) { console.error("rag vectorize", e?.message || e); }
  }
  if (env.ASTON_DB && opts.include_ontology !== false) {
    try {
      const q = `%${String(query).slice(0, 80).replace(/%/g, "")}%`;
      const rows = await env.ASTON_DB.prepare(
        `SELECT id, type, name, props FROM ontology_entities WHERE tenant = ? AND (name LIKE ? OR type LIKE ?) ORDER BY updated_at DESC LIMIT ?`
      ).bind(tenant, q, q, topK).all();
      for (const r of rows.results || []) {
        chunks.push({ source: "ontology", id: r.id, text: `${r.type}: ${r.name}`, metadata: { type: r.type, name: r.name } });
      }
    } catch (_) {}
  }
  return chunks;
}

function buildRagMessages(query, chunks, systemExtra = "") {
  const context = chunks.map((c, i) => `[${i + 1}] (${c.source}) ${c.text || JSON.stringify(c.metadata)}`).join("\n").slice(0, 6000);
  const system = `You are ASTON OS edge assistant. Answer using the CONTEXT when relevant. If context is insufficient, say so briefly.\n${systemExtra}`.trim();
  const user = context ? `CONTEXT:\n${context}\n\nQUESTION:\n${query}` : query;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

async function simpleAuth(request, env) {
  const token = bearer(request);
  if (!token) return null;
  if (env.ASTON_API_TOKEN && token === env.ASTON_API_TOKEN) {
    return { tenant: request.headers.get("X-Tenant") || "default", actor: request.headers.get("X-Aston-Actor") || "api-token", scopes: ["read", "write", "ai", "admin"] };
  }
  return { tenant: request.headers.get("X-Tenant") || "default", actor: "token", scopes: ["ai", "read"] };
}

export async function handleAiRouter(request, env, path, method, cors = {}) {
  const url = new URL(request.url);

  if (method === "GET" && (path === "/v1/ai/models" || path === "/v1/ai/catalog")) {
    const available = MODEL_CATALOG.map((m) => ({
      ...m,
      available: m.provider === "workers_ai" ? Boolean(env.AI) : m.requires ? Boolean(env[m.requires]) : true
    }));
    return json({ ok: true, phase: "4-ai-router", version: VERSION, models: available }, 200, cors);
  }

  if (method === "GET" && path === "/v1/ai/status") {
    return json({
      ok: true, phase: "4-ai-router", version: VERSION,
      bindings: { workers_ai: Boolean(env.AI), vectorize: Boolean(env.VECTORIZE), openai: Boolean(env.OPENAI_API_KEY), anthropic: Boolean(env.ANTHROPIC_API_KEY), d1: Boolean(env.ASTON_DB) },
      endpoints: { models: "GET /v1/ai/models", route: "POST /v1/ai/route", chat: "POST /v1/ai/chat", rag: "POST /v1/ai/rag", status: "GET /v1/ai/status" }
    }, 200, cors);
  }

  const auth = await simpleAuth(request, env);
  if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const tenant = auth.tenant;

  if (method === "POST" && path === "/v1/ai/route") {
    const body = await readJson(request);
    const prompt = body?.prompt || body?.message || "";
    const selection = selectModel(prompt, env, { force_tier: body?.tier, max_latency_ms: body?.max_latency_ms, prefer_provider: body?.prefer_provider });
    if (!selection) return json({ ok: false, error: "no_models_available" }, 503, cors);
    return json({
      ok: true, selected: selection.model.id, provider: selection.model.provider, tier: selection.model.tier,
      latency_ms_est: selection.model.latency_ms, cost_per_1k: selection.model.cost_per_1k,
      complexity: selection.complexity, candidates: selection.candidates
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/ai/chat") {
    const body = await readJson(request);
    const prompt = typeof body?.prompt === "string" ? body.prompt : body?.message;
    if (!prompt || !String(prompt).trim()) return json({ ok: false, error: "prompt_required" }, 400, cors);
    const t0 = Date.now();
    const selection = selectModel(prompt, env, { force_tier: body?.tier, max_latency_ms: body?.max_latency_ms, prefer_provider: body?.prefer_provider });
    if (!selection) return json({ ok: false, error: "no_models_available", hint: "Bind AI or set OPENAI_API_KEY" }, 503, cors);
    let entry = selection.model;
    if (body?.model) {
      const forced = MODEL_CATALOG.find((m) => m.id === body.model || m.model === body.model);
      if (forced) entry = forced;
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [
      { role: "system", content: body?.system || "You are ASTON OS assistant on Cloudflare edge." },
      { role: "user", content: String(prompt) }
    ];
    try {
      const out = await runModel(env, entry, messages, { max_tokens: body?.max_tokens || 1024, temperature: body?.temperature });
      return json({ ok: true, model: entry.id, provider: entry.provider, tier: entry.tier, complexity: selection.complexity, latency_ms: Date.now() - t0, response: out.text }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "ai_failed", detail: String(e.message || e).slice(0, 300) }, 502, cors);
    }
  }

  if (method === "POST" && path === "/v1/ai/rag") {
    const body = await readJson(request);
    const query = body?.query || body?.prompt || body?.question;
    if (!query || !String(query).trim()) return json({ ok: false, error: "query_required" }, 400, cors);
    const t0 = Date.now();
    const chunks = await retrieveContext(env, tenant, String(query), { top_k: body?.top_k, include_ontology: body?.include_ontology !== false });
    const messages = buildRagMessages(String(query), chunks, body?.system || "");
    const selection = selectModel(query, env, { force_tier: body?.tier || (chunks.length ? "balanced" : "fast"), max_latency_ms: body?.max_latency_ms });
    if (!selection) return json({ ok: false, error: "no_models_available", chunks }, 503, cors);
    try {
      const out = await runModel(env, selection.model, messages, { max_tokens: body?.max_tokens || 1024, temperature: body?.temperature ?? 0.2 });
      return json({
        ok: true, model: selection.model.id, provider: selection.model.provider, latency_ms: Date.now() - t0,
        retrieval: { count: chunks.length, sources: chunks.map((c) => c.source) },
        chunks: chunks.slice(0, 8), response: out.text
      }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "rag_failed", detail: String(e.message || e).slice(0, 300), chunks: chunks.slice(0, 5) }, 502, cors);
    }
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
