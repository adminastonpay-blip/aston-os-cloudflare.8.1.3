/**
 * Anti-Gap Phase 4 — BYOK, retention, observability
 */

import {
  loadByok,
  saveByok,
  deleteByok,
  maskByok,
  runByokChat,
  envByok
} from "./byok.js";
import { loadRetention, saveRetention, enforceRetention } from "./retention.js";
import { observabilitySummary } from "./observability.js";
import { checkBudget, recordRoiEvent, estimateCostMicros } from "./roi.js";
import { runWithFallbacks, buildModelCandidates, loadModelPolicy } from "./model-portfolio.js";
import { reportBreaker } from "./resilience.js";

export const PHASE4_VERSION = "8.12.3-p4";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8",
    "x-aston-anti-gap": PHASE4_VERSION
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

async function handleHybridChat(request, env, ctx) {
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
  if (!prompt) return json({ ok: false, error: "prompt_required" }, 400, request, env);
  if (prompt.length > 8000) {
    return json({ ok: false, error: "prompt_too_long", max: 8000 }, 400, request, env);
  }

  const tenant = auth?.tenant || "anonymous";
  const started = Date.now();

  if (auth) {
    const budget = await checkBudget(env, tenant);
    if (budget.hard) {
      return json({ ok: false, error: "budget_exceeded", budget }, 429, request, env);
    }
  }

  const byokCfg = (auth && (await loadByok(env, tenant))) || envByok(env);
  const forceByok = request.headers.get("X-Aston-Byok") === "1" || body.byok === true;
  const preferByok = forceByok || byokCfg?.prefer_over_workers === true;

  const messages = [{ role: "user", content: prompt }];
  if (typeof body.system === "string" && body.system.trim()) {
    messages.unshift({ role: "system", content: body.system.trim().slice(0, 4000) });
  }

  const attempts = [];
  let run = null;

  if (preferByok && byokCfg?.enabled && byokCfg.api_key) {
    const b = await runByokChat(byokCfg, messages, {
      model: body.model || byokCfg.model,
      max_tokens: body.max_tokens
    });
    attempts.push({ provider: "byok", ok: b.ok, model: body.model || byokCfg.model, detail: b.error });
    if (b.ok) run = b;
  }

  if (!run && env.AI) {
    const policy = auth ? await loadModelPolicy(env, tenant) : null;
    const candidates = buildModelCandidates(env, body, policy);
    const w = await runWithFallbacks(env, candidates, messages, {
      max_tokens: body.max_tokens,
      max_cost_weight: policy?.max_cost_weight || body.max_cost_weight
    });
    attempts.push(...(w.attempts || []).map((a) => ({ provider: "workers_ai", ...a })));
    if (w.ok) run = { ...w, provider: "workers_ai" };
  }

  if (!run && !preferByok && byokCfg?.enabled && byokCfg.api_key) {
    const b = await runByokChat(byokCfg, messages, {
      model: body.model || byokCfg.model,
      max_tokens: body.max_tokens
    });
    attempts.push({ provider: "byok", ok: b.ok, model: body.model || byokCfg.model, detail: b.error });
    if (b.ok) run = b;
  }

  if (!run) {
    await reportBreaker(env, "ai", false);
    return json(
      {
        ok: false,
        error: "ai_request_failed",
        attempts,
        anti_gap: { phase: 4, version: PHASE4_VERSION }
      },
      502,
      request,
      env
    );
  }

  await reportBreaker(env, "ai", true);

  const tokensIn = Math.ceil(prompt.length / 4);
  const tokensOut = Math.ceil(run.text.length / 4);
  const cost = estimateCostMicros(run.model, tokensIn, tokensOut);

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
        outcome: "ok"
      }).catch(() => {})
    );
  }

  return json(
    {
      ok: true,
      model: run.model,
      result: run.result,
      text: run.text,
      provider: run.provider || "unknown",
      attempts,
      anti_gap: { phase: 4, version: PHASE4_VERSION },
      latency_ms: Date.now() - started
    },
    200,
    request,
    env
  );
}

export async function tryHandlePhase4(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  if (env.ANTI_GAP_P4 === "false") return null;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return null;

  if (method === "POST" && path === "/v1/ai/chat") {
    const forceByok = request.headers.get("X-Aston-Byok") === "1";
    if (forceByok) return handleHybridChat(request, env, ctx);
    if (env.BYOK_DEFAULT === "true") return handleHybridChat(request, env, ctx);
    return null;
  }

  if (path === "/v1/policies/byok") {
    if (method === "GET") {
      const auth = await authorized(request, env, "admin");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
      const cfg = await loadByok(env, auth.tenant);
      const global = envByok(env);
      return json(
        {
          ok: true,
          tenant: auth.tenant,
          byok: maskByok(cfg),
          env_fallback: global ? maskByok(global) : null
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
      const saved = await saveByok(env, auth.tenant, body);
      return json(saved, saved.ok ? 200 : 400, request, env);
    }
    if (method === "DELETE") {
      const auth = await authorized(request, env, "admin");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
      const deleted = await deleteByok(env, auth.tenant);
      return json(deleted, 200, request, env);
    }
  }

  if (path === "/v1/policies/retention") {
    if (method === "GET") {
      const auth = await authorized(request, env, "read");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
      const policy = await loadRetention(env, auth.tenant);
      return json({ ok: true, tenant: auth.tenant, policy }, 200, request, env);
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
      const saved = await saveRetention(env, auth.tenant, body);
      return json(saved, saved.ok ? 200 : 503, request, env);
    }
  }

  if (method === "POST" && path === "/v1/compliance/enforce-retention") {
    const auth = await authorized(request, env, "admin");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const result = await enforceRetention(env, auth.tenant);
    return json(
      { ...result, anti_gap: { phase: 4, version: PHASE4_VERSION } },
      result.ok ? 200 : 400,
      request,
      env
    );
  }

  if (method === "GET" && path === "/v1/observability") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    const days = Number(url.searchParams.get("days")) || 7;
    const hours = Number(url.searchParams.get("hours")) || 24;
    const data = await observabilitySummary(env, auth.tenant, { days, hours });
    return json(data, 200, request, env);
  }

  return null;
}

export function enrichHealthPhase4(result, env) {
  if (!result.anti_gap) result.anti_gap = {};
  result.anti_gap.phase = Math.max(Number(result.anti_gap.phase) || 1, 4);
  result.anti_gap.version = PHASE4_VERSION;
  result.anti_gap.features = [
    ...(result.anti_gap.features || []),
    "byok",
    "retention_policies",
    "observability"
  ];
  result.anti_gap.features = [...new Set(result.anti_gap.features)];
  result.anti_gap.p4_enabled = env.ANTI_GAP_P4 !== "false";
  return result;
}

export async function runPhase4Cron(env) {
  return { ok: true, note: "p4_cron_noop" };
}
