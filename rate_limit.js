// ASTON OS — Phase 6 tenant rate limiting
// Uses KV when available; otherwise Durable Object ASTON_RATE_LIMITER; else soft pass-through

const DEFAULT_LIMIT = 120; // req / minute / tenant

function windowKey(tenant) {
  const minute = Math.floor(Date.now() / 60000);
  return `rl:${tenant || "default"}:${minute}`;
}

export async function checkTenantRateLimit(request, env, tenant) {
  const limit = Number(env.RATE_LIMIT_PER_MINUTE || DEFAULT_LIMIT);
  const t = tenant || request.headers.get("X-Tenant") || "default";

  // 1) KV
  if (env.ASTON_KV) {
    try {
      const key = windowKey(t);
      const raw = await env.ASTON_KV.get(key);
      const count = raw ? Number(raw) : 0;
      if (count >= limit) {
        return {
          allowed: false,
          limit,
          remaining: 0,
          retry_after: 60,
          tenant: t
        };
      }
      await env.ASTON_KV.put(key, String(count + 1), { expirationTtl: 120 });
      return { allowed: true, limit, remaining: Math.max(0, limit - count - 1), tenant: t };
    } catch (e) {
      console.error("rate_limit kv", e?.message || e);
    }
  }

  // 2) Durable Object
  if (env.ASTON_RATE_LIMITER) {
    try {
      const id = env.ASTON_RATE_LIMITER.idFromName(`tenant:${t}`);
      const stub = env.ASTON_RATE_LIMITER.get(id);
      const res = await stub.fetch(new Request("https://rl.internal/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit })
      }));
      const data = await res.json().catch(() => null);
      if (res.status === 429) {
        return { allowed: false, limit, remaining: 0, retry_after: 60, tenant: t, via: "do" };
      }
      return {
        allowed: true,
        limit,
        remaining: data?.remaining ?? null,
        tenant: t,
        via: "do"
      };
    } catch (e) {
      console.error("rate_limit do", e?.message || e);
    }
  }

  // 3) No binding — allow (dev)
  return { allowed: true, limit, remaining: null, tenant: t, via: "passthrough" };
}

export function rateLimitResponse(info, cors = {}, json) {
  return json(
    {
      ok: false,
      error: "rate_limited",
      tenant: info.tenant,
      limit: info.limit,
      retry_after: info.retry_after || 60
    },
    429,
    {
      ...cors,
      "retry-after": String(info.retry_after || 60),
      "x-ratelimit-limit": String(info.limit),
      "x-ratelimit-remaining": "0"
    }
  );
}

export async function handleRateLimitStatus(request, env, auth, cors, json) {
  const t = auth?.tenant || request.headers.get("X-Tenant") || "default";
  const limit = Number(env.RATE_LIMIT_PER_MINUTE || DEFAULT_LIMIT);
  let used = null;
  if (env.ASTON_KV) {
    try {
      const raw = await env.ASTON_KV.get(windowKey(t));
      used = raw ? Number(raw) : 0;
    } catch (_) {}
  }
  return json({
    ok: true,
    phase: "6-ops",
    tenant: t,
    limit_per_minute: limit,
    used_this_minute: used,
    remaining: used == null ? null : Math.max(0, limit - used),
    bindings: {
      kv: Boolean(env.ASTON_KV),
      durable_object: Boolean(env.ASTON_RATE_LIMITER)
    }
  }, 200, cors);
}
