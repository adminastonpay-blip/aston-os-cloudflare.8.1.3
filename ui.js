// ASTON OS — UI Phase 6: Ops Command hub + Studio
import { handleStudio } from "./studio.js";

export function handleUI(request, env, path) {
  const studio = handleStudio(request, env, path);
  if (studio) return studio;

  if (path === "/ui" || path === "/ui/" || path === "/v1/ui") {
    return new Response(DASHBOARD_HTML, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-aston-os": "11.9.0",
        "cache-control": "no-store"
      }
    });
  }
  return null;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ASTON OS Command</title>
<style>
:root{--bg:#0b0f14;--panel:#121821;--border:#1e2a38;--text:#e8eef5;--muted:#8b9bb0;--accent:#3d9cf0;--ok:#3dd68c;--warn:#f0b429;--font:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border);background:#0d131a}
h1{margin:0;font-size:1.15rem}h1 span{color:var(--accent)}
.nav a{color:var(--accent);margin-left:14px;text-decoration:none;font-size:.9rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;max-width:1100px;margin:24px auto;padding:0 16px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.card h3{margin:0 0 8px;font-size:1rem}.card p{margin:0;color:var(--muted);font-size:.88rem;line-height:1.45}
.badge{display:inline-block;font-size:.72rem;padding:2px 8px;border-radius:999px;background:#1a2838;color:var(--accent);margin-bottom:8px}
.btn{display:inline-block;margin-top:12px;background:linear-gradient(180deg,#2a6fad,#1e5a8f);color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-size:.85rem}
.btn.ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
.foot{max-width:1100px;margin:8px auto 32px;padding:0 16px;color:var(--muted);font-size:.8rem}
code{background:#0d131a;padding:1px 6px;border-radius:4px}
#health{font-family:ui-monospace,monospace;font-size:.8rem}
.status-ok{color:var(--ok)}.status-bad{color:#f07178}
</style></head>
<body>
<header>
  <h1>ASTON OS <span>Command</span> <small style="color:var(--muted);font-weight:500">v11.9 · Phase 6</small></h1>
  <nav class="nav">
    <a href="/ui/studio">Studio</a>
    <a href="/v1/capabilities">Capabilities</a>
    <a href="/health">Health</a>
  </nav>
</header>

<div class="grid">
  <div class="card">
    <div class="badge">Ontology</div>
    <h3>Grafo + entidades</h3>
    <p>CRUD, neighbors, path BFS, extract. ACL enforce en lecturas.</p>
    <a class="btn ghost" href="/v1/ontology">/v1/ontology</a>
  </div>
  <div class="card">
    <div class="badge">Foundry</div>
    <h3>Objetos + actions</h3>
    <p>Search, snapshot, history, approvals. OLS en object API.</p>
    <a class="btn ghost" href="/v1/foundry">/v1/foundry</a>
  </div>
  <div class="card">
    <div class="badge">AIP</div>
    <h3>Plan → approve → execute</h3>
    <p>HITL multi-agente con Truth Receipts.</p>
    <a class="btn ghost" href="/v1/aip">/v1/aip</a>
  </div>
  <div class="card">
    <div class="badge">Security</div>
    <h3>ACL · markings · SSO</h3>
    <p>Clearance, object ACL, ALS redact, whoami.</p>
    <a class="btn ghost" href="/v1/security/status">/v1/security</a>
  </div>
  <div class="card">
    <div class="badge">Pipelines</div>
    <h3>Ingest seguro</h3>
    <p>Templates: classified, risk, zero-copy HTTP.</p>
    <a class="btn ghost" href="/v1/pipelines/catalog">/v1/pipelines</a>
  </div>
  <div class="card">
    <div class="badge">Ops</div>
    <h3>Rate limit · Studio</h3>
    <p>Límite por tenant (KV/DO). Ontology Studio visual.</p>
    <a class="btn" href="/ui/studio">Open Studio →</a>
  </div>
</div>

<div class="foot">
  <p id="health">Cargando health…</p>
  <p>Auth: <code>Authorization: Bearer &lt;ASTON_API_TOKEN&gt;</code> · Tenant: <code>X-Tenant</code> · Role: <code>X-Aston-Role</code></p>
</div>
<script>
fetch("/").then(r=>r.json()).then(d=>{
  const el=document.getElementById("health");
  el.innerHTML = '<span class="status-ok">●</span> ' +
    (d.service||"ASTON") + " <strong>" + (d.version||"?") + "</strong> · phase <code>" +
    (d.phase||"?") + "</code>";
}).catch(e=>{
  document.getElementById("health").innerHTML='<span class="status-bad">●</span> health offline';
});
</script>
</body></html>`;
