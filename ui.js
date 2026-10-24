// ASTON OS — Phase J UI Dashboard (served from the Worker edge)

export function handleUI(request, env, path) {
  if (path === "/ui" || path === "/ui/" || path === "/v1/ui") {
    return new Response(DASHBOARD_HTML, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-aston-os": "10.3.0",
        "cache-control": "no-store"
      }
    });
  }
  return null;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ASTON OS Command</title>
<style>
:root {
  --bg:#0b0f14; --panel:#121821; --border:#1e2a38; --text:#e8eef5; --muted:#8b9bb0;
  --accent:#3d9cf0; --ok:#3dd68c; --warn:#f5a524; --bad:#f07178;
  --font: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
* { box-sizing: border-box; }
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); min-height:100vh; }
header {
  display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between;
  padding:14px 20px; border-bottom:1px solid var(--border); background:#0d131a;
}
h1 { margin:0; font-size:1.1rem; letter-spacing:.04em; }
h1 span { color:var(--accent); font-weight:600; }
.auth { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
input, select, button, textarea {
  background:var(--panel); color:var(--text); border:1px solid var(--border);
  border-radius:8px; padding:8px 10px; font:inherit;
}
input { min-width:140px; }
button {
  cursor:pointer; background:linear-gradient(180deg,#2a6fad,#1e5a8f); border-color:#2a6fad;
}
button.secondary { background:var(--panel); border-color:var(--border); }
button:hover { filter:brightness(1.08); }
main { display:grid; grid-template-columns:220px 1fr; min-height:calc(100vh - 60px); }
nav { border-right:1px solid var(--border); padding:16px 12px; background:#0d131a; }
nav button {
  display:block; width:100%; text-align:left; margin-bottom:6px;
  background:transparent; border-color:transparent;
}
nav button.active { background:var(--panel); border-color:var(--border); color:var(--accent); }
section.panel { display:none; padding:20px; }
section.panel.active { display:block; }
.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; margin-bottom:16px; }
.card {
  background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:14px;
}
.card .label { color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; }
.card .value { font-size:1.4rem; margin-top:6px; font-variant-numeric:tabular-nums; }
.row { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; align-items:center; }
pre, .log {
  background:#0a0e13; border:1px solid var(--border); border-radius:10px;
  padding:12px; overflow:auto; max-height:420px; font-size:.82rem; line-height:1.45;
}
table { width:100%; border-collapse:collapse; font-size:.85rem; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); }
th { color:var(--muted); font-weight:500; }
.muted { color:var(--muted); }
.status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:var(--muted); }
.status-dot.ok { background:var(--ok); }
.status-dot.bad { background:var(--bad); }
@media (max-width:800px) {
  main { grid-template-columns:1fr; }
  nav { display:flex; gap:4px; overflow-x:auto; border-right:none; border-bottom:1px solid var(--border); }
  nav button { width:auto; white-space:nowrap; }
}
</style>
</head>
<body>
<header>
  <h1>ASTON OS <span>Command</span> <small class="muted" id="ver">v10.3</small></h1>
  <div class="auth">
    <input id="base" placeholder="API base URL" style="min-width:200px"/>
    <input id="token" type="password" placeholder="Bearer token"/>
    <input id="tenant" placeholder="tenant" value="default" style="min-width:100px"/>
    <button id="btnSave" class="secondary">Guardar</button>
    <span id="conn" class="muted"><span class="status-dot" id="dot"></span>offline</span>
  </div>
</header>
<main>
  <nav>
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="search">Search</button>
    <button data-tab="cases">Cases</button>
    <button data-tab="metrics">Metrics</button>
    <button data-tab="foundry">Foundry</button>
    <button data-tab="receipts">Receipts</button>
  </nav>
  <div>
    <section class="panel active" id="tab-overview">
      <div class="cards">
        <div class="card"><div class="label">Foundry</div><div class="value" id="c-foundry">—</div></div>
        <div class="card"><div class="label">Receipts</div><div class="value" id="c-receipts">—</div></div>
        <div class="card"><div class="label">Metrics p50</div><div class="value" id="c-p50">—</div></div>
        <div class="card"><div class="label">Bench edge</div><div class="value" id="c-bench">—</div></div>
      </div>
      <p class="muted">Consola operativa en el edge. Configurá token y base URL (por defecto el origen actual).</p>
      <div class="row">
        <button id="btnRefresh">Refresh status</button>
        <button id="btnBench" class="secondary">Run bench</button>
      </div>
      <pre id="overviewLog">Listo.</pre>
    </section>

    <section class="panel" id="tab-search">
      <div class="row">
        <input id="q" placeholder="Buscar entidades, casos, records…" style="flex:1;min-width:200px"/>
        <button id="btnSearch">Search</button>
      </div>
      <pre id="searchOut">—</pre>
    </section>

    <section class="panel" id="tab-cases">
      <div class="row">
        <button id="btnCases">List open-ish</button>
        <button id="btnPlaybooks" class="secondary">Playbooks</button>
      </div>
      <div id="casesTable"></div>
      <pre id="casesOut" style="margin-top:12px">—</pre>
    </section>

    <section class="panel" id="tab-metrics">
      <div class="row">
        <button id="btnMetrics">Summary</button>
        <button id="btnBench2" class="secondary">Bench</button>
      </div>
      <pre id="metricsOut">—</pre>
    </section>

    <section class="panel" id="tab-foundry">
      <div class="row">
        <button id="btnTypes">Object types</button>
        <input id="objId" placeholder="object id"/>
        <button id="btnObj" class="secondary">Load object</button>
      </div>
      <pre id="foundryOut">—</pre>
    </section>

    <section class="panel" id="tab-receipts">
      <div class="row">
        <button id="btnReceipts">List receipts</button>
      </div>
      <pre id="receiptsOut">—</pre>
    </section>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const state = {
  base: localStorage.getItem('aston_base') || location.origin,
  token: localStorage.getItem('aston_token') || '',
  tenant: localStorage.getItem('aston_tenant') || 'default'
};
$('base').value = state.base;
$('token').value = state.token;
$('tenant').value = state.tenant;

