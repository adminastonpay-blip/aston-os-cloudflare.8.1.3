/**
 * Anti-Gap Phase 4 — BYOK (Bring Your Own Key) OpenAI-compatible providers
 * Keys stored in KV per tenant (not in code). Optional env global key.
 */

import { extractText } from "./model-portfolio.js";

const KEY_PREFIX = "aston:byok:";

export async function loadByok(env, tenant) {
  if (!env?.ASTON_KV) return null;
  try {
    const raw = await env.ASTON_KV.get(`${KEY_PREFIX}${tenant}`);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return {
      base_url: typeof p.base_url === "string" ? p.base_url.replace(/\/+$/, "") : null,
      api_key: typeof p.api_key === "string" ? p.api_key : null,
      model: typeof p.model === "string" ? p.model : "gpt-4o-mini",
      enabled: p.enabled !== false,
      prefer_over_workers: Boolean(p.prefer_over_workers),
      updated_at: p.updated_at || null
    };
  } catch {
    return null;
  }
}

export async function saveByok(env, tenant, body) {
  if (!env?.ASTON_KV) return { ok: false, error: "kv_missing" };
  const existing = await loadByok(env, tenant);
  const clean = {
    base_url:
      typeof body.base_url === "string"
        ? body.base_url.replace(/\/+$/, "").slice(0, 300)
        : existing?.base_url || "https://api.openai.com/v1",
    api_key:
      typeof body.api_key === "string" && body.api_key.length > 0
        ? body.api_key.slice(0, 500)
        : existing?.api_key || null,
    model: typeof body.model === "string" ? body.model.slice(0, 120) : existing?.model || "gpt-4o-mini",
    enabled: body.enabled !== false,
    prefer_over_workers: Boolean(body.prefer_over_workers),
    updated_at: new Date().toISOString()
  };
  if (!clean.api_key) return { ok: false, error: "api_key_required" };
  await env.ASTON_KV.put(`${KEY_PREFIX}${tenant}`, JSON.stringify(clean), {
    expirationTtl: 60 * 60 * 24 * 365
  });
  return { ok: true, config: maskByok(clean) };
}

export function maskByok(cfg) {
  if (!cfg) return null;
  const key = cfg.api_key || "";
  return {
    base_url: cfg.base_url,
    model: cfg.model,
    enabled: cfg.enabled !== false,
    prefer_over_workers: Boolean(cfg.prefer_over_workers),
    api_key_set: Boolean(key),
    api_key_preview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : null,
    updated_at: cfg.updated_at || null
  };
}

export async function deleteByok(env, tenant) {
  if (!env?.ASTON_KV) return { ok: false, error: "kv_missing" };
  await env.ASTON_KV.delete(`${KEY_PREFIX}${tenant}`);
  return { ok: true, deleted: true };
}

export async function runByokChat(cfg, messages, opts = {}) {
  if (!cfg?.enabled || !cfg.api_key || !cfg.base_url) {
    return { ok: false, error: "byok_not_configured" };
  }
  const model = opts.model || cfg.model || "gpt-4o-mini";
  const maxTokens = Math.min(4096, Math.max(64, Number(opts.max_tokens) || 1024));
  const url = `${cfg.base_url}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(opts.timeout_ms) || 30000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.api_key}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: "byok_http_error",
        status: res.status,
        detail: String(data?.error?.message || data?.error || res.statusText).slice(0, 300)
      };
    }
    const text = extractText(data);
    if (!text) return { ok: false, error: "byok_empty", model };
    return {
      ok: true,
      model: `byok:${model}`,
      result: data,
      text,
      provider: "byok"
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      error: "byok_request_failed",
      detail: String(e?.message || e).slice(0, 200)
    };
  }
}

export function envByok(env) {
  if (!env.OPENAI_API_KEY) return null;
  return {
    base_url: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    api_key: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || "gpt-4o-mini",
    enabled: true,
    prefer_over_workers: env.BYOK_PREFER === "true"
  };
}
