// ASTON OS — Creator seal + integrity + remote kill-switch
// Practical protection: secrets + optional remote lock + license binding.
// Not unbreakable DRM: a determined fork can strip checks if they own the source.
// Goal: clones without YOUR keys/license fail closed; you can lock live deploys.

const VERSION = "11.2.0";
const SEAL_PREFIX = "ASTON_SOVEREIGN";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": VERSION, ...headers }
  });

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeCreatorSeal(env) {
  const master = env.SOVEREIGN_MASTER_KEY || env.ASTON_RECEIPT_SECRET || env.ASTON_API_TOKEN || "";
  if (!master) return { ok: false, seal: null, reason: "missing_sovereign_secret" };
  const root = env.SOVEREIGN_CREATOR_HASH || "ASTON_OS_CREATOR_ROOT";
  const digest = await sha256Hex(`${root}|${master}|${VERSION}`);
  const seal = `${SEAL_PREFIX}_${digest.slice(0, 24)}`;
  return { ok: true, seal, fingerprint: digest.slice(0, 16) };
}

export async function isKillSwitchActive(env) {
  if (String(env.SOVEREIGN_KILL_SWITCH || "").toUpperCase() === "ENABLED") return true;
  if (env.ASTON_KV) {
    try {
      const v = await env.ASTON_KV.get("aston:sovereign:kill");
      if (v === "1" || String(v || "").toUpperCase() === "ENABLED") return true;
    } catch (_) {}
  }
  return false;
}

export function masterKeyOk(request, env) {
  const provided = request.headers.get("X-Sovereign-Master-Key") || request.headers.get("x-sovereign-master-key") || "";
  const master = env.SOVEREIGN_MASTER_KEY || "";
  if (!master) return false;
  return provided === master;
}

export async function verifyLicenseHeader(request, env, tenant) {
  const lic = request.headers.get("X-Sovereign-License") || "";
  if (!lic) {
    if (String(env.SOVEREIGN_REQUIRE_LICENSE || "") === "1") {
      return { ok: false, reason: "license_required" };
    }
    return { ok: true, mode: "open" };
  }
  const master = env.SOVEREIGN_MASTER_KEY || env.ASTON_RECEIPT_SECRET || "";
  if (!master) return { ok: false, reason: "no_master_to_verify_license" };
  const deployId = env.SOVEREIGN_DEPLOY_ID || "default";
  const expected = await hmacHex(master, `${tenant}|${deployId}|ASTON_LICENSE`);
  if (lic === expected || lic === expected.slice(0, 32)) return { ok: true, mode: "licensed" };
  return { ok: false, reason: "license_mismatch" };
}

export function lockoutResponse(code, message, seal, cors = {}) {
  return json({
    ok: false,
    error: "SOVEREIGN_LOCK",
    code,
    message,
    action: "Contact the creator. Provide X-Sovereign-Master-Key only if authorized to unlock.",
    creator_seal: seal || null,
    timestamp: new Date().toISOString()
  }, 403, cors);
}

export async function sovereignGate(request, env, path, cors = {}) {
  if (path === "/health" || path === "/" || path.startsWith("/v1/sovereign")) return null;

  const sealInfo = await computeCreatorSeal(env);
  if (!sealInfo.ok) {
    if (String(env.SOVEREIGN_FAIL_CLOSED || "1") === "1") {
      return lockoutResponse(
        "UNSEALED",
        "Creator seal unavailable: set SOVEREIGN_MASTER_KEY (or ASTON_RECEIPT_SECRET) as a Worker secret.",
        null,
        cors
      );
    }
  }

  if (await isKillSwitchActive(env)) {
    if (!masterKeyOk(request, env)) {
      return lockoutResponse("KILL_SWITCH", "Remote kill-switch active. System locked by creator.", sealInfo.seal, cors);
    }
  }

  const tenant = request.headers.get("X-Tenant") || "default";
  const lic = await verifyLicenseHeader(request, env, tenant);
  if (!lic.ok) {
    return lockoutResponse("LICENSE", `License check failed: ${lic.reason}`, sealInfo.seal, cors);
  }

  if (sealInfo.seal && !sealInfo.seal.startsWith(SEAL_PREFIX)) {
    return lockoutResponse("TAMPER_SEAL", "Creator seal format invalid.", sealInfo.seal, cors);
  }

  return null;
}

export async function handleSovereign(request, env, path, method, cors = {}) {
  if (method === "GET" && path === "/v1/sovereign/status") {
    const sealInfo = await computeCreatorSeal(env);
    const kill = await isKillSwitchActive(env);
    return json({
      ok: true,
      version: VERSION,
      sealed: sealInfo.ok,
      fingerprint: sealInfo.fingerprint || null,
      seal_prefix: SEAL_PREFIX,
      kill_switch: kill,
      require_license: String(env.SOVEREIGN_REQUIRE_LICENSE || "") === "1",
      fail_closed: String(env.SOVEREIGN_FAIL_CLOSED || "1") === "1",
      note: "Clones without Worker secrets fail closed. Kill-switch via KV aston:sovereign:kill or env SOVEREIGN_KILL_SWITCH."
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/sovereign/license/issue") {
    if (!masterKeyOk(request, env)) {
      return lockoutResponse("FORBIDDEN", "Master key required to issue licenses.", null, cors);
    }
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const tenant = String(body.tenant || request.headers.get("X-Tenant") || "default");
    const master = env.SOVEREIGN_MASTER_KEY || env.ASTON_RECEIPT_SECRET || "";
    const deployId = env.SOVEREIGN_DEPLOY_ID || "default";
    const token = await hmacHex(master, `${tenant}|${deployId}|ASTON_LICENSE`);
    return json({
      ok: true,
      tenant,
      deploy_id: deployId,
      license: token.slice(0, 32),
      header: "X-Sovereign-License",
      usage: "Send header X-Sovereign-License when SOVEREIGN_REQUIRE_LICENSE=1"
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/sovereign/kill") {
    if (!masterKeyOk(request, env)) {
      return lockoutResponse("FORBIDDEN", "Master key required.", null, cors);
    }
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const enable = body.enable === true || body.active === true;
    if (env.ASTON_KV) {
      if (enable) await env.ASTON_KV.put("aston:sovereign:kill", "ENABLED");
      else await env.ASTON_KV.delete("aston:sovereign:kill");
    }
    return json({
      ok: true,
      kill_switch: enable,
      storage: env.ASTON_KV ? "kv" : "env_only",
      hint: enable
        ? "All routes locked until X-Sovereign-Master-Key is sent or kill is cleared"
        : "Kill switch cleared in KV"
    }, 200, cors);
  }

  if (method === "GET" && path === "/v1/sovereign/seal") {
    const sealInfo = await computeCreatorSeal(env);
    return json({
      ok: sealInfo.ok,
      fingerprint: sealInfo.fingerprint,
      seal: masterKeyOk(request, env) ? sealInfo.seal : undefined,
      message: sealInfo.ok ? "Creator seal present on this deployment" : "No sovereign secret configured"
    }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
