# Phase E — Voice unificado

La sesión WebSocket de voz consulta **ontology**, **cases** y (opcional) **orchestrator** antes del LLM + TTS.

## Flujo por turno
1. STT o texto
2. `status: tools` → `buildVoiceToolContext`
3. LLM con tool facts
4. TTS streaming

## Tools automáticos (por intención del usuario)
| Trigger (ejemplos) | Tool |
|--------------------|------|
| entidad, proveedor, quién es | ontology_search / traverse |
| caso, playbook, incidente | cases_list |
| cuántos, stats | stats |
| investigar a fondo + `enable_orchestrator` | orchestrator_run |

## Config WS
```json
{ "type": "config", "lang": "es", "enable_orchestrator": false }
```
Query: `?enable_orchestrator=1`

## Ejemplo
```json
{ "type": "text", "text": "¿Qué casos abiertos hay y quién es Acme en la ontología?" }
```

## Deploy
```bash
git checkout phase-e-voice
npx wrangler deploy
```
No requiere migración DO nueva (usa AstonVoiceSession existente).
