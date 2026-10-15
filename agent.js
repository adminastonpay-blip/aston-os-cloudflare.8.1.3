// ASTON Agent Durable Object — tools + traces (v8.5.0)
const SECTORS = new Set(["primary", "industry", "infrastructure", "fintech", "govtech", "health", "mobility", "media"]);
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, sector TEXT NOT NULL, payload TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, account TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, balance_after_minor INTEGER NOT NULL, reference TEXT, idem_key TEXT, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, tenant TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT, model TEXT, r2_key TEXT, content_type TEXT, size_bytes INTEGER, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, payload TEXT, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
  ]);
}

async function embedTexts(env, texts) {
  if (!env.AI) throw new Error("AI binding required for embeddings");
  const input = Array.isArray(texts) ? texts : [texts];
  const result = await env.AI.run(EMBED_MODEL, { text: input });
  if (result?.data) return result.data;
  if (Array.isArray(result) && Array.isArray(result[0])) return result;
  throw new Error("Unexpected embedding response shape");
}

export class AstonAgent {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async toolStats(tenant) {
    if (!this.env.ASTON_DB) return { error: "d1_unavailable" };
    await ensureSchema(this.env.ASTON_DB);
    const records = await this.env.ASTON_DB.prepare("SELECT COUNT(*) AS count FROM records WHERE tenant = ?").bind(tenant).first();
    const ledger = await this.env.ASTON_DB.prepare("SELECT COUNT(*) AS count FROM ledger WHERE tenant = ?").bind(tenant).first();
    const media = await this.env.ASTON_DB.prepare("SELECT COUNT(*) AS count FROM media WHERE tenant = ?").bind(tenant).first().catch(() => ({ count: 0 }));
    const jobs = await this.env.ASTON_DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE tenant = ?").bind(tenant).first().catch(() => ({ count: 0 }));
    return { records: records?.count || 0, ledger_entries: ledger?.count || 0, media: media?.count || 0, jobs: jobs?.count || 0 };
  }

  async toolSearch(tenant, q, limit = 10) {
    if (!this.env.ASTON_DB) return { error: "d1_unavailable" };
    await ensureSchema(this.env.ASTON_DB);
    const result = await this.env.ASTON_DB.prepare(
      "SELECT id, sector, text, created_at FROM records WHERE tenant = ? AND text LIKE ? ORDER BY created_at DESC LIMIT ?"
    ).bind(tenant, `%${String(q).slice(0, 200)}%`, Math.min(20, limit)).all();
    return { mode: "keyword", results: result.results || [] };
  }

  async toolSemanticSearch(tenant, q, topK = 5) {
    if (!this.env.AI || !this.env.VECTORIZE) return { error: "semantic_unavailable", hint: "AI+VECTORIZE required" };
    const [vector] = await embedTexts(this.env, [String(q).slice(0, 2000)]);
    const matches = await this.env.VECTORIZE.query(vector, { topK: Math.min(10, topK), returnMetadata: true, filter: { tenant } });
    return { mode: "semantic", matches: matches?.matches || matches || [] };
  }

