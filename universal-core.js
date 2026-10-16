const DOMAIN_RULES = [
  { id: "health", label: "Salud y servicios humanos", patterns: /\b(salud|médic|medic|paciente|diagnóstico clínico|síntoma|hospital|health|patient|clinical)\b/i, risk: "high", approval: true },
  { id: "legal", label: "Legal y cumplimiento", patterns: /\b(legal|contrato|demanda|regulaci[oó]n|compliance|regulatory|lawsuit|contract|privacy|gdpr|pci|iso 27001)\b/i, risk: "high", approval: true },
  { id: "finance", label: "Finanzas y economía", patterns: /\b(finanzas?|financiero|inversi[oó]n|cr[eé]dito|pago|fraude|tesorer[ií]a|econom[ií]a|finance|investment|payment|credit|treasury|trading)\b/i, risk: "high", approval: true },
  { id: "security", label: "Ciberseguridad y confianza", patterns: /\b(seguridad|ciberseguridad|vulnerabilidad|incidente|amenaza|malware|security|cybersecurity|vulnerability|incident|threat|breach)\b/i, risk: "high", approval: true },
  { id: "critical_infrastructure", label: "Infraestructura crítica", patterns: /\b(energ[ií]a|electricidad|agua potable|riego|represa|red el[eé]ctrica|infraestructura cr[ií]tica|energy|power grid|water supply|critical infrastructure)\b/i, risk: "high", approval: true },
  { id: "operations", label: "Operaciones y logística", patterns: /\b(log[ií]stica|inventario|cadena de suministro|operaciones|transporte|supply chain|inventory|logistics|operations)\b/i, risk: "medium", approval: false },
  { id: "engineering", label: "Ingeniería y desarrollo digital", patterns: /\b(c[oó]digo|software|api|worker|cloudflare|shopify|programaci[oó]n|sistema|arquitectura|engineering|developer|deployment|deploy)\b/i, risk: "medium", approval: false },
  { id: "climate_agriculture", label: "Clima, agricultura y recursos", patterns: /\b(agricultura|cultivo|riego|sequ[ií]a|clima|emisiones|carbono|soil|crop|irrigation|drought|climate|emissions)\b/i, risk: "medium", approval: false },
  { id: "business", label: "Negocios y crecimiento", patterns: /\b(negocio|ventas|marketing|cliente|empresa|crecimiento|business|sales|marketing|customer|revenue|growth)\b/i, risk: "low", approval: false },
  { id: "research", label: "Investigación y conocimiento", patterns: /\b(investigar|investigaci[oó]n|evidencia|estudio|paper|research|evidence|literature review)\b/i, risk: "low", approval: false }
];

const asText = (value, max = 4000) => typeof value === "string" ? value.trim().slice(0, max) : "";
const unique = values => [...new Set(values)];

