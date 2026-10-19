/**
 * Anti-Gap Phase 5 — agent loop (tool calling)
 */

import {
  loadToolRegistry,
  executeTool,
  toolsPromptBlock,
  parseToolCall
} from "./tools.js";
import { runWithFallbacks, buildModelCandidates, loadModelPolicy } from "./model-portfolio.js";
import { runByokChat, loadByok, envByok } from "./byok.js";
import { checkBudget, recordRoiEvent, estimateCostMicros } from "./roi.js";

const SYSTEM_TEMPLATE = `You are ASTON OS agent. You may call tools to complete the user task.
When you need a tool, respond with ONLY one line:
TOOL_CALL: {"name":"<tool_name>","arguments":{...}}
When you have the final answer, respond with normal text (no TOOL_CALL).
Available tools:
{{TOOLS}}`;

async function runModel(env, tenant, messages, body) {
  const byok = (await loadByok(env, tenant)) || envByok(env);
  if (body.byok || byok?.prefer_over_workers) {
    if (byok?.enabled && byok.api_key) {
      const b = await runByokChat(byok, messages, {
        model: body.model || byok.model,
        max_tokens: body.max_tokens || 1024
      });
      if (b.ok) return b;
    }
  }
  if (!env.AI) return { ok: false, error: "ai_missing" };
  const policy = await loadModelPolicy(env, tenant);
  const candidates = buildModelCandidates(env, body, policy);
  const w = await runWithFallbacks(env, candidates, messages, {
    max_tokens: body.max_tokens || 1024
  });
  if (w.ok) return { ...w, provider: "workers_ai" };
  if (byok?.enabled && byok.api_key) {
    const b = await runByokChat(byok, messages, {
      model: body.model || byok.model,
      max_tokens: body.max_tokens || 1024
    });
    if (b.ok) return b;
  }
  return { ok: false, error: "all_models_failed", attempts: w.attempts };
}

export async function runAgent(env, tenant, body, opts = {}) {
  const prompt =
    (typeof body.prompt === "string" && body.prompt.trim()) ||
    (typeof body.message === "string" && body.message.trim()) ||
    "";
  if (!prompt) return { ok: false, error: "prompt_required" };
  if (prompt.length > 6000) return { ok: false, error: "prompt_too_long", max: 6000 };

  const maxSteps = Math.min(8, Math.max(1, Number(body.max_steps) || Number(opts.max_steps) || 4));
  const registry = await loadToolRegistry(env, tenant);
  const toolNames = new Set(registry.tools.map((t) => t.name));

  const system = SYSTEM_TEMPLATE.replace("{{TOOLS}}", toolsPromptBlock(registry.tools));
  const messages = [
    { role: "system", content: system },
    { role: "user", content: prompt }
  ];

  const trace = [];
  let finalText = "";
  let lastModel = null;
  let totalIn = Math.ceil((system.length + prompt.length) / 4);
  let totalOut = 0;
  const started = Date.now();

  for (let step = 0; step < maxSteps; step++) {
    const run = await runModel(env, tenant, messages, body);
    if (!run.ok) {
      return {
        ok: false,
        error: "agent_model_failed",
        detail: run.error,
        steps: step,
        trace,
        attempts: run.attempts
      };
    }

    lastModel = run.model;
    finalText = run.text;
    totalOut += Math.ceil(run.text.length / 4);
    messages.push({ role: "assistant", content: run.text });

    const call = parseToolCall(run.text);
    if (!call) {
      trace.push({ step, type: "final", model: run.model, text: run.text.slice(0, 2000) });
      break;
    }

    if (!toolNames.has(call.name)) {
      const errMsg = `Unknown tool: ${call.name}`;
      trace.push({ step, type: "tool_error", name: call.name, error: errMsg });
      messages.push({
        role: "user",
        content: `Tool error: ${errMsg}. Continue or answer without that tool.`
      });
      continue;
    }

    const exec = await executeTool(env, tenant, call.name, call.arguments, registry);
    trace.push({
      step,
      type: "tool",
      name: call.name,
      arguments: call.arguments,
      ok: exec.ok,
      result: exec.result ?? null,
      error: exec.error ?? null
    });

    messages.push({
      role: "user",
      content: `TOOL_RESULT ${call.name}: ${JSON.stringify(exec.ok ? exec.result : { error: exec.error }).slice(0, 6000)}`
    });
    totalIn += 500;
  }

  return {
    ok: true,
    text: finalText,
    model: lastModel,
    steps: trace.length,
    max_steps: maxSteps,
    trace,
    tokens_est: { in: totalIn, out: totalOut },
    latency_ms: Date.now() - started
  };
}

export async function runAgentWithMetering(env, tenant, body, ctx) {
  const budget = await checkBudget(env, tenant);
  if (budget.hard) {
    return { ok: false, error: "budget_exceeded", budget };
  }

  const result = await runAgent(env, tenant, body);
  if (result.ok && ctx?.waitUntil) {
    const cost = estimateCostMicros(result.model, result.tokens_est?.in, result.tokens_est?.out);
    ctx.waitUntil(
      recordRoiEvent(env, {
        tenant_id: tenant,
        route: "/v1/ai/agent",
        model: result.model,
        tokens_in: result.tokens_est?.in,
        tokens_out: result.tokens_est?.out,
        cost_usd_micros: cost,
        latency_ms: result.latency_ms,
        outcome: "ok"
      }).catch(() => {})
    );
  }
  return result;
}