$('btnSave').onclick = () => {
  state.base = $('base').value.replace(/\/+$/, '') || location.origin;
  state.token = $('token').value;
  state.tenant = $('tenant').value || 'default';
  localStorage.setItem('aston_base', state.base);
  localStorage.setItem('aston_token', state.token);
  localStorage.setItem('aston_tenant', state.tenant);
  setConn(true, 'saved');
};

document.querySelectorAll('nav button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('section.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
  };
});

function setConn(ok, label) {
  $('dot').className = 'status-dot ' + (ok ? 'ok' : 'bad');
  $('conn').lastChild ? ($('conn').childNodes[1].textContent = ' ' + label) : null;
  $('conn').innerHTML = '<span class="status-dot ' + (ok ? 'ok' : 'bad') + '"></span>' + label;
}

async function api(path, opts = {}) {
  const url = state.base + path;
  const headers = Object.assign({
    'Authorization': 'Bearer ' + state.token,
    'X-Tenant': state.tenant,
    'Content-Type': 'application/json'
  }, opts.headers || {});
  const res = await fetch(url, { ...opts, headers });
  const ms = res.headers.get('x-aston-ms');
  let body;
  try { body = await res.json(); } catch { body = { raw: await res.text() }; }
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body, status: res.status });
  return { body, ms, status: res.status };
}

function show(el, data) {
  $(el).textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

async function refresh() {
  try {
    const f = await api('/v1/foundry/status');
    $('c-foundry').textContent = f.body.phase || 'ok';
    const r = await api('/v1/receipts/status');
    $('c-receipts').textContent = r.body.signing || '—';
    try {
      const m = await api('/v1/metrics/summary');
      $('c-p50').textContent = (m.body.overall && m.body.overall.p50_ms != null) ? m.body.overall.p50_ms + ' ms' : 'n/a';
    } catch { $('c-p50').textContent = 'n/a'; }
    setConn(true, 'online');
    show('overviewLog', { foundry: f.body, receipts: r.body, ms: f.ms });
  } catch (e) {
    setConn(false, 'error');
    show('overviewLog', e.body || String(e.message));
  }
}

$('btnRefresh').onclick = refresh;
$('btnBench').onclick = $('btnBench2').onclick = async () => {
  try {
    const b = await api('/v1/metrics/bench', { method: 'POST', body: '{}' });
    $('c-bench').textContent = b.body.benchmark.edge_core_ms + ' ms';
    show('overviewLog', b.body);
    show('metricsOut', b.body);
    setConn(true, 'bench ok');
  } catch (e) {
    show('overviewLog', e.body || e.message);
  }
};

$('btnSearch').onclick = async () => {
  const q = encodeURIComponent($('q').value || '');
  try {
    const r = await api('/v1/search?q=' + q);
    show('searchOut', r.body);
  } catch (e) { show('searchOut', e.body || e.message); }
};

$('btnCases').onclick = async () => {
  try {
    const r = await api('/v1/cases?limit=20');
    const cases = r.body.cases || [];
    $('casesTable').innerHTML = '<table><tr><th>Title</th><th>Status</th><th>Priority</th><th>Playbook</th></tr>' +
      cases.map(c => '<tr><td>' + escapeHtml(c.title) + '</td><td>' + escapeHtml(c.status) +
        '</td><td>' + escapeHtml(c.priority) + '</td><td>' + escapeHtml(c.playbook || '') + '</td></tr>').join('') +
      '</table>';
    show('casesOut', r.body);
  } catch (e) { show('casesOut', e.body || e.message); }
};

$('btnPlaybooks').onclick = async () => {
  try {
    const r = await api('/v1/cases/playbooks');
    show('casesOut', r.body);
  } catch (e) { show('casesOut', e.body || e.message); }
};

$('btnMetrics').onclick = async () => {
  try {
    const r = await api('/v1/metrics/summary');
    show('metricsOut', r.body);
  } catch (e) { show('metricsOut', e.body || e.message); }
};

$('btnTypes').onclick = async () => {
  try {
    const r = await api('/v1/foundry/types');
    show('foundryOut', r.body);
  } catch (e) { show('foundryOut', e.body || e.message); }
};

$('btnObj').onclick = async () => {
  const id = $('objId').value.trim();
  if (!id) return;
  try {
    const r = await api('/v1/foundry/objects/' + encodeURIComponent(id));
    show('foundryOut', r.body);
  } catch (e) { show('foundryOut', e.body || e.message); }
};

$('btnReceipts').onclick = async () => {
  try {
    const r = await api('/v1/receipts/list');
    show('receiptsOut', r.body);
  } catch (e) { show('receiptsOut', e.body || e.message); }
};

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

refresh();
</script>
</body>
</html>`;