  async toolListRecords(tenant, sector, limit = 10) {
    if (!this.env.ASTON_DB) return { error: "d1_unavailable" };
    await ensureSchema(this.env.ASTON_DB);
    const sec = String(sector || "").toLowerCase();
    if (sec && SECTORS.has(sec)) {
      const result = await this.env.ASTON_DB.prepare(
        "SELECT id, sector, text, created_at FROM records WHERE tenant = ? AND sector = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(tenant, sec, Math.min(20, limit)).all();
      return { sector: sec, records: result.results || [] };
    }
    const result = await this.env.ASTON_DB.prepare(
      "SELECT id, sector, text, created_at FROM records WHERE tenant = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(tenant, Math.min(20, limit)).all();
    return { records: result.results || [] };
  }

  async toolLedgerSummary(tenant, account) {
    if (!this.env.ASTON_DB) return { error: "d1_unavailable" };
    await ensureSchema(this.env.ASTON_DB);
    if (account) {
      const rows = await this.env.ASTON_DB.prepare(
        "SELECT account, currency, balance_after_minor, created_at FROM ledger WHERE tenant = ? AND account = ? ORDER BY created_at DESC LIMIT 5"
      ).bind(tenant, String(account)).all();
      return { account, recent: rows.results || [] };
    }
    const rows = await this.env.ASTON_DB.prepare(
      "SELECT account, currency, balance_after_minor, created_at FROM ledger WHERE tenant = ? ORDER BY created_at DESC LIMIT 15"
    ).bind(tenant).all();
    return { recent: rows.results || [] };
  }

  pickTools(prompt) {
    const p = prompt.toLowerCase();
    const tools = [];
    if (/\b(stats|estadíst|conteo|cuántos|cuantos|count|resumen general)\b/.test(p)) tools.push({ name: "stats", args: {} });
    if (/\b(busca|buscar|search|encuentra|find)\b/.test(p)) {
      const q = prompt.replace(/.*\b(?:busca|buscar|search|encuentra|find)\b/i, "").trim() || prompt;
      tools.push({ name: "search", args: { q: q.slice(0, 200) } });
      tools.push({ name: "semantic_search", args: { q: q.slice(0, 200) } });
    }
    if (/\b(record|registros|sector|fintech|govtech|health|media|listar)\b/.test(p)) {
      let sector = null;
      for (const s of SECTORS) if (p.includes(s)) sector = s;
      tools.push({ name: "list_records", args: { sector, limit: 10 } });
    }
    if (/\b(ledger|saldo|balance|cuenta|account|finanza|movimiento)\b/.test(p)) {
      tools.push({ name: "ledger_summary", args: {} });
    }
    if (tools.length === 0) tools.push({ name: "stats", args: {} });
    return tools.slice(0, 4);
  }

  async runTool(name, args, tenant) {
    switch (name) {
      case "stats": return this.toolStats(tenant);
      case "search": return this.toolSearch(tenant, args.q || "", args.limit || 10);
      case "semantic_search": return this.toolSemanticSearch(tenant, args.q || "", args.top_k || 5);
      case "list_records": return this.toolListRecords(tenant, args.sector, args.limit || 10);
      case "ledger_summary": return this.toolLedgerSummary(tenant, args.account);
      default: return { error: "unknown_tool", name };
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path.endsWith("/memory")) {
      const memory = (await this.ctx.storage.get("memory")) || [];
      return json({ ok: true, memory });
    }

    if (request.method === "GET" && path.endsWith("/traces")) {
      const traces = (await this.ctx.storage.get("traces")) || [];
      return json({ ok: true, traces: traces.slice(-30) });
    }

    if (request.method === "POST") {
      const body = await readJson(request);
      const prompt = String(body?.prompt || "").trim();
      const tenant = String(body?.tenant || request.headers.get("x-aston-tenant") || "default");
      const actor = String(body?.actor || request.headers.get("x-aston-actor") || "agent");
      if (!prompt) return json({ ok: false, error: "prompt_required" }, 400);
      if (!this.env.AI) return json({ ok: false, error: "ai_unavailable" }, 503);

      const runId = crypto.randomUUID();
      const traces = [];
      const t0 = Date.now();

      const selected = Array.isArray(body?.tools) && body.tools.length
        ? body.tools.slice(0, 4)
        : this.pickTools(prompt);

      const toolResults = [];
      for (const t of selected) {
        const name = t.name || t;
        const args = t.args || {};
        const start = Date.now();
        let result;
        try { result = await this.runTool(name, args, tenant); }
        catch (e) { result = { error: String(e?.message || e).slice(0, 300) }; }
        traces.push({
          run_id: runId, step: traces.length + 1, type: "tool", name, args,
          ok: !result?.error, ms: Date.now() - start,
          output_preview: JSON.stringify(result).slice(0, 500)
        });
        toolResults.push({ name, result });
      }

      const memory = (await this.ctx.storage.get("memory")) || [];
      const toolContext = toolResults.map(t => `Tool ${t.name}: ${JSON.stringify(t.result).slice(0, 1200)}`).join("\n");
      const messages = [
        { role: "system", content: "You are ASTON OS agent. Use the tool results to answer accurately. Be concise. If data is missing, say so. Reply in the same language as the user." },
        ...memory.slice(-4),
        { role: "user", content: `User question: ${prompt}\n\nTool results:\n${toolContext || "(none)"}` }
      ];

      const model = this.env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
      let finalText = "";
      const llmStart = Date.now();
      try {
        const response = await this.env.AI.run(model, { messages });
        finalText = typeof response === "string" ? response : (response?.response || JSON.stringify(response));
        traces.push({ run_id: runId, step: traces.length + 1, type: "llm", name: model, ms: Date.now() - llmStart, output_preview: String(finalText).slice(0, 500) });
      } catch (e) {
        finalText = "No pude completar la respuesta del modelo. Resultados de tools disponibles en traces.";
        traces.push({ run_id: runId, step: traces.length + 1, type: "llm_error", name: model, ms: Date.now() - llmStart, error: String(e?.message || e).slice(0, 300) });
      }

      memory.push({ role: "user", content: prompt.slice(0, 2000) });
      memory.push({ role: "assistant", content: String(finalText).slice(0, 2000) });
      await this.ctx.storage.put("memory", memory.slice(-20));

      const prevTraces = (await this.ctx.storage.get("traces")) || [];
      prevTraces.push({ run_id: runId, ts: new Date().toISOString(), prompt: prompt.slice(0, 300), total_ms: Date.now() - t0, steps: traces });
      await this.ctx.storage.put("traces", prevTraces.slice(-30));

      if (this.env.ASTON_DB) {
        try {
          await ensureSchema(this.env.ASTON_DB);
          await this.env.ASTON_DB.prepare(
            "INSERT INTO audit_log (ts, tenant, actor, action, detail) VALUES (?, ?, ?, ?, ?)"
          ).bind(new Date().toISOString(), tenant, actor, "agent.run",
            JSON.stringify({ run_id: runId, tools: selected.map(t => t.name || t), ms: Date.now() - t0, steps: traces.length }).slice(0, 2000)
          ).run();
        } catch (e) { console.error("agent audit failed", e?.message || e); }
      }

      return json({
        ok: true, plugin: "agent", run_id: runId, model,
        tools_used: selected.map(t => t.name || t), traces, result: finalText, total_ms: Date.now() - t0
      });
    }

    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
}
