// ASTON OS — Phase K PoV / Demo Kit
// One-click seed + capabilities manifest for executive demos

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-aston-os": "10.4.0", ...headers }
  });

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

const CAPABILITIES = {
  version: "10.4.0",
  phases: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"],
  modules: [
    "ontology", "orchestrator", "cases", "governance", "fusion",
    "foundry", "receipts", "metrics", "ui", "pov"
  ],
  differentiators: [
    "edge_native_multi_tenant",
    "ontology_plus_cases",
    "voice_realtime_tools",
    "truth_receipts_hmac",
    "sub_100ms_edge_core_benchmark"
  ],
  not_claims: [
    "not_full_palantir_foundry_parity",
    "llm_orchestrator_not_sub_100ms_e2e",
    "ui_is_operational_console_not_workshop"
  ]
};

export async function handlePov(request, env, auth, cors = {}) {
  if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const tenant = auth.tenant;
  const actor = auth.actor || "pov";
  const db = env.ASTON_DB;
  const now = new Date().toISOString();

  try {
    if (method === "GET" && (path === "/v1/pov" || path === "/v1/pov/status" || path === "/v1/capabilities")) {
      return json({ ok: true, phase: "K", ...CAPABILITIES, tenant }, 200, cors);
    }

    // Graph snapshot for UI
    if (method === "GET" && path === "/v1/pov/graph") {
      const limit = Math.min(80, Math.max(5, Number(url.searchParams.get("limit") || 40)));
      const entities = await db.prepare(
        "SELECT id, type, name FROM ontology_entities WHERE tenant = ? ORDER BY updated_at DESC LIMIT ?"
      ).bind(tenant, limit).all();
      const ids = (entities.results || []).map((e) => e.id);
      let relations = { results: [] };
      if (ids.length) {
        // Fetch relations involving these nodes (simple approach)
        relations = await db.prepare(
          "SELECT id, rel_type, from_id, to_id FROM ontology_relations WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(tenant, limit * 2).all();
      }
      return json({
        ok: true,
        nodes: (entities.results || []).map((e) => ({ id: e.id, label: e.name, type: e.type })),
        edges: (relations.results || [])
          .filter((r) => ids.includes(r.from_id) || ids.includes(r.to_id))
          .map((r) => ({ id: r.id, from: r.from_id, to: r.to_id, rel: r.rel_type }))
      }, 200, cors);
    }

    // Seed demo ontology + case + lineage
    if (method === "POST" && path === "/v1/pov/seed") {
      const orgId = id("ent");
      const supId = id("ent");
      const prodId = id("ent");
      const orderId = id("ent");
      const rel1 = id("rel");
      const rel2 = id("rel");
      const rel3 = id("rel");
      const caseId = id("case");

      await db.batch([
        db.prepare(
          `INSERT OR REPLACE INTO ontology_entities (id, tenant, type, name, props, source, created_at, updated_at)
           VALUES (?, ?, 'organization', ?, ?, 'pov_seed', ?, ?)`
        ).bind(orgId, tenant, "ASTON Demo Retail", JSON.stringify({ domain: "demo.aston", country: "AR" }), now, now),
        db.prepare(
          `INSERT OR REPLACE INTO ontology_entities (id, tenant, type, name, props, source, created_at, updated_at)
           VALUES (?, ?, 'supplier', ?, ?, 'pov_seed', ?, ?)`
        ).bind(supId, tenant, "Andes Supply Co", JSON.stringify({ country: "CL", risk_score: 0.32 }), now, now),
        db.prepare(
          `INSERT OR REPLACE INTO ontology_entities (id, tenant, type, name, props, source, created_at, updated_at)
           VALUES (?, ?, 'product', ?, ?, 'pov_seed', ?, ?)`
        ).bind(prodId, tenant, "Edge Kit Pro", JSON.stringify({ sku: "EK-PRO-1", price: 129 }), now, now),
        db.prepare(
          `INSERT OR REPLACE INTO ontology_entities (id, tenant, type, name, props, source, created_at, updated_at)
           VALUES (?, ?, 'order', ?, ?, 'pov_seed', ?, ?)`
        ).bind(orderId, tenant, "Order #POV-1001", JSON.stringify({ total: 258, currency: "USD", status: "open" }), now, now),
        db.prepare(
          `INSERT OR REPLACE INTO ontology_relations (id, tenant, rel_type, from_id, to_id, props, created_at)
           VALUES (?, ?, 'supplies', ?, ?, '{}', ?)`
        ).bind(rel1, tenant, supId, orgId, now),
        db.prepare(
          `INSERT OR REPLACE INTO ontology_relations (id, tenant, rel_type, from_id, to_id, props, created_at)
           VALUES (?, ?, 'owns', ?, ?, '{}', ?)`
        ).bind(rel2, tenant, orgId, prodId, now),
        db.prepare(
          `INSERT OR REPLACE INTO ontology_relations (id, tenant, rel_type, from_id, to_id, props, created_at)
           VALUES (?, ?, 'contains', ?, ?, '{}', ?)`
        ).bind(rel3, tenant, orderId, prodId, now)
      ]);

      try {
        await db.prepare(
          `INSERT OR REPLACE INTO cases (id, tenant, title, playbook, status, priority, assignee, ontology_ids, payload, result, orchestrator_run_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'ontology_alert', 'open', 'high', ?, ?, ?, NULL, NULL, ?, ?, ?)`
        ).bind(
          caseId, tenant,
          "PoV: Review supplier risk for Edge Kit Pro",
          actor,
          JSON.stringify([orgId, supId, prodId, orderId]),
          JSON.stringify({ seeded: true, phase: "K" }),
          actor, now, now
        ).run();
      } catch (e) {
        console.error("pov seed case", e?.message || e);
      }

      try {
        await db.prepare(
          `INSERT INTO lineage (id, tenant, entity_id, entity_kind, source_kind, source_id, transform, meta, actor, created_at)
           VALUES (?, ?, ?, 'entity', 'pov_seed', ?, 'seed', ?, ?, ?)`
        ).bind(id("lin"), tenant, orgId, "phase_k", JSON.stringify({ demo: true }), actor, now).run();
      } catch (_) {}

      let receipt = null;
      try {
        const { issueTruthReceipt } = await import("./receipts.js");
        receipt = await issueTruthReceipt(env, {
          tenant,
          kind: "pov.seed",
          subject_id: caseId,
          actor,
          decision: "Demo ontology + case seeded",
          summary: "Phase K PoV seed",
          input: { orgId, supId, prodId, orderId },
          output: { caseId }
        });
      } catch (_) {}

      return json({
        ok: true,
        phase: "K",
        seeded: {
          entities: { organization: orgId, supplier: supId, product: prodId, order: orderId },
          relations: [rel1, rel2, rel3],
          case_id: caseId,
          truth_receipt: receipt
        },
        next: [
          "GET /v1/pov/graph",
          "GET /v1/search?q=Edge",
          "POST /v1/orchestrator/run with goal about supplier risk",
          "Open /ui"
        ]
      }, 201, cors);
    }

    // One-shot demo run: seed (if empty) + optional orchestrator goal
    if (method === "POST" && path === "/v1/pov/demo") {
      const body = await request.json().catch(() => ({}));
      const count = await db.prepare(
        "SELECT COUNT(*) AS c FROM ontology_entities WHERE tenant = ?"
      ).bind(tenant).first();
      let seed = null;
      if (!count?.c || body.force_seed) {
        const fake = new Request("https://pov.internal/v1/pov/seed", {
          method: "POST",
          headers: { "content-type": "application/json" }
        });
        const res = await handlePov(fake, env, auth, {});
        seed = await res.json().catch(() => null);
      }
      let orch = null;
      if (body.run_orchestrator !== false && env.AI) {
        const { handleOrchestrator } = await import("./orchestrator.js");
        const goal = body.goal ||
          "Assess supplier risk for Edge Kit Pro and recommend next operational actions for the open PoV case.";
        const fake = new Request("https://pov.internal/v1/orchestrator/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal, max_roles: 2, store_artifact: false })
        });
        const res = await handleOrchestrator(fake, env, auth, {});
        orch = await res.json().catch(() => null);
      }
      return json({
        ok: true,
        phase: "K",
        seed,
        orchestrator: orch,
        ui: "/ui"
      }, 200, cors);
    }

    return json({ ok: false, error: "not_found", path }, 404, cors);
  } catch (e) {
    console.error("pov handler", e?.message || e);
    return json({ ok: false, error: "pov_failed", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
  }
}
