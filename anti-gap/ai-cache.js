/**
 * Anti-Gap Phase 2 — KV response cache for AI chat
 */

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function chatCacheKey(tenant, prompt, modelHint) {
  const base = `${tenant}|${modelHint || "*"}|${String(prompt).slice(0, 4000)}`;
  const h = await sha256Hex(base);
  return `aston:aicache:chat:${h}`;
}

export async function getCachedChat(env, key) {
  if (!env?.ASTON_KV) return null;
  try {
    const raw = await env.ASTON_KV.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setCachedChat(env, key, payload, ttlSec = 300) {
  if (!env?.ASTON_KV) return false;
  const ttl = Math.min(3600, Math.max(30, Number(ttlSec) || 300));
  try {
    await env.ASTON_KV.put(
      key,
      JSON.stringify({
        ...payload,
        cached_at: new Date().toISOString()
      }),
      { expirationTtl: ttl }
    );
    return true;
  } catch {
    return false;
  }
}
