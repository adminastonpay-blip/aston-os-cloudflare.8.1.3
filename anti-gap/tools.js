/**
 * Anti-Gap Phase 5/6 — built-in + tenant-registered tools
 */

const TOOLS_PREFIX = "aston:tools:";

export const BUILTIN_TOOLS = {
  echo: {
    name: "echo",
    description: "Return the same text. Use for tests.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    }
  },
  http_get: {
    name: "http_get",
    description: "GET a public HTTPS URL (allowlisted hosts only).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_bytes: { type: "number" }
      },
      required: ["url"]
    }
  },
  kv_get: {
    name: "kv_get",
    description: "Read a tenant-scoped KV key.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"]
    }
  },
  kv_put: {
    name: "kv_put",
    description: "Write a tenant-scoped KV key (max 8KB).",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
        ttl_sec: { type: "number" }
      },
      required: ["key", "value"]
    }
  },
  roi_summary: {
    name: "roi_summary",
    description: "Get ROI cost summary for the current tenant.",
    parameters: {
      type: "object",
      properties: { days: { type: "number" } }
    }
  },
  now_iso: {
    name: "now_iso",
    description: "Return current UTC ISO timestamp.",
    parameters: { type: "object", properties: {} }
  },
  knowledge_search: {
    name: "knowledge_search",
    description: "Search the tenant knowledge base (RAG). Returns top matching text chunks.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "number" }
      },
      required: ["query"]
    }
  }
};

const DEFAULT_ALLOW_HOSTS = [
  "api.github.com",
  "httpbin.org",
  "cloudflare.com",
  "workers.dev"
];

function tenantKvKey(tenant, key) {
  const k = String(key || "")
    .replace(/[^a-zA-Z0-9._:/-]/g, "")
    .slice(0, 120);
  return `aston:t:${tenant}:${k}`;
}

export async function loadToolRegistry(env, tenant) {
  const builtins = Object.values(BUILTIN_TOOLS);
  if (!env?.ASTON_KV) {
    return { tools: builtins, allow_hosts: DEFAULT_ALLOW_HOSTS, custom: [] };
  }
  try {
    const raw = await env.ASTON_KV.get(`${TOOLS_PREFIX}${tenant}`);
    if (!raw) return { tools: builtins, allow_hosts: DEFAULT_ALLOW_HOSTS, custom: [] };
    const p = JSON.parse(raw);
    const custom = Array.isArray(p.custom) ? p.custom.slice(0, 20) : [];
    const allow_hosts = Array.isArray(p.allow_hosts)
      ? p.allow_hosts.map(String).slice(0, 30)
      : DEFAULT_ALLOW_HOSTS;
    const tools = [
      ...builtins,
      ...custom.filter((t) => t?.name && t?.description).map((t) => ({
        name: String(t.name).slice(0, 64),
        description: String(t.description).slice(0, 400),
        parameters: t.parameters || { type: "object", properties: {} },
        custom: true
      }))
    ];
    return { tools, allow_hosts, custom };
  } catch {
    return { tools: builtins, allow_hosts: DEFAULT_ALLOW_HOSTS, custom: [] };
  }
}

export async function saveToolRegistry(env, tenant, body) {
  if (!env?.ASTON_KV) return { ok: false, error: "kv_missing" };
  const custom = Array.isArray(body.custom)
    ? body.custom
        .filter((t) => t?.name)
        .map((t) => ({
          name: String(t.name).slice(0, 64),
          description: String(t.description || "").slice(0, 400),
          parameters: t.parameters || { type: "object", properties: {} }
        }))
        .slice(0, 20)
    : [];
  const allow_hosts = Array.isArray(body.allow_hosts)
    ? body.allow_hosts.map((h) => String(h).toLowerCase().slice(0, 120)).slice(0, 30)
    : DEFAULT_ALLOW_HOSTS;
  const payload = { custom, allow_hosts, updated_at: new Date().toISOString() };
  await env.ASTON_KV.put(`${TOOLS_PREFIX}${tenant}`, JSON.stringify(payload), {
    expirationTtl: 60 * 60 * 24 * 180
  });
  return { ok: true, registry: payload };
}

