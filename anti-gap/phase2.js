/**
 * Anti-Gap Phase 2 — enhanced AI chat, model policies, budget gate
 * Does not modify index.js. entry.js calls tryHandlePhase2 first.
 */

import { checkBudget, recordRoiEvent, estimateCostMicros } from "./roi.js";
import {
  buildModelCandidates,
  loadModelPolicy,
  saveModelPolicy,
  runWithFallbacks,
  modelCostWeight
} from "./model-portfolio.js";
import { chatCacheKey, getCachedChat, setCachedChat } from "./ai-cache.js";
import { reportBreaker, getBreakerState } from "./resilience.js";

export const PHASE2_VERSION = "8.12.3-p2";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8",
    "x-aston-anti-gap": PHASE2_VERSION
  };
  if (allowed && origin === allowed) headers["access-control-allow-origin"] = origin;
  else if (origin) headers["access-control-allow-origin"] = origin;
  else headers["access-control-allow-origin"] = "*";
  return headers;
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(request, env)
  });
}

async function authorized(request, env, scope = "read") {
  const value = request.headers.get("Authorization") || "";
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
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
    if (header.alg !== "HS256" || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.ASTON_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signature = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;
    const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
    if (!scopes.includes(scope) && !scopes.includes("admin")) return null;
    return {
      tenant: String(payload.tenant || "default"),
      scopes,
      actor: String(payload.sub || "jwt")
    };
  } catch {
    return null;
  }
}

async function handleEnhancedChat(request, env, ctx) {
  const publicChat = env.PUBLIC_CHAT === "true";
  const auth = await authorized(request, env, "ai");
  if (!auth && !publicChat) {
    return json({ ok: false, error: "unauthorized" }, 401, request, env);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, request, env);
  }

  const prompt =
    (typeof body.prompt === "string" && body.prompt.trim()) ||
    (typeof body.message === "string" && body.message.trim()) ||
    "";
  if (!prompt) {
    return json({ ok: false, error: "prompt_required" }, 400, request, env);
  }
  if (prompt.length > 8000) {
    return json({ ok: false, error: "prompt_too_long", max: 8000 }, 400, request, env);
  }

  if (!env.AI) {
    return json(
      { ok: false, error: "plugin_inactive", plugin: "ai-chat", missing_bindings: ["AI"] },
      503,
      request,
      env
    );
  }

  const tenant = auth?.tenant || "anonymous";
  const started = Date.now();

  if (auth) {
    const budget = await checkBudget(env, tenant);
    if (budget.hard) {
      return json(
        {
          ok: false,
          error: "budget_exceeded",
          budget,
          hint: "Raise tenant_budgets.monthly_usd_micros or set hard_block=0"
        },
        429,
        request,
        env
      );
    }
    if (budget.soft) body._budget_soft = true;
  }

  const breaker = await getBreakerState(env, "ai");
  if (breaker === "open") {
    return json(
      { ok: false, error: "ai_circuit_open", retry_after_sec: 60 },
      503,
      request,
      env
    );
  }

  const policy = auth ? await loadModelPolicy(env, tenant) : null;
  const candidates = buildModelCandidates(env, body, policy);
  const useCache = body.cache !== false && env.ASTON_KV;
  const cacheKey = useCache
    ? await chatCacheKey(tenant, prompt, body.model || policy?.primary || "")
    : null;

  if (cacheKey) {
    const hit = await getCachedChat(env, cacheKey);
    if (hit?.text) {
      if (auth && ctx?.waitUntil) {
        ctx.waitUntil(
          recordRoiEvent(env, {
            tenant_id: tenant,
            route: "/v1/ai/chat",
            model: hit.model || "cache",
            tokens_in: Math.ceil(prompt.length / 4),
            tokens_out: Math.ceil(String(hit.text).length / 4),
            cost_usd_micros: 0,
            latency_ms: Date.now() - started,
            outcome: "cache_hit"
          }).catch(() => {})
        );
      }
      return json(
        {
          ok: true,
          model: hit.model,
          result: hit.result ?? { response: hit.text },
          text: hit.text,
          cached: true,
          anti_gap: { phase: 2, version: PHASE2_VERSION },
          latency_ms: Date.now() - started
        },
        200,
        request,
        env
      );
    }
  }

  const messages = [{ role: "user", content: prompt }];
  if (typeof body.system === "string" && body.system.trim()) {
    messages.unshift({ role: "system", content: body.system.trim().slice(0, 4000) });
  }

  const run = await runWithFallbacks(env, candidates, messages, {
    max_tokens: body.max_tokens,
    max_cost_weight: policy?.max_cost_weight || body.max_cost_weight
  });

  if (!run.ok) {
    await reportBreaker(env, "ai", false);
    if (auth && ctx?.waitUntil) {
      ctx.waitUntil(
        recordRoiEvent(env, {
          tenant_id: tenant,
          route: "/v1/ai/chat",
          model: null,
          latency_ms: Date.now() - started,
          outcome: "error"
        }).catch(() => {})
      );
    }
    return json(
      {
        ok: false,
        error: "ai_request_failed",
        detail: run.error,
        attempts: run.attempts,
        anti_gap: { phase: 2, version: PHASE2_VERSION }
      },
      502,
      request,
      env
    );
  }

  await reportBreaker(env, "ai", true);

  const tokensIn = Math.ceil(prompt.length / 4);
  const tokensOut = Math.ceil(run.text.length / 4);
  const cost = estimateCostMicros(run.model, tokensIn, tokensOut) * modelCostWeight(run.model);

  if (cacheKey) {
    const ttl = policy?.cache_ttl_sec || 300;
    if (ctx?.waitUntil) {
      ctx.waitUntil(
        setCachedChat(env, cacheKey, { text: run.text, model: run.model, result: run.result }, ttl)
      );
    } else {
      await setCachedChat(env, cacheKey, { text: run.text, model: run.model, result: run.result }, ttl);
    }
  }

  if (auth && ctx?.waitUntil) {
    ctx.waitUntil(
      recordRoiEvent(env, {
        tenant_id: tenant,
        route: "/v1/ai/chat",
        model: run.model,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd_micros: cost,
        latency_ms: Date.now() - started,
        outcome: body._budget_soft ? "ok_soft_budget" : "ok"
      }).catch(() => {})
    );
  }

  return json(
    {
      ok: true,
      model: run.model,
      result: run.result,
      text: run.text,
      cached: false,
      attempts: run.attempts,
      budget_soft: Boolean(body._budget_soft),
      anti_gap: { phase: 2, version: PHASE2_VERSION },
      latency_ms: Date.now() - started
    },
    200,
    request,
    env
  );
}

