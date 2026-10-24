// ASTON OS — Phase H Truth Receipts
// Cryptographically signed immutable receipts for autonomous AI decisions
// (Blue Ocean IP pillar: Zero-Trust Immutable Lineage Protocol)

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": "10.1.0", ...headers }
  });

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(env) {
  const secret = env.ASTON_RECEIPT_SECRET || env.ASTON_JWT_SECRET || env.ASTON_API_TOKEN;
  if (!secret) return null;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalPayload(p) {
  // Stable subset for signing
  const o = {
    v: 1,
    tenant: p.tenant,
    kind: p.kind,
    subject_id: p.subject_id || null,
    actor: p.actor || null,
    decision: p.decision || null,
    summary: p.summary || null,
    input_hash: p.input_hash || null,
    output_hash: p.output_hash || null,
    ts: p.ts
  };
  return JSON.stringify(o);
}

export async function ensureReceiptsSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS truth_receipts (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_id TEXT,
      actor TEXT,
      decision TEXT,
      summary TEXT,
      input_hash TEXT,
      output_hash TEXT,
      payload_json TEXT NOT NULL,
      signature TEXT NOT NULL,
      alg TEXT NOT NULL,
      prev_receipt_id TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_receipts_tenant ON truth_receipts (tenant, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_receipts_subject ON truth_receipts (tenant, subject_id, created_at)")
  ]);
}

/**
 * Issue a Truth Receipt for an autonomous decision.
 * @returns {{ id, signature, alg, created_at } | null}
 */
export async function issueTruthReceipt(env, {
  tenant,
  kind,
  subject_id = null,
  actor = "system",
  decision = null,
  summary = null,
  input = null,
  output = null,
  chain = true
}) {
  if (!env.ASTON_DB) return null;
  const key = await hmacKey(env);
  if (!key) {
    console.warn("truth receipt: no signing secret (ASTON_RECEIPT_SECRET / ASTON_JWT_SECRET)");
    return null;
  }

  try {
    await ensureReceiptsSchema(env.ASTON_DB);
    const ts = new Date().toISOString();
    const id = `tr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const input_hash = input != null ? await sha256Hex(typeof input === "string" ? input : JSON.stringify(input)) : null;
    const output_hash = output != null ? await sha256Hex(typeof output === "string" ? output : JSON.stringify(output)) : null;

    let prev_receipt_id = null;
    if (chain) {
      const prev = await env.ASTON_DB.prepare(
        "SELECT id FROM truth_receipts WHERE tenant = ? ORDER BY created_at DESC LIMIT 1"
      ).bind(tenant).first();
      prev_receipt_id = prev?.id || null;
    }

    const body = {
      v: 1,
      tenant,
      kind: String(kind || "decision").slice(0, 80),
      subject_id: subject_id ? String(subject_id).slice(0, 120) : null,
      actor: String(actor || "system").slice(0, 120),
      decision: decision != null ? String(decision).slice(0, 2000) : null,
      summary: summary != null ? String(summary).slice(0, 1000) : null,
      input_hash,
      output_hash,
      prev_receipt_id,
      ts
    };

    const canon = canonicalPayload(body);
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canon));
    const signature = b64url(sigBuf);
    const alg = "HMAC-SHA256";

    await env.ASTON_DB.prepare(
      `INSERT INTO truth_receipts (
        id, tenant, kind, subject_id, actor, decision, summary,
        input_hash, output_hash, payload_json, signature, alg, prev_receipt_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, tenant, body.kind, body.subject_id, body.actor, body.decision, body.summary,
      input_hash, output_hash, canon, signature, alg, prev_receipt_id, ts
    ).run();

    return { id, signature, alg, created_at: ts, prev_receipt_id, input_hash, output_hash };
  } catch (e) {
    console.error("issueTruthReceipt", e?.message || e);
    return null;
  }
}

export async function verifyTruthReceipt(env, row) {
  const key = await hmacKey(env);
  if (!key || !row?.payload_json || !row?.signature) {
    return { valid: false, reason: "missing_key_or_row" };
  }
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(row.signature),
      new TextEncoder().encode(row.payload_json)
    );
    return { valid: ok, alg: row.alg || "HMAC-SHA256" };
  } catch (e) {
    return { valid: false, reason: String(e?.message || e).slice(0, 200) };
  }
}

export async function handleReceipts(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;

  try {
    await ensureReceiptsSchema(env.ASTON_DB);

    if (method === "GET" && (path === "/v1/receipts" || path === "/v1/receipts/status")) {
      const hasSecret = Boolean(env.ASTON_RECEIPT_SECRET || env.ASTON_JWT_SECRET || env.ASTON_API_TOKEN);
      return json({
        ok: true,
        phase: "H",
        version: "10.1.0",
        signing: hasSecret ? "HMAC-SHA256" : "unavailable",
        chain: true,
        note: "Truth Receipts for autonomous decisions — set ASTON_RECEIPT_SECRET for dedicated key"
      }, 200, cors);
    }

    if (method === "GET" && path === "/v1/receipts/list") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      const subject = url.searchParams.get("subject_id");
      let rows;
      if (subject) {
        rows = await env.ASTON_DB.prepare(
          "SELECT id, kind, subject_id, actor, summary, signature, alg, prev_receipt_id, created_at FROM truth_receipts WHERE tenant = ? AND subject_id = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(tenant, subject, limit).all();
      } else {
        rows = await env.ASTON_DB.prepare(
          "SELECT id, kind, subject_id, actor, summary, signature, alg, prev_receipt_id, created_at FROM truth_receipts WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(tenant, limit).all();
      }
      return json({ ok: true, receipts: rows.results || [] }, 200, cors);
    }

    if (method === "GET" && /^\/v1\/receipts\/[^/]+$/.test(path) && !path.endsWith("/status") && !path.endsWith("/list")) {
      const id = path.split("/").pop();
      if (id === "verify") return json({ ok: false, error: "use_post_verify" }, 400, cors);
      const row = await env.ASTON_DB.prepare(
        "SELECT * FROM truth_receipts WHERE tenant = ? AND id = ?"
      ).bind(tenant, id).first();
      if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
      const verification = await verifyTruthReceipt(env, row);
      return json({ ok: true, receipt: row, verification }, 200, cors);
    }

    if (method === "POST" && path === "/v1/receipts/verify") {
      let body;
      try { body = await request.json(); } catch { body = null; }
      const id = body?.id;
      if (!id) return json({ ok: false, error: "id_required" }, 400, cors);
      const row = await env.ASTON_DB.prepare(
        "SELECT * FROM truth_receipts WHERE tenant = ? AND id = ?"
      ).bind(tenant, id).first();
      if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
      const verification = await verifyTruthReceipt(env, row);
      return json({ ok: true, id, verification }, 200, cors);
    }

    if (method === "POST" && path === "/v1/receipts") {
      let body;
      try { body = await request.json(); } catch { body = null; }
      if (!body?.kind) return json({ ok: false, error: "kind_required" }, 400, cors);
      const receipt = await issueTruthReceipt(env, {
        tenant,
        kind: body.kind,
        subject_id: body.subject_id,
        actor: auth.actor || body.actor,
        decision: body.decision,
        summary: body.summary,
        input: body.input,
        output: body.output,
        chain: body.chain !== false
      });
      if (!receipt) return json({ ok: false, error: "sign_failed_or_no_secret" }, 503, cors);
      return json({ ok: true, receipt }, 201, cors);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("receipts handler", e?.message || e);
    return json({ ok: false, error: "receipts_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}
