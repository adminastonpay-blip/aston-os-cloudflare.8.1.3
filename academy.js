// ASTON Edge AI Academy — Phase 1 (catalog, enroll, progress) v8.11.0
// Paths aligned with Shopify section:
//   GET  /academy/courses
//   POST /academy/enroll
//   GET  /academy/me/progress
//   GET  /academy/me/enrollments

const CATALOG = [
  {
    id: "edge-engineering",
    category: "cloud",
    title: "Cloudflare Edge Engineering",
    description: "Workers, APIs, D1, R2, KV, Durable Objects, deployment and observability.",
    level: "Foundation to advanced",
    modules: 6,
    tags: ["Cloudflare", "APIs", "DevOps"],
    module_list: [
      { id: "e1", title: "Workers & routing" },
      { id: "e2", title: "D1 & schema design" },
      { id: "e3", title: "R2 & KV patterns" },
      { id: "e4", title: "Durable Objects" },
      { id: "e5", title: "Deploy & observability" },
      { id: "e6", title: "Production hardening" }
    ]
  },
  {
    id: "ai-systems-agents",
    category: "ai",
    title: "AI Systems & Agents",
    description: "LLMs, tool use, retrieval, agent workflows, evaluation and responsible automation.",
    level: "Foundation to advanced",
    modules: 7,
    tags: ["LLMs", "Agents", "RAG"],
    module_list: [
      { id: "a1", title: "LLM primitives" },
      { id: "a2", title: "Prompt design" },
      { id: "a3", title: "Tool calling" },
      { id: "a4", title: "RAG & Vectorize" },
      { id: "a5", title: "Agent loops & traces" },
      { id: "a6", title: "Evaluation" },
      { id: "a7", title: "Responsible automation" }
    ]
  },
  {
    id: "cybersecurity-trust",
    category: "security",
    title: "Cybersecurity & Digital Trust",
    description: "Zero Trust, API protection, secrets, identity, audit trails and incident readiness.",
    level: "Professional",
    modules: 5,
    tags: ["Zero Trust", "Identity", "Audit"],
    module_list: [
      { id: "s1", title: "Threat model for edge APIs" },
      { id: "s2", title: "Secrets & identity" },
      { id: "s3", title: "AuthN / AuthZ patterns" },
      { id: "s4", title: "Audit & forensics" },
      { id: "s5", title: "Incident readiness" }
    ]
  },
  {
    id: "commerce-automation",
    category: "commerce",
    title: "Intelligent Commerce Automation",
    description: "Shopify, integrations, payment flows, inventory operations and merchant analytics.",
    level: "Business systems",
    modules: 6,
    tags: ["Shopify", "Payments", "Automation"],
    module_list: [
      { id: "c1", title: "Commerce data model" },
      { id: "c2", title: "Shopify integration surface" },
      { id: "c3", title: "Orders & inventory" },
      { id: "c4", title: "Payments & ledger" },
      { id: "c5", title: "Automation playbooks" },
      { id: "c6", title: "Merchant analytics" }
    ]
  },
  {
    id: "data-enterprise-architecture",
    category: "data",
    title: "Data & Enterprise Architecture",
    description: "Data modeling, resilient services, telemetry, integrations and scalable systems.",
    level: "Professional",
    modules: 6,
    tags: ["Data", "Systems", "Reliability"],
    module_list: [
      { id: "d1", title: "Domain modeling" },
      { id: "d2", title: "Storage tradeoffs" },
      { id: "d3", title: "Event-driven design" },
      { id: "d4", title: "Telemetry & SLOs" },
      { id: "d5", title: "Integration patterns" },
      { id: "d6", title: "Scale & failure modes" }
    ]
  }
];