async function handleModelPolicy(request, env) {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const policy = await loadModelPolicy(env, auth.tenant);
    return json(
      {
        ok: true,
        tenant: auth.tenant,
        policy: policy || {
          primary: env.AI_MODEL || null,
          fallback: [],
          prefer_cheap: false,
          source: "defaults"
        },
        defaults: { note: "Workers AI models; set via POST /v1/policies/models" }
      },
      200,
      request,
      env
    );
  }

  if (method === "POST") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, request, env);
    }
    if (!env.ASTON_KV) {
      return json({ ok: false, error: "kv_required_for_policies" }, 503, request, env);
    }
    const saved = await saveModelPolicy(env, auth.tenant, body);
    return json(saved, saved.ok ? 200 : 503, request, env);
  }

  return json({ ok: false, error: "method_not_allowed" }, 405, request, env);
}

export async function tryHandlePhase2(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  if (env.ANTI_GAP_P2 === "false") return null;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return null;

  if (method === "POST" && path === "/v1/ai/chat") {
    const forceCore = request.headers.get("X-Aston-Core-Only") === "1";
    if (forceCore) return null;
    return handleEnhancedChat(request, env, ctx);
  }

  if (path === "/v1/policies/models" && (method === "GET" || method === "POST")) {
    return handleModelPolicy(request, env);
  }

  return null;
}

export function enrichHealthPhase2(result, env) {
  if (!result.anti_gap) result.anti_gap = {};
  result.anti_gap.phase = Math.max(Number(result.anti_gap.phase) || 1, 2);
  result.anti_gap.version = PHASE2_VERSION;
  result.anti_gap.features = [
    ...(result.anti_gap.features || []),
    "multi_model_router",
    "ai_kv_cache",
    "budget_gate",
    "model_policies"
  ];
  result.anti_gap.features = [...new Set(result.anti_gap.features)];
  result.anti_gap.p2_enabled = env.ANTI_GAP_P2 !== "false";
  return result;
}