function hostAllowed(urlStr, allowHosts) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return allowHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export async function executeTool(env, tenant, name, args, registry) {
  const n = String(name || "").trim();
  const a = args && typeof args === "object" ? args : {};
  const allow = registry?.allow_hosts || DEFAULT_ALLOW_HOSTS;

  try {
    switch (n) {
      case "echo":
        return { ok: true, name: n, result: { text: String(a.text ?? "") } };

      case "now_iso":
        return { ok: true, name: n, result: { iso: new Date().toISOString() } };

      case "http_get": {
        const url = String(a.url || "");
        if (!hostAllowed(url, allow)) {
          return { ok: false, name: n, error: "host_not_allowlisted", url };
        }
        const maxBytes = Math.min(100000, Math.max(1000, Number(a.max_bytes) || 32000));
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: { "user-agent": "ASTON-OS-AntiGap/6" }
        });
        clearTimeout(t);
        const buf = await res.arrayBuffer();
        const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
        const text = new TextDecoder().decode(slice);
        return {
          ok: true,
          name: n,
          result: {
            status: res.status,
            content_type: res.headers.get("content-type"),
            truncated: buf.byteLength > maxBytes,
            body: text.slice(0, maxBytes)
          }
        };
      }

      case "kv_get": {
        if (!env.ASTON_KV) return { ok: false, name: n, error: "kv_missing" };
        const key = tenantKvKey(tenant, a.key);
        const val = await env.ASTON_KV.get(key);
        return { ok: true, name: n, result: { key: String(a.key), value: val } };
      }

      case "kv_put": {
        if (!env.ASTON_KV) return { ok: false, name: n, error: "kv_missing" };
        const key = tenantKvKey(tenant, a.key);
        const value = String(a.value ?? "").slice(0, 8192);
        const ttl = Math.min(86400 * 30, Math.max(60, Number(a.ttl_sec) || 3600));
        await env.ASTON_KV.put(key, value, { expirationTtl: ttl });
        return { ok: true, name: n, result: { key: String(a.key), stored: true, ttl_sec: ttl } };
      }

      case "roi_summary": {
        const { summarizeRoi } = await import("./roi.js");
        const days = Math.min(90, Math.max(1, Number(a.days) || 7));
        const data = await summarizeRoi(env, tenant, days);
        return {
          ok: data.ok,
          name: n,
          result: data.ok ? data.summary : { error: data.error },
          error: data.ok ? undefined : data.error
        };
      }

      case "knowledge_search": {
        const { searchKnowledge } = await import("./rag.js");
        const data = await searchKnowledge(env, tenant, a.query || a.q, a.top_k || a.topK || 5);
        return {
          ok: data.ok,
          name: n,
          result: data.ok
            ? {
                mode: data.mode,
                results: (data.results || []).map((r) => ({
                  score: r.score,
                  text: r.text,
                  doc_id: r.doc_id
                }))
              }
            : { error: data.error },
          error: data.ok ? undefined : data.error
        };
      }

      default:
        return {
          ok: false,
          name: n,
          error: "tool_not_executable",
          hint: "Only built-in tools run on the worker"
        };
    }
  } catch (e) {
    return { ok: false, name: n, error: String(e?.message || e).slice(0, 300) };
  }
}

export function toolsPromptBlock(tools) {
  return tools
    .map((t) => {
      const params = JSON.stringify(t.parameters || {});
      return `- ${t.name}: ${t.description}\n  params: ${params}`;
    })
    .join("\n");
}

export function parseToolCall(text) {
  if (!text || typeof text !== "string") return null;
  const patterns = [
    /TOOL_CALL:\s*(\{[\s\S]*?\})/i,
    /```tool\s*([\s\S]*?)```/i,
    /```json\s*(\{\s*"name"\s*:[\s\S]*?\})\s*```/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]);
      if (obj?.name) {
        return {
          name: String(obj.name),
          arguments: obj.arguments || obj.args || obj.params || {}
        };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}
