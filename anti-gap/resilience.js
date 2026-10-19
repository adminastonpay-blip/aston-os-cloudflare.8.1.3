/**
 * ASTON OS Anti-Gap Phase 1 — Resilience helpers
 * Additive only. Never throws to callers; fail-open by design.
 */

const BREAKER_PREFIX = "aston:breaker:";
const BREAKER_TTL = 60;

export async function getBreakerState(env, name) {
  if (!env?.ASTON_KV) return "closed";
  try {
    const raw = await env.ASTON_KV.get(BREAKER_PREFIX + name);
    if (!raw) return "closed";
    const data = JSON.parse(raw);
    if (data.state === "open" && data.until && Date.now() < data.until) return "open";
    if (data.state === "open") return "half";
    return data.state || "closed";
  } catch {
    return "closed";
  }
}

export async function reportBreaker(env, name, ok) {
  if (!env?.ASTON_KV) return;
  try {
    const key = BREAKER_PREFIX + name;
    if (ok) {
      await env.ASTON_KV.put(key, JSON.stringify({ state: "closed", at: Date.now() }), {
        expirationTtl: 3600
      });
      return;
    }
    const failsKey = BREAKER_PREFIX + name + ":fails";
    const fails = Number((await env.ASTON_KV.get(failsKey)) || 0) + 1;
    await env.ASTON_KV.put(failsKey, String(fails), { expirationTtl: 120 });
    if (fails >= 3) {
      await env.ASTON_KV.put(
        key,
        JSON.stringify({ state: "open", until: Date.now() + BREAKER_TTL * 1000, fails }),
        { expirationTtl: BREAKER_TTL + 30 }
      );
    }
  } catch {
    /* ignore */
  }
}

export async function probeBindings(env) {
  const out = {
    worker: true,
    d1_primary: false,
    d1_backup: false,
    kv: false,
    r2: false,
    ai: Boolean(env?.AI),
    vectorize: Boolean(env?.VECTORIZE),
    queue: Boolean(env?.ASTON_QUEUE),
    session_do: Boolean(env?.ASTON_SESSION),
    rate_limiter_do: Boolean(env?.ASTON_RATE_LIMITER),
    ledger_lock_do: Boolean(env?.ASTON_LEDGER_LOCK),
    agent_do: Boolean(env?.ASTON_AGENT),
    breakers: {}
  };

  if (env?.ASTON_DB) {
    try {
      await env.ASTON_DB.prepare("SELECT 1 AS ok").first();
      out.d1_primary = true;
      await reportBreaker(env, "d1", true);
    } catch (e) {
      out.d1_primary_error = String(e?.message || e).slice(0, 200);
      await reportBreaker(env, "d1", false);
    }
  }

  if (env?.ASTON_DB_BACKUP) {
    try {
      await env.ASTON_DB_BACKUP.prepare("SELECT 1 AS ok").first();
      out.d1_backup = true;
    } catch (e) {
      out.d1_backup_error = String(e?.message || e).slice(0, 200);
    }
  }

  if (env?.ASTON_KV) {
    try {
      const k = "aston:health-ping";
      await env.ASTON_KV.put(k, String(Date.now()), { expirationTtl: 60 });
      out.kv = Boolean(await env.ASTON_KV.get(k));
      await reportBreaker(env, "kv", out.kv);
    } catch (e) {
      out.kv_error = String(e?.message || e).slice(0, 200);
      await reportBreaker(env, "kv", false);
    }
  }

  if (env?.ASTON_R2) {
    try {
      await env.ASTON_R2.list({ limit: 1 });
      out.r2 = true;
      await reportBreaker(env, "r2", true);
    } catch (e) {
      out.r2_error = String(e?.message || e).slice(0, 200);
      await reportBreaker(env, "r2", false);
    }
  }

  for (const name of ["ai", "d1", "kv", "r2", "vectorize"]) {
    out.breakers[name] = await getBreakerState(env, name);
  }

  out.degraded = !(out.d1_primary || out.d1_backup) || out.breakers.d1 === "open";
  out.operational = out.worker && (out.d1_primary || out.d1_backup || !env?.ASTON_DB);
  return out;
}

export function pickDb(env) {
  if (env?.ASTON_DB) return { db: env.ASTON_DB, name: "primary" };
  if (env?.ASTON_DB_BACKUP) return { db: env.ASTON_DB_BACKUP, name: "backup" };
  return null;
}

export async function withDbFailover(env, fn) {
  const errors = [];
  for (const [name, db] of [
    ["primary", env?.ASTON_DB],
    ["backup", env?.ASTON_DB_BACKUP]
  ]) {
    if (!db) continue;
    try {
      const result = await fn(db, name);
      await reportBreaker(env, "d1", true);
      return { ok: true, name, result };
    } catch (e) {
      errors.push({ name, error: String(e?.message || e).slice(0, 200) });
    }
  }
  if (errors.length) await reportBreaker(env, "d1", false);
  return { ok: false, errors };
}
