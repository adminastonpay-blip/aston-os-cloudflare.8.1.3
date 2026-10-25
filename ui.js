// ASTON OS — UI routes: /ui (Command hub) + /ui/studio (Ontology Studio Phase 1)
import { handleStudio } from "./studio.js";

export function handleUI(request, env, path) {
  const studio = handleStudio(request, env, path);
  if (studio) return studio;

  if (path === "/ui" || path === "/ui/" || path === "/v1/ui") {
    return new Response(DASHBOARD_HTML, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-aston-os": "10.6.0",
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
:root{--bg:#0b0f14;--panel:#121821;--border:#1e2a38;--text:#e8eef5;--muted:#8b9bb0;--accent:#3d9cf0;--font:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border);background:#0d131a}
h1{margin:0;font-size:1.1rem}h1 span{color:var(--accent)}
a.btn{background:linear-gradient(180deg,#2a6fad,#1e5a8f);color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:.9rem}
.card{max-width:640px;margin:40px auto;padding:24px;background:var(--panel);border:1px solid var(--border);border-radius:14px}
.muted{color:var(--muted)}ul{line-height:1.8}
</style></head>
<body>
<header>
  <h1>ASTON OS <span>Command</span> <small class="muted">v10.6</small></h1>
  <a class="btn" href="/ui/studio">Open Ontology Studio →</a>
</header>
<div class="card">
  <h2 style="margin-top:0">Phase 1 — Ontology Studio</h2>
  <p class="muted">Visualizing & Ontology Studio (+20% hacia paridad Palantir)</p>
  <ul>
    <li><strong>Graph</strong> — canvas interactivo de ontología</li>
    <li><strong>Workshop</strong> — page builder drag-and-drop</li>
    <li><strong>Actions</strong> — configurador visual If → Then</li>
  </ul>
  <p><a class="btn" href="/ui/studio">Entrar al Studio</a></p>
  <p class="muted" style="margin-top:24px;font-size:.85rem">API health: <code id="v">…</code></p>
</div>
<script>
fetch("/").then(r=>r.json()).then(d=>{document.getElementById("v").textContent=d.version||"?"}).catch(()=>{});
</script>
</body></html>`;