async function ensureAcademySchema(db) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS academy_enrollments (
        id TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        actor TEXT NOT NULL,
        course_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant, actor, course_id)
      )`
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_academy_enroll_tenant ON academy_enrollments (tenant, actor, created_at)`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS academy_progress (
        tenant TEXT NOT NULL,
        actor TEXT NOT NULL,
        course_id TEXT NOT NULL,
        module_id TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant, actor, course_id, module_id)
      )`
    )
  ]);
}

function publicCourse(c) {
  return {
    id: c.id,
    category: c.category,
    title: c.title,
    description: c.description,
    level: c.level,
    modules: c.modules,
    tags: c.tags
  };
}

export async function handleAcademy(request, env, path, method, url, cors, helpers) {
  const { json, authorized, audit, trackUsage, readJson } = helpers;

  if (method === "GET" && path === "/academy/courses") {
    const category = (url.searchParams.get("category") || "").toLowerCase();
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    let list = CATALOG.map(publicCourse);
    if (category && category !== "all") list = list.filter((c) => c.category === category);
    if (q) {
      list = list.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          (c.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    return json({ ok: true, plugin: "academy", version: "8.11.0", courses: list, total: list.length }, 200, cors);
  }

  const detailMatch = path.match(/^\/academy\/courses\/([a-z0-9-]+)$/i);
  if (method === "GET" && detailMatch) {
    const course = CATALOG.find((c) => c.id === detailMatch[1]);
    if (!course) return json({ ok: false, error: "course_not_found" }, 404, cors);
    return json({ ok: true, plugin: "academy", course: { ...publicCourse(course), module_list: course.module_list } }, 200, cors);
  }

  if (method === "POST" && path === "/academy/enroll") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized", message: "Sign in with an authorized account to enroll." }, 401, cors);
    if (!env.ASTON_DB) {
      return json({ ok: false, error: "plugin_inactive", plugin: "academy", missing_bindings: ["ASTON_DB"], message: "Enrollment requires D1." }, 503, cors);
    }
    const body = await readJson(request);
    const courseId = String(body?.course_id || body?.course || "").trim();
    const course = CATALOG.find((c) => c.id === courseId);
    if (!course) {
      return json({ ok: false, error: "invalid_course", message: "Unknown course_id. Use GET /academy/courses.", allowed: CATALOG.map((c) => c.id) }, 400, cors);
    }
    try {
      await ensureAcademySchema(env.ASTON_DB);
      const existing = await env.ASTON_DB.prepare(
        "SELECT id, status, created_at FROM academy_enrollments WHERE tenant = ? AND actor = ? AND course_id = ?"
      ).bind(auth.tenant, auth.actor, courseId).first();
      if (existing) {
        return json({
          ok: true, duplicate: true, message: "Already enrolled in this learning path.",
          enrollment: { id: existing.id, course_id: courseId, status: existing.status, created_at: existing.created_at }
        }, 200, cors);
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.ASTON_DB.prepare(
        "INSERT INTO academy_enrollments (id, tenant, actor, course_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, auth.tenant, auth.actor, courseId, "active", now).run();
      if (typeof trackUsage === "function") await trackUsage(env, auth.tenant, "academy.enroll", 1);
      if (typeof audit === "function") await audit(env, auth.tenant, auth.actor, "academy.enroll", courseId);
      return json({
        ok: true, message: "Request received by the Worker. Enrollment is active.",
        enrollment: { id, course_id: courseId, title: course.title, status: "active", created_at: now }
      }, 201, cors);
    } catch (e) {
      return json({ ok: false, error: "enroll_failed", message: "Enrollment request failed.", detail: String(e?.message || e).slice(0, 300) }, 500, cors);
    }
  }

  if (method === "GET" && path === "/academy/me/enrollments") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized", message: "Sign in with an authorized account." }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "plugin_inactive", plugin: "academy", missing_bindings: ["ASTON_DB"] }, 503, cors);
    try {
      await ensureAcademySchema(env.ASTON_DB);
      const rows = await env.ASTON_DB.prepare(
        "SELECT id, course_id, status, created_at FROM academy_enrollments WHERE tenant = ? AND actor = ? ORDER BY created_at DESC LIMIT 50"
      ).bind(auth.tenant, auth.actor).all();
      const enrollments = (rows.results || []).map((r) => {
        const c = CATALOG.find((x) => x.id === r.course_id);
        return { id: r.id, course_id: r.course_id, title: c?.title || r.course_id, status: r.status, created_at: r.created_at };
      });
      return json({ ok: true, plugin: "academy", tenant: auth.tenant, enrollments }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "enrollments_failed", detail: String(e?.message || e).slice(0, 200) }, 500, cors);
    }
  }

  if (method === "GET" && path === "/academy/me/progress") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized", message: "Sign in with an authorized account to view progress." }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "plugin_inactive", plugin: "academy", missing_bindings: ["ASTON_DB"] }, 503, cors);
    try {
      await ensureAcademySchema(env.ASTON_DB);
      const courseFilter = (url.searchParams.get("course_id") || "").trim();
      const enrollRows = await env.ASTON_DB.prepare(
        "SELECT course_id FROM academy_enrollments WHERE tenant = ? AND actor = ? AND status = ?"
      ).bind(auth.tenant, auth.actor, "active").all();
      let courseIds = (enrollRows.results || []).map((r) => r.course_id);
      if (courseFilter) courseIds = courseIds.filter((id) => id === courseFilter);
      if (!courseIds.length) {
        return json({ ok: true, plugin: "academy", progress_percent: 0, courses: [], message: "No active enrollments." }, 200, cors);
      }
      const progressRows = await env.ASTON_DB.prepare(
        "SELECT course_id, module_id, completed FROM academy_progress WHERE tenant = ? AND actor = ?"
      ).bind(auth.tenant, auth.actor).all();
      const done = new Set(
        (progressRows.results || []).filter((r) => Number(r.completed) === 1).map((r) => `${r.course_id}:${r.module_id}`)
      );
      let totalModules = 0, completedModules = 0;
      const courses = [];
      for (const cid of courseIds) {
        const c = CATALOG.find((x) => x.id === cid);
        if (!c) continue;
        const mods = c.module_list || [];
        totalModules += mods.length;
        let doneCount = 0;
        for (const m of mods) { if (done.has(`${cid}:${m.id}`)) doneCount++; }
        completedModules += doneCount;
        courses.push({
          course_id: cid, title: c.title, modules_total: mods.length, modules_completed: doneCount,
          progress_percent: mods.length ? Math.round((doneCount / mods.length) * 100) : 0
        });
      }
      const progress_percent = totalModules ? Math.round((completedModules / totalModules) * 100) : 0;
      return json({ ok: true, plugin: "academy", progress_percent, modules_completed: completedModules, modules_total: totalModules, courses }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "progress_failed", detail: String(e?.message || e).slice(0, 200) }, 500, cors);
    }
  }

  if (method === "POST" && path === "/academy/me/progress") {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "plugin_inactive", plugin: "academy", missing_bindings: ["ASTON_DB"] }, 503, cors);
    const body = await readJson(request);
    const courseId = String(body?.course_id || "").trim();
    const moduleId = String(body?.module_id || "").trim();
    const course = CATALOG.find((c) => c.id === courseId);
    if (!course || !course.module_list.some((m) => m.id === moduleId)) {
      return json({ ok: false, error: "invalid_course_or_module" }, 400, cors);
    }
    try {
      await ensureAcademySchema(env.ASTON_DB);
      const enrolled = await env.ASTON_DB.prepare(
        "SELECT id FROM academy_enrollments WHERE tenant = ? AND actor = ? AND course_id = ? AND status = ?"
      ).bind(auth.tenant, auth.actor, courseId, "active").first();
      if (!enrolled) return json({ ok: false, error: "not_enrolled", message: "Enroll in the course first." }, 403, cors);
      const now = new Date().toISOString();
      await env.ASTON_DB.prepare(
        `INSERT INTO academy_progress (tenant, actor, course_id, module_id, completed, updated_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(tenant, actor, course_id, module_id) DO UPDATE SET completed = 1, updated_at = excluded.updated_at`
      ).bind(auth.tenant, auth.actor, courseId, moduleId, now).run();
      if (typeof audit === "function") await audit(env, auth.tenant, auth.actor, "academy.module_complete", `${courseId}:${moduleId}`);
      return json({ ok: true, course_id: courseId, module_id: moduleId, completed: true, updated_at: now }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: "progress_update_failed", detail: String(e?.message || e).slice(0, 200) }, 500, cors);
    }
  }

  return null;
}
