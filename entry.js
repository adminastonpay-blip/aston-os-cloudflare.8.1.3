/**
 * ASTON OS entry — Phase 1–6 anti-gap (non-breaking).
 * index.js is never modified. Deploy with wrangler main = entry.js
 */
import core from "./index.js";
export {
  AstonSession,
  AstonRateLimiter,
  AstonLedgerLock,
  AstonAgent,
  AstonVoiceSession
} from "./index.js";

import { tryHandleAntiGapStandalone, enrichHealthResponse } from "./anti-gap/phase1.js";
import { tryHandlePhase2, enrichHealthPhase2 } from "./anti-gap/phase2.js";
import { tryHandlePhase3, enrichHealthPhase3, runPhase3Cron } from "./anti-gap/phase3.js";
import { tryHandlePhase4, enrichHealthPhase4, runPhase4Cron } from "./anti-gap/phase4.js";
import { tryHandlePhase5, enrichHealthPhase5 } from "./anti-gap/phase5.js";
import { tryHandlePhase6, enrichHealthPhase6 } from "./anti-gap/phase6.js";

export default {
  async fetch(request, env, ctx) {
    try {
      const p6 = await tryHandlePhase6(request, env, ctx);
      if (p6) return p6;

      const p5 = await tryHandlePhase5(request, env, ctx);
      if (p5) return p5;

      const p4 = await tryHandlePhase4(request, env, ctx);
      if (p4) return p4;

      const p3 = await tryHandlePhase3(request, env, ctx);
      if (p3) return p3;

      const p2 = await tryHandlePhase2(request, env, ctx);
      if (p2) return p2;

      const ag = await tryHandleAntiGapStandalone(request, env, ctx);
      if (ag) return ag;

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (
        request.method === "GET" &&
        (path === "/" || path === "/health") &&
        env.ANTI_GAP !== "false"
      ) {
        const res = await core.fetch(request, env, ctx);
        try {
          const data = await res.clone().json();
          await enrichHealthResponse(data, env, url);
          enrichHealthPhase2(data, env);
          enrichHealthPhase3(data, env);
          enrichHealthPhase4(data, env);
          enrichHealthPhase5(data, env);
          enrichHealthPhase6(data, env);
          const headers = new Headers(res.headers);
          headers.set("content-type", "application/json; charset=utf-8");
          return new Response(JSON.stringify(data), { status: res.status, headers });
        } catch {
          return res;
        }
      }

      return core.fetch(request, env, ctx);
    } catch (error) {
      console.error("entry unhandled", error?.stack || error);
      return new Response(JSON.stringify({ ok: false, error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  },
  async scheduled(controller, env, ctx) {
    if (env.ANTI_GAP !== "false") {
      if (env.ANTI_GAP_P3 !== "false") ctx.waitUntil(runPhase3Cron(env));
      if (env.ANTI_GAP_P4 !== "false") ctx.waitUntil(runPhase4Cron(env));
    }
    if (typeof core.scheduled === "function") {
      return core.scheduled(controller, env, ctx);
    }
  },
  async queue(batch, env) {
    if (typeof core.queue === "function") return core.queue(batch, env);
  }
};
