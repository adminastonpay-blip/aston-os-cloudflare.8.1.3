// ASTON OS 11 — Cryptographic Autonomous Governance & Execution
// Policy rules → HMAC receipt → auto-revert / allow at the edge

const VERSION = "11.0.0";

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

function slugId(p) {
  return `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function hmacSign(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret || "aston-gov"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ensureGovSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS auto_policies (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL,
      rule_json TEXT NOT NULL, action TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_auto_pol ON auto_policies (tenant, active)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS auto_executions (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, policy_id TEXT, decision TEXT NOT NULL,
      payload TEXT NOT NULL, signature TEXT NOT NULL, reverted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`)
  ]);
}

export function evaluatePolicies(policies, payload) {
  const hits = [];
  for (const pol of policies) {
    let rule = {};
    try { rule = typeof pol.rule_json === "string" ? JSON.parse(pol.rule_json) : pol.rule || pol.rule_json; } catch { continue; }
    let match = true;
    const hasCond = rule.max_amount != null || rule.min_risk != null || rule.field;
    if (!hasCond) continue;
    if (rule.max_amount != null && !(Number(payload.amount) > Number(rule.max_amount))) match = false;
    if (rule.min_risk != null && !(Number(payload.risk) >= Number(rule.min_risk))) match = false;
    if (rule.field && rule.equals != null && payload[rule.field] !== rule.equals) match = false;
    if (rule.field && rule.contains != null && !String(payload[rule.field] || "").includes(String(rule.contains))) match = false;
    if (match) {
      hits.push({ policy_id: pol.id, name: pol.name, action: pol.action || rule.action || "block", rule });
    }
  }
  return hits;
}

export async function handleAutoGov(request, env, path, method, cors = {}) {
  if (method === "GET" && path === "/v1/gov/status") {
    return json({
      ok: true, phase: "11-auto-gov", version: VERSION,
      endpoints: {
        status: "GET /v1/gov/status", policies: "GET|POST /v1/gov/policies",
        execute: "POST /v1/gov/execute", executions: "GET /v1/gov/executions"
      }
    }, 200, cors);
  }

  const token = bearer(request);
  if (!token) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const tenant = request.headers.get("X-Tenant") || "default";
  const actor = request.headers.get("X-Aston-Actor") || "api";

  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  await ensureGovSchema(env.ASTON_DB);
  const db = env.ASTON_DB;

  if (method === "GET" && path === "/v1/gov/policies") {
    const rows = await db.prepare(
      "SELECT id, name, rule_json, action, active, created_at FROM auto_policies WHERE tenant = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(tenant).all();
    return json({ ok: true, policies: rows.results || [] }, 200, cors);
  }

  if (method === "POST" && path === "/v1/gov/policies") {
    const body = await readJson(request);
    const name = String(body?.name || "policy").slice(0, 120);
    const rule = body?.rule || {};
    const action = String(body?.action || rule.action || "block").slice(0, 40);
    const id = slugId("apol");
    const now = new Date().toISOString();
    await db.prepare(
      "INSERT INTO auto_policies (id, tenant, name, rule_json, action, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)"
    ).bind(id, tenant, name, JSON.stringify(rule), action, now).run();
    return json({ ok: true, id, name, action, rule }, 201, cors);
  }

  if (method === "POST" && path === "/v1/gov/execute") {
    const body = await readJson(request);
    const payload = body?.payload || body || {};
    const rows = await db.prepare(
      "SELECT id, name, rule_json, action FROM auto_policies WHERE tenant = ? AND active = 1"
    ).bind(tenant).all();
    const hits = evaluatePolicies(rows.results || [], payload);

    let decision = "allow";
    let reverted = false;
    if (hits.some((h) => h.action === "block" || h.action === "revert")) {
      decision = hits.find((h) => h.action === "block" || h.action === "revert")?.action || "block";
      reverted = true;
    } else if (hits.some((h) => h.action === "challenge")) {
      decision = "challenge";
    }

    const now = new Date().toISOString();
    const record = { tenant, actor, decision, hits, payload, at: now };
    const payloadStr = JSON.stringify(record);
    const signature = await hmacSign(env.ASTON_RECEIPT_SECRET || env.ASTON_API_TOKEN, payloadStr);
    const id = slugId("aexec");
    await db.prepare(
      "INSERT INTO auto_executions (id, tenant, policy_id, decision, payload, signature, reverted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, tenant, hits[0]?.policy_id || null, decision, payloadStr, signature, reverted ? 1 : 0, now).run();

    return json({
      ok: true, execution_id: id, decision, reverted, hits,
      signature: signature.slice(0, 24) + "…",
      note: reverted
        ? "Action blocked/reverted at edge — cryptographic receipt stored"
        : "Allowed with immutable receipt"
    }, decision === "allow" ? 200 : 403, cors);
  }

  if (method === "GET" && path === "/v1/gov/executions") {
    const limit = Math.min(50, Number(new URL(request.url).searchParams.get("limit") || 20));
    const rows = await db.prepare(
      "SELECT id, policy_id, decision, reverted, signature, created_at FROM auto_executions WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(tenant, limit).all();
    return json({ ok: true, executions: rows.results || [] }, 200, cors);
  }

  return json({ ok: false, error: "not_found", path }, 404, cors);
}
