/**
 * ASTON OS v11.3.0 - ES Module Entrypoint Bridge
 * Auditoría de integridad: Preserva Walker, Swarm, Twin y la compatibilidad con Cloudflare Workers.
 */

// 1. Exportación principal del Handler HTTP/Fetch hacia el núcleo v11
export { default } from "./entry.mjs";

// 2. Exportación de clases de Durable Objects (Requerido por Cloudflare para no bloquear el deploy)
export {
  AstonSession,
  AstonRateLimiter,
  AstonLedgerLock,
  AstonAgent,
  AstonVoiceSession,
  AstonOntology,
  AstonOrchestrator
} from "./entry.mjs";
