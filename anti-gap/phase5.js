/**
 * Anti-Gap Phase 5 — structured tools + agent routes
 */

import { loadToolRegistry, saveToolRegistry, executeTool } from "./tools.js";
import { runAgentWithMetering } from "./agent.js";

export const PHASE5_VERSION = "8.12.3-p5";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Tenant",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "content-type": "application/json; charset=utf-8",
    "x-aston-anti-gap": PHASE5_VERSION
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

export async function tryHandlePhase5(request, env, ctx) {
  if (env.ANTI_GAP === "false") return null;
  if (env.ANTI_GAP_P5 === "false") return null;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return null;

  if (path === "/v1/ai/tools") {
    if (method === "GET") {
      const auth = await authorized(request, env, "read");
      if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
      const reg = await loadToolRegistry(env, auth.tenant);
      return json(
        {
          ok: true,
          tenant: auth.tenant,
          tools: reg.tools,
          allow_hosts: reg.allow_hosts,
          anti_gap: { phase: 5, version: PHASE5_VERSION }
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
      const saved = await saveToolRegistry(env, auth.tenant, body);
      return json(saved, saved.ok ? 200 : 503, request, env);
    }
  }

  if (method === "POST" && path === "/v1/ai/tools/invoke") {
    const auth = await authorized(request, env, "ai");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, request, env);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, request, env);
    }
    const name = body.name || body.tool;
    if (!name) return json({ ok: false, error: "name_required" }, 400, request, env);
    const reg = await loadToolRegistry(env, auth.tenant);
    const result = await executeTool(env, auth.tenant, name, body.arguments || body.args || {}, reg);
    return json(
      { ...result, anti_gap: { phase: 5, version: PHASE5_VERSION } },
      result.ok ? 200 : 400,
      request,
      env
    );
  }

  if (method === "POST" && path === "/v1/ai/agent") {
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
    const tenant = auth?.tenant || "anonymous";
    const result = await runAgentWithMetering(env, tenant, body, ctx);
    return json(
      {
        ...result,
        anti_gap: { phase: 5, version: PHASE5_VERSION }
      },
      result.ok ? 200 : result.error === "budget_exceeded" ? 429 : 400,
      request,
      env
    );
  }

  return null;
}

export function enrichHealthPhase5(result, env) {
  if (!result.anti_gap) result.anti_gap = {};
  result.anti_gap.phase = Math.max(Number(result.anti_gap.phase) || 1, 5);
  result.anti_gap.version = PHASE5_VERSION;
  result.anti_gap.features = [
    ...(result.anti_gap.features || []),
    "tool_calling",
    "agent_loop",
    "tool_registry"
  ];
  result.anti_gap.features = [...new Set(result.anti_gap.features)];
  result.anti_gap.p5_enabled = env.ANTI_GAP_P5 !== "false";
  return result;
}
