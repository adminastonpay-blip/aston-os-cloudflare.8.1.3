/**
 * Anti-Gap Phase 2 — multi-model portfolio (Workers AI first, BYOK later)
 */

export const DEFAULT_FALLBACKS = [
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/google/gemma-3-12b-it",
  "@cf/qwen/qwen2.5-coder-32b-instruct"
];

export function modelCostWeight(model) {
  const m = String(model || "").toLowerCase();
  if (/70b|32b|opus|gpt-4|405b/.test(m)) return 4;
  if (/13b|12b|14b|27b/.test(m)) return 2;
  return 1;
}

export function buildModelCandidates(env, body = {}, policy = null) {
  const list = [];
  const push = (m) => {
    if (!m || typeof m !== "string") return;
    const t = m.trim();
    if (t && !list.includes(t)) list.push(t);
  };

  push(body.model);
  if (policy?.primary) push(policy.primary);
  if (Array.isArray(policy?.fallback)) policy.fallback.forEach(push);
  push(env.AI_MODEL);
  push(env.ASTON_AI_MODEL);
  DEFAULT_FALLBACKS.forEach(push);

  if (policy?.prefer_cheap === true || body.prefer_cheap === true) {
    list.sort((a, b) => modelCostWeight(a) - modelCostWeight(b));
  }

  return list;
}

export async function loadModelPolicy(env, tenant) {
  if (!env?.ASTON_KV) return null;
  try {
    const raw = await env.ASTON_KV.get(`aston:policy:models:${tenant}`);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return {
      primary: typeof p.primary === "string" ? p.primary : null,
      fallback: Array.isArray(p.fallback) ? p.fallback.map(String).slice(0, 8) : [],
      prefer_cheap: Boolean(p.prefer_cheap),
      max_cost_weight: Number(p.max_cost_weight) || 99,
      cache_ttl_sec: Math.min(3600, Math.max(0, Number(p.cache_ttl_sec) || 300))
    };
  } catch {
    return null;
  }
}

export async function saveModelPolicy(env, tenant, policy) {
  if (!env?.ASTON_KV) return { ok: false, error: "kv_missing" };
  const clean = {
    primary: typeof policy.primary === "string" ? policy.primary.slice(0, 120) : null,
    fallback: Array.isArray(policy.fallback)
      ? policy.fallback.map((m) => String(m).slice(0, 120)).slice(0, 8)
      : [],
    prefer_cheap: Boolean(policy.prefer_cheap),
    max_cost_weight: Math.min(99, Math.max(1, Number(policy.max_cost_weight) || 99)),
    cache_ttl_sec: Math.min(3600, Math.max(0, Number(policy.cache_ttl_sec) || 300)),
    updated_at: new Date().toISOString()
  };
  await env.ASTON_KV.put(`aston:policy:models:${tenant}`, JSON.stringify(clean), {
    expirationTtl: 60 * 60 * 24 * 90
  });
  return { ok: true, policy: clean };
}

export async function runWithFallbacks(env, candidates, messages, opts = {}) {
  if (!env?.AI) return { ok: false, error: "ai_binding_missing", attempts: [] };

  const maxTokens = Math.min(4096, Math.max(64, Number(opts.max_tokens) || 1024));
  const attempts = [];
  const maxWeight = Number(opts.max_cost_weight) || 99;

  for (const model of candidates) {
    if (modelCostWeight(model) > maxWeight) {
      attempts.push({ model, skipped: true, reason: "cost_weight" });
      continue;
    }
    try {
      const result = await env.AI.run(model, {
        messages,
        max_tokens: maxTokens
      });
      const text = extractText(result);
      if (text) {
        attempts.push({ model, ok: true });
        return { ok: true, model, result, text, attempts };
      }
      attempts.push({ model, ok: false, reason: "empty_response" });
    } catch (e) {
      attempts.push({ model, ok: false, reason: String(e?.message || e).slice(0, 200) });
    }
  }

  return { ok: false, error: "all_models_failed", attempts };
}

export function extractText(o) {
  if (typeof o === "string") return o.trim();
  const t =
    o?.response ||
    o?.text ||
    o?.result?.response ||
    o?.choices?.[0]?.message?.content ||
    "";
  return typeof t === "string" ? t.trim() : "";
}
