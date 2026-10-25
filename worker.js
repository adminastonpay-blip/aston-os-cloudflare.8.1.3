/**
 * ASTON OS — Cloudflare Worker entry (ES Module).
 * Durable Objects REQUIRE module format. The default export MUST live
 * in this file (the one named by wrangler.toml main=) so Wrangler's
 * format detector does not fall back to service-worker.
 */
import core from "./index.js";
export {
  AstonSession,
  AstonRateLimiter,
  AstonLedgerLock,
  AstonAgent,
  AstonVoiceSession,
  AstonOntology,
  AstonOrchestrator
} from "./index.js";

export default {
  async fetch(request, env, ctx) {
    return core.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof core.scheduled === "function") {
      return core.scheduled(controller, env, ctx);
    }
  },
  async queue(batch, env, ctx) {
    if (typeof core.queue === "function") {
      return core.queue(batch, env, ctx);
    }
  }
};
