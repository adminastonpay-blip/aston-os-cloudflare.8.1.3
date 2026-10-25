// ASTON OS — Phase 1: Ontology Studio (/ui/studio)
// Interactive Graph Canvas · Workshop Page Builder · Action Configurator

export function handleStudio(request, env, path) {
  if (path === "/ui/studio" || path === "/v1/ui/studio") {
    return new Response(STUDIO_HTML, {
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

// Full studio HTML is embedded below — see commit history / PHASE_1_STUDIO.md
const STUDIO_HTML = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>ASTON OS · Ontology Studio</title>
<style>
:root{--bg:#070b10;--panel:#0e141c;--panel2:#121a24;--border:#1c2836;--text:#e6edf5;--muted:#7d8fa3;--accent:#3d9cf0;--ok:#3dd68c;--warn:#f5a524;--font:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);height:100vh;overflow:hidden;display:flex;flex-direction:column}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);background:#0a1018}
h1{margin:0;font-size:1rem}h1 span{color:var(--accent)}
.tabs{display:flex;gap:4px}.tabs button{background:transparent;border:1px solid transparent;color:var(--muted);padding:8px 14px;border-radius:8px;cursor:pointer;font:inherit}
.tabs button.active{background:var(--panel);border-color:var(--border);color:var(--accent)}
.auth{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
input,select,button{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font:inherit;font-size:.85rem}
button.primary{background:linear-gradient(180deg,#2a6fad,#1e5a8f);border-color:#2a6fad;cursor:pointer}
button.secondary{cursor:pointer}button:hover{filter:brightness(1.08)}
.workspace{flex:1;display:grid;grid-template-columns:240px 1fr 280px;min-height:0}
.side{border-right:1px solid var(--border);background:#0a1018;overflow:auto;padding:12px}
.side.right{border-right:none;border-left:1px solid var(--border)}
.main{position:relative;overflow:hidden;background:#080c12}
.panel-view{display:none;height:100%}.panel-view.active{display:flex;flex-direction:column}
.toolbar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--panel)}
.canvas-wrap{flex:1;position:relative;overflow:hidden}canvas{width:100%;height:100%;display:block;cursor:crosshair}
.hint{position:absolute;left:12px;bottom:10px;color:var(--muted);font-size:.72rem;pointer-events:none}
.widget-item{padding:10px 12px;background:var(--panel2);border:1px solid var(--border);border-radius:10px;cursor:grab;font-size:.85rem;margin-bottom:6px}
.page-canvas{flex:1;margin:12px;background:var(--panel);border:1px dashed var(--border);border-radius:12px;position:relative;overflow:auto;min-height:320px}
.page-widget{position:absolute;background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:10px;min-width:140px;min-height:72px;cursor:move}
.page-widget.selected{border-color:var(--accent)}
.rule-card{background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px}
.rule-card .when{color:var(--warn);font-size:.8rem}.rule-card .then{color:var(--ok);font-size:.8rem;margin-top:4px}
.muted{color:var(--muted)}.section-title{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:12px 0 8px}
.field{margin-bottom:10px}.field label{display:block;font-size:.75rem;color:var(--muted);margin-bottom:4px}.field input,.field select{width:100%}
pre.log{background:#06090e;border:1px solid var(--border);border-radius:8px;padding:10px;font-size:.75rem;max-height:160px;overflow:auto;margin-top:10px}
.type-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
</style></head><body>
<header>
<div style="display:flex;align-items:center;gap:16px">
<h1>ASTON <span>Studio</span> <small class="muted">v10.6</small></h1>
<div class="tabs">
<button data-mode="graph" class="active">Graph</button>
<button data-mode="workshop">Workshop</button>
<button data-mode="actions">Actions</button>
</div></div>
<div class="auth">
<input id="base" placeholder="API base" style="min-width:140px"/>
<input id="token" type="password" placeholder="Bearer token"/>
<input id="tenant" placeholder="tenant" value="default" style="width:90px"/>
<button class="secondary" id="btnSave">Save</button>
<a href="/ui" style="color:var(--accent);font-size:.85rem;text-decoration:none">Command →</a>
</div></header>
<div class="workspace">
<aside class="side" id="left">
<div id="left-graph">
<div class="section-title">Object types</div><div id="typeList"></div>
<div class="section-title">Add node</div>
<div class="field"><label>Type</label><select id="newType"><option>organization</option><option>person</option><option>product</option><option>order</option><option>supplier</option><option>account</option></select></div>
<div class="field"><label>Label</label><input id="newLabel" placeholder="Nombre"/></div>
<button class="primary" id="btnAddNode" style="width:100%">+ Add node</button>
<p class="muted" style="font-size:.8rem;margin-top:10px">Shift+click two nodes to link</p>
<button class="secondary" id="btnLoadGraph" style="width:100%;margin-top:8px">Load from API</button>
<button class="secondary" id="btnSeedGraph" style="width:100%;margin-top:6px">Seed demo</button>
</div>
<div id="left-workshop" style="display:none">
<div class="section-title">Widgets</div>
<div class="widget-item" draggable="true" data-w="kpi">📊 KPI Card</div>
<div class="widget-item" draggable="true" data-w="table">📋 Data Table</div>
<div class="widget-item" draggable="true" data-w="graph">🕸 Mini Graph</div>
<div class="widget-item" draggable="true" data-w="alert">⚠ Alert Banner</div>
<div class="widget-item" draggable="true" data-w="form">✎ Action Form</div>
<div class="widget-item" draggable="true" data-w="metric">📈 Latency Metric</div>
<div class="section-title">Page</div>
<div class="field"><label>Page name</label><input id="pageName" value="Ops Dashboard"/></div>
<button class="primary" id="btnSavePage" style="width:100%">Save page</button>
<button class="secondary" id="btnClearPage" style="width:100%;margin-top:6px">Clear</button>
</div>
<div id="left-actions" style="display:none">
<div class="section-title">New rule</div>
<div class="field"><label>When</label><select id="actWhen"><option value="case.created">case.created</option><option value="order.delayed">order.delayed</option><option value="supplier.risk_high">supplier.risk_high</option><option value="receipt.signed">receipt.signed</option><option value="metric.p95_breach">metric.p95_breach</option><option value="ontology.node_added">ontology.node_added</option></select></div>
<div class="field"><label>Then</label><select id="actThen"><option value="run_playbook:escalation">playbook: escalation</option><option value="run_playbook:supplier_review">playbook: supplier_review</option><option value="notify:ops">Notify ops</option><option value="create_case">Create case</option><option value="sign_receipt">Sign receipt</option><option value="orchestrator:rebalance">Orchestrator rebalance</option></select></div>
<div class="field"><label>Name</label><input id="actName" placeholder="Rule name"/></div>
<button class="primary" id="btnAddRule" style="width:100%">+ Add rule</button>
<div class="section-title">Rules</div><div id="ruleList"></div>
</div></aside>
<div class="main">
<div class="panel-view active" id="view-graph">
<div class="toolbar"><button class="secondary" id="btnFit">Fit</button><button class="secondary" id="btnDeleteSel">Delete selected</button><span class="muted" id="graphStats">0 nodes</span></div>
<div class="canvas-wrap"><canvas id="gcanvas"></canvas><div class="hint">Drag · Shift+click link · Scroll zoom</div></div>
</div>
<div class="panel-view" id="view-workshop">
<div class="toolbar"><span class="muted">Drag widgets onto the canvas</span></div>
<div class="page-canvas" id="pageCanvas"></div>
</div>
<div class="panel-view" id="view-actions">
<div class="toolbar"><span class="muted">If event → Then action (no code)</span></div>
<div style="padding:20px;overflow:auto;flex:1"><div id="ruleListMain"></div><pre class="log" id="actLog">Rules in localStorage. Wire to orchestrator next.</pre></div>
</div></div>
<aside class="side right"><div class="section-title">Inspector</div><div id="inspector"><p class="muted">Select a node or widget</p></div><pre class="log" id="studioLog">Studio ready.</pre></aside>
</div>
<script>
const VERSION="10.6.0";const $=id=>document.getElementById(id);
const TYPE_COLOR={organization:"#3d9cf0",person:"#f07178",product:"#3dd68c",order:"#c084fc",supplier:"#f5a524",account:"#67e8f9",other:"#8b9bb0"};
const state={base:localStorage.getItem("aston_base")||location.origin,token:localStorage.getItem("aston_token")||"",tenant:localStorage.getItem("aston_tenant")||"default",mode:"graph",nodes:[],edges:[],selected:null,linkFrom:null,scale:1,pan:{x:0,y:0},widgets:JSON.parse(localStorage.getItem("aston_studio_page")||"[]"),rules:JSON.parse(localStorage.getItem("aston_studio_rules")||"[]")};
$("base").value=state.base;$("token").value=state.token;$("tenant").value=state.tenant;
$("btnSave").onclick=()=>{state.base=$("base").value.replace(/\/+$/,"")||location.origin;state.token=$("token").value;state.tenant=$("tenant").value||"default";localStorage.setItem("aston_base",state.base);localStorage.setItem("aston_token",state.token);localStorage.setItem("aston_tenant",state.tenant);log("Auth saved")};
document.querySelectorAll(".tabs button").forEach(btn=>{btn.onclick=()=>{document.querySelectorAll(".tabs button").forEach(b=>b.classList.remove("active"));btn.classList.add("active");state.mode=btn.dataset.mode;document.querySelectorAll(".panel-view").forEach(p=>p.classList.remove("active"));$("view-"+state.mode).classList.add("active");$("left-graph").style.display=state.mode==="graph"?"block":"none";$("left-workshop").style.display=state.mode==="workshop"?"block":"none";$("left-actions").style.display=state.mode==="actions"?"block":"none";if(state.mode==="graph")resizeCanvas();if(state.mode==="workshop")renderPage();if(state.mode==="actions")renderRules()}});
function log(msg){const el=$("studioLog");el.textContent=(typeof msg==="string"?msg:JSON.stringify(msg,null,2))+"\n"+el.textContent.slice(0,1500)}
async function api(path,opts={}){const headers={Authorization:"Bearer "+state.token,"X-Tenant":state.tenant,"Content-Type":"application/json",...(opts.headers||{})};const res=await fetch(state.base+path,{...opts,headers});let body;try{body=await res.json()}catch{body={raw:await res.text()}}if(!res.ok)throw Object.assign(new Error(body.error||res.statusText),{body,status:res.status});return body}
function renderTypes(){const types=Object.keys(TYPE_COLOR).filter(t=>t!=="other");$("typeList").innerHTML=types.map(t=>'<div style="padding:4px 0"><span class="type-dot" style="background:'+TYPE_COLOR[t]+'"></span>'+t+"</div>").join("")}renderTypes();
const canvas=$("gcanvas");const ctx=canvas.getContext("2d");
function resizeCanvas(){const wrap=canvas.parentElement;const dpr=window.devicePixelRatio||1;canvas.width=wrap.clientWidth*dpr;canvas.height=wrap.clientHeight*dpr;canvas.style.width=wrap.clientWidth+"px";canvas.style.height=wrap.clientHeight+"px";draw()}window.addEventListener("resize",()=>{if(state.mode==="graph")resizeCanvas()});
function worldToScreen(x,y){return{x:x*state.scale+state.pan.x+canvas.clientWidth/2,y:y*state.scale+state.pan.y+canvas.clientHeight/2}}
function screenToWorld(sx,sy){return{x:(sx-canvas.clientWidth/2-state.pan.x)/state.scale,y:(sy-canvas.clientHeight/2-state.pan.y)/state.scale}}
function draw(){const dpr=window.devicePixelRatio||1;ctx.setTransform(dpr,0,0,dpr,0,0);const w=canvas.clientWidth,h=canvas.clientHeight;ctx.clearRect(0,0,w,h);ctx.strokeStyle="#121820";ctx.lineWidth=1;const step=40*state.scale;const ox=(state.pan.x+w/2)%step,oy=(state.pan.y+h/2)%step;for(let x=ox;x<w;x+=step){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}for(let y=oy;y<h;y+=step){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
for(const e of state.edges){const a=state.nodes.find(n=>n.id===e.from),b=state.nodes.find(n=>n.id===e.to);if(!a||!b)continue;const pa=worldToScreen(a.x,a.y),pb=worldToScreen(b.x,b.y);ctx.strokeStyle="#2a3a4c";ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);ctx.stroke();if(e.label){ctx.fillStyle="#7d8fa3";ctx.font="10px system-ui";ctx.fillText(e.label,(pa.x+pb.x)/2,(pa.y+pb.y)/2-4)}}
for(const n of state.nodes){const p=worldToScreen(n.x,n.y);const r=16*state.scale;ctx.beginPath();ctx.fillStyle=TYPE_COLOR[n.type]||TYPE_COLOR.other;ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();if(state.selected===n.id){ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.stroke()}ctx.fillStyle="#e6edf5";ctx.font=Math.max(10,11*state.scale)+"px system-ui";ctx.fillText(String(n.label||n.id).slice(0,24),p.x+r+4,p.y+4)}
$("graphStats").textContent=state.nodes.length+" nodes · "+state.edges.length+" edges"}
function hitNode(sx,sy){for(let i=state.nodes.length-1;i>=0;i--){const n=state.nodes[i];const p=worldToScreen(n.x,n.y);const r=16*state.scale;if((p.x-sx)**2+(p.y-sy)**2<=r*r)return n}return null}
let drag=null;
canvas.addEventListener("mousedown",ev=>{const rect=canvas.getBoundingClientRect();const sx=ev.clientX-rect.left,sy=ev.clientY-rect.top;const n=hitNode(sx,sy);if(ev.shiftKey&&n){if(!state.linkFrom){state.linkFrom=n.id;log("Link from: "+n.label)}else if(state.linkFrom!==n.id){state.edges.push({from:state.linkFrom,to:n.id,label:"related"});state.linkFrom=null;draw();log("Edge created")}return}if(n){state.selected=n.id;drag={kind:"node",id:n.id};showNodeInspector(n)}else{state.selected=null;drag={kind:"pan",sx,sy,ox:state.pan.x,oy:state.pan.y};$("inspector").innerHTML='<p class="muted">Select a node</p>'}draw()});
window.addEventListener("mousemove",ev=>{if(!drag)return;const rect=canvas.getBoundingClientRect();const sx=ev.clientX-rect.left,sy=ev.clientY-rect.top;if(drag.kind==="node"){const n=state.nodes.find(x=>x.id===drag.id);if(!n)return;const w=screenToWorld(sx,sy);n.x=w.x;n.y=w.y;draw()}else if(drag.kind==="pan"){state.pan.x=drag.ox+(sx-drag.sx);state.pan.y=drag.oy+(sy-drag.sy);draw()}});
window.addEventListener("mouseup",()=>{drag=null});
canvas.addEventListener("wheel",ev=>{ev.preventDefault();state.scale=Math.max(0.3,Math.min(2.5,state.scale*(ev.deltaY>0?0.92:1.08)));draw()},{passive:false});
$("btnAddNode").onclick=()=>{const type=$("newType").value;const label=$("newLabel").value.trim()||type+"-"+(state.nodes.length+1);const id="n_"+crypto.randomUUID().slice(0,8);state.nodes.push({id,type,label,x:(Math.random()-0.5)*200,y:(Math.random()-0.5)*200});$("newLabel").value="";draw();log("Node added: "+label)};
$("btnDeleteSel").onclick=()=>{if(!state.selected)return;state.nodes=state.nodes.filter(n=>n.id!==state.selected);state.edges=state.edges.filter(e=>e.from!==state.selected&&e.to!==state.selected);state.selected=null;draw();$("inspector").innerHTML='<p class="muted">Deleted</p>'};
$("btnFit").onclick=()=>{state.scale=1;state.pan={x:0,y:0};draw()};
function showNodeInspector(n){$("inspector").innerHTML='<div class="field"><label>ID</label><input readonly value="'+n.id+'"/></div><div class="field"><label>Type</label><input id="inspType" value="'+n.type+'"/></div><div class="field"><label>Label</label><input id="inspLabel" value="'+(n.label||'')+'"/></div><button class="primary" id="btnApplyNode" style="width:100%">Apply</button>';$("btnApplyNode").onclick=()=>{n.type=$("inspType").value;n.label=$("inspLabel").value;draw();log("Updated")}};
$("btnLoadGraph").onclick=async()=>{try{const body=await api("/v1/pov/graph?limit=50");state.nodes=(body.nodes||[]).map((n,i)=>({id:n.id,type:n.type||"other",label:n.label||n.id,x:Math.cos(i*0.7)*120,y:Math.sin(i*0.7)*120}));state.edges=(body.edges||[]).map(e=>({from:e.from,to:e.to,label:e.label||""}));draw();log({loaded:state.nodes.length})}catch(e){log(e.body||e.message)}};
$("btnSeedGraph").onclick=async()=>{try{await api("/v1/pov/seed",{method:"POST",body:"{}"});await $("btnLoadGraph").onclick()}catch(e){log(e.body||e.message)}};
function renderPage(){const c=$("pageCanvas");c.innerHTML="";for(const w of state.widgets){const el=document.createElement("div");el.className="page-widget"+(state.selected===w.id?" selected":"");el.style.left=w.x+"px";el.style.top=w.y+"px";el.style.width=(w.w||180)+"px";el.innerHTML='<div style="font-size:.75rem;color:var(--muted)">'+w.kind+'</div><div style="margin-top:6px">'+(w.title||w.kind)+'</div>';el.onmousedown=ev=>startWidgetDrag(ev,w,el);el.onclick=ev=>{ev.stopPropagation();state.selected=w.id;renderPage();$("inspector").innerHTML='<div class="field"><label>Title</label><input id="wTitle" value="'+(w.title||'')+'"/></div><button class="primary" id="btnWApply" style="width:100%">Apply</button><button class="secondary" id="btnWDel" style="width:100%;margin-top:6px">Remove</button>';$("btnWApply").onclick=()=>{w.title=$("wTitle").value;savePage();renderPage()};$("btnWDel").onclick=()=>{state.widgets=state.widgets.filter(x=>x.id!==w.id);state.selected=null;savePage();renderPage()}};c.appendChild(el)}}
function startWidgetDrag(ev,w,el){ev.preventDefault();const sx=ev.clientX,sy=ev.clientY,ox=w.x,oy=w.y;function move(e){w.x=ox+(e.clientX-sx);w.y=oy+(e.clientY-sy);el.style.left=w.x+"px";el.style.top=w.y+"px"}function up(){window.removeEventListener("mousemove",move);window.removeEventListener("mouseup",up);savePage()}window.addEventListener("mousemove",move);window.addEventListener("mouseup",up)}
document.querySelectorAll(".widget-item").forEach(item=>{item.addEventListener("dragstart",ev=>ev.dataTransfer.setData("text/plain",item.dataset.w))});
$("pageCanvas").addEventListener("dragover",ev=>ev.preventDefault());
$("pageCanvas").addEventListener("drop",ev=>{ev.preventDefault();const kind=ev.dataTransfer.getData("text/plain");if(!kind)return;const rect=$("pageCanvas").getBoundingClientRect();state.widgets.push({id:"w_"+crypto.randomUUID().slice(0,8),kind,title:kind.toUpperCase(),x:ev.clientX-rect.left-40,y:ev.clientY-rect.top-20,w:180});savePage();renderPage();log("Widget: "+kind)});
function savePage(){localStorage.setItem("aston_studio_page",JSON.stringify(state.widgets))}
$("btnSavePage").onclick=()=>{savePage();log("Page saved")};$("btnClearPage").onclick=()=>{state.widgets=[];savePage();renderPage()};
function renderRules(){const html=state.rules.map((r,i)=>'<div class="rule-card"><strong>'+(r.name||"Rule")+'</strong><div class="when">WHEN '+r.when+'</div><div class="then">THEN '+r.then+'</div><button class="secondary" data-i="'+i+'">Remove</button></div>').join("")||'<p class="muted">No rules</p>';$("ruleList").innerHTML=html;$("ruleListMain").innerHTML=html;document.querySelectorAll("#ruleList button,#ruleListMain button").forEach(btn=>{btn.onclick=()=>{state.rules.splice(+btn.dataset.i,1);localStorage.setItem("aston_studio_rules",JSON.stringify(state.rules));renderRules()}})}
$("btnAddRule").onclick=()=>{const rule={id:"r_"+crypto.randomUUID().slice(0,8),name:$("actName").value.trim()||"Rule",when:$("actWhen").value,then:$("actThen").value};state.rules.push(rule);localStorage.setItem("aston_studio_rules",JSON.stringify(state.rules));$("actName").value="";renderRules();log("Rule: "+rule.name);$("actLog").textContent=JSON.stringify(rule,null,2)};
if(!state.nodes.length){state.nodes=[{id:"org1",type:"organization",label:"Acme Corp",x:-80,y:-40},{id:"sup1",type:"supplier",label:"Nordic Parts",x:100,y:-60},{id:"prd1",type:"product",label:"SKU-220",x:40,y:80},{id:"ord1",type:"order",label:"PO-9912",x:-100,y:90}];state.edges=[{from:"org1",to:"ord1",label:"places"},{from:"ord1",to:"prd1",label:"contains"},{from:"sup1",to:"prd1",label:"supplies"}]}
resizeCanvas();renderPage();renderRules();log("Ontology Studio "+VERSION+" ready");
</script></body></html>`;
