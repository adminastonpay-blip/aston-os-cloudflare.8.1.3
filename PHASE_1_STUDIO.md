# Phase 1 — Ontology Studio (+20% hacia paridad Palantir)

**Version:** 10.6.0  
**Routes:** `/ui/studio` · `/ui` (hub)

## Deliverables

1. **Interactive Graph Canvas**
   - Nodos tipados (organization, person, product, order, supplier, account)
   - Drag, zoom, pan
   - Shift+click para crear edges
   - Inspector de propiedades
   - Load from `/v1/pov/graph` + seed demo

2. **Workshop / Page Builder**
   - Palette de widgets: KPI, Table, Mini Graph, Alert, Form, Metric
   - Drag-and-drop sobre canvas
   - Persistencia local (localStorage) — backend en siguiente iteración

3. **Action Configurator**
   - WHEN event → THEN playbook/action
   - Eventos: case.created, order.delayed, supplier.risk_high, receipt.signed, metric.p95_breach, ontology.node_added
   - Acciones: playbooks, notify, create_case, sign_receipt, orchestrator:rebalance

## Files

- `studio.js` — HTML app completa del Studio
- `ui.js` — router `/ui` + `/ui/studio`
- `entry.mjs` — sirve UI + health v10.6.0

## Next

- Persistir pages/rules en D1
- Conectar Actions → `/v1/orchestrator`
- Re-cablear rutas A–L en entry para API completa detrás del Studio