export function diagnoseProblem(input = {}) {
  const objective = asText(input.objective || input.problem, 4000);
  const context = asText(input.context, 6000);
  const constraints = asText(input.constraints, 3000);
  const combined = [objective, context, constraints].filter(Boolean).join("\n");
  const matches = DOMAIN_RULES.filter(rule => rule.patterns.test(combined));
  const primary = matches[0] || null;
  const missing = [];
  if (objective.length < 12) missing.push("Describe el resultado concreto que querés conseguir.");
  if (!context) missing.push("Agregá el contexto actual, los sistemas involucrados y qué ya intentaste.");
  if (!constraints) missing.push("Indicá límites importantes: presupuesto, plazo, recursos, normativa o acciones prohibidas.");
  if (!input.success_criteria) missing.push("Definí cómo vamos a medir si la solución funcionó.");
  const risk = matches.some(m => m.risk === "high") ? "high" : matches.some(m => m.risk === "medium") ? "medium" : "low";
  const humanApprovalRequired = matches.some(m => m.approval);
  const signals = [];
  if (/\b(eliminar|borrar|delete|drop table|reset|destruir|sobrescribir|production|producci[oó]n)\b/i.test(combined)) signals.push("potentially_destructive_change");
  if (/\b(password|contrase[nñ]a|api.?key|secret|token|private key|clave privada)\b/i.test(combined)) signals.push("possible_secret_in_input");
  if (/\b(urgente|ca[ií]do|ca[ií]da|outage|breach|incidente cr[ií]tico|emergencia)\b/i.test(combined)) signals.push("urgent_or_incident");
  return {
    schema_version: "1.0",
    objective: objective || null,
    classification: {
      domain: primary?.id || "general",
      label: primary?.label || "Resolución general de problemas",
      additional_domains: matches.slice(1).map(m => m.id),
      confidence: primary ? (matches.length > 1 ? "medium" : "medium") : "low"
    },
    risk: { level: risk, human_approval_required: humanApprovalRequired, signals: unique(signals) },
    readiness: { ready_to_plan: Boolean(objective && missing.length === 0), missing_information: missing },
    recommended_capabilities: unique([
      "problem_decomposition", "evidence_collection", "options_analysis", "verification",
      ...(risk === "high" ? ["policy_review", "human_approval"] : []),
      ...(matches.some(m => m.id === "engineering") ? ["code_and_configuration_review", "automated_tests"] : []),
      ...(matches.some(m => m.id === "finance") ? ["financial_controls", "reconciliation"] : []),
      ...(matches.some(m => m.id === "research") ? ["source_quality_assessment"] : [])
    ]),
    execution_policy: {
      mode: "plan_only",
      external_actions_executed: false,
      production_changes_allowed: false,
      require_evidence_before_completion: true,
      require_human_approval: humanApprovalRequired
    }
  };
}

export function createProblemPlan(input = {}) {
  const diagnosis = diagnoseProblem(input);
  const objective = diagnosis.objective;
  const steps = [
    { id: "intake", title: "Precisar objetivo y límites", action: "Confirmar el resultado esperado, el contexto, las restricciones y los criterios de éxito.", gate: "objective_and_constraints_defined" },
    { id: "evidence", title: "Reunir evidencia", action: "Inspeccionar datos, documentación y sistemas autorizados; separar hechos, hipótesis y vacíos.", gate: "evidence_sources_recorded" },
    { id: "diagnosis", title: "Encontrar causas y dependencias", action: "Descomponer el problema, identificar causas probables, impacto, dependencias y riesgos.", gate: "root_causes_and_risks_reviewed" },
    { id: "options", title: "Comparar soluciones", action: "Proponer al menos una opción conservadora y una alternativa, comparando impacto, coste, reversibilidad y tiempo.", gate: "options_compared" },
    { id: "approval", title: "Autorizar la intervención", action: "Revisar permisos, política, seguridad y aprobación humana antes de cualquier acción externa.", gate: "explicit_approval_recorded" },
    { id: "execute", title: "Implementar en entorno controlado", action: "Aplicar cambios mínimos, reversibles y acotados; usar pruebas y un plan de rollback.", gate: "change_is_authorized_and_tested" },
    { id: "verify", title: "Verificar resultados", action: "Ejecutar pruebas reproducibles, comparar con los criterios de éxito y registrar evidencia.", gate: "success_criteria_verified" }
  ];
  const activeSteps = diagnosis.readiness.ready_to_plan ? steps : steps.slice(0, 4);
  return {
    schema_version: "1.0",
    plan_id: crypto.randomUUID(),
    objective,
    diagnosis,
    status: diagnosis.readiness.ready_to_plan ? "ready_for_review" : "needs_clarification",
    steps: activeSteps,
    completion_definition: asText(input.success_criteria, 1000) || "Pendiente: definir criterios de éxito verificables.",
    safeguards: [
      "No ejecutar acciones externas desde este endpoint.",
      "No modificar producción ni borrar datos sin autorización explícita.",
      "No afirmar éxito sin evidencia verificable.",
      "No incluir credenciales, tokens ni datos personales innecesarios en el registro."
    ],
    created_at: new Date().toISOString()
  };
}
