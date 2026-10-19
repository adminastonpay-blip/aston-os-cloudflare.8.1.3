/**
 * ASTON OS entry — wraps core worker with Anti-Gap Phase 1 (non-breaking).
 * Production main branch unchanged until this branch is merged.
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

export default {
  async fetch(request, env, ctx) {
    try {
      const ag = await tryHandleAntiGapStandalone(request, env, ctx);
      if (ag) return ag;

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (request.method === "GET" && (path === "/" || path === "/health") && env.ANTI_GAP !== "false") {
        const res = await core.fetch(request, env, ctx);
        try {
          const data = await res.clone().json();
          await enrichHealthResponse(data, env, url);
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
    if (typeof core.scheduled === "function") return core.scheduled(controller, env, ctx);
  },
  async queue(batch, env) {
    if (typeof core.queue === "function") return core.queue(batch, env);
  }
};
