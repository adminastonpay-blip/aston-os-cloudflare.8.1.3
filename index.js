/**
 * Legacy index.js — re-export entry.mjs so any path hits ASTON OS 11.
 */
export { default } from "./entry.mjs";
export {
  AstonSession,
  AstonRateLimiter,
  AstonLedgerLock,
  AstonAgent,
  AstonVoiceSession,
  AstonOntology,
  AstonOrchestrator
} from "./entry.mjs";
