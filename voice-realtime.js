// ASTON Voice Realtime — WebSocket voice agent (Phase E unified tools / v9.6.0)
// Protocol (JSON over WS):
//   Client → Server: auth | config | audio | text | ping | end
//   Server → Client: ready | transcript | reply | reply_delta | audio | audio_chunk | audio_end | status | error | pong

import { buildVoiceToolContext } from "./voice-tools.js";

const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const TTS_MODELS = {
  en: "@cf/deepgram/aura-2-en",
  es: "@cf/deepgram/aura-2-es",
  default: "@cf/deepgram/aura-2-en"
};
const LLM_DEFAULT = "@cf/meta/llama-3.1-8b-instruct";
const MAX_HISTORY = 12;
const MAX_AUDIO_B64 = 8_000_000;

function splitSentences(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parts = raw
    .split(/(?<=[.!?…。！？])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  const merged = [];
  for (const p of parts) {
    if (merged.length && p.length < 12) merged[merged.length - 1] += " " + p;
    else merged.push(p);
  }
  if (merged.length > 8) {
    const mid = Math.ceil(merged.length / 2);
    return [merged.slice(0, mid).join(" "), merged.slice(mid).join(" ")].filter(Boolean);
  }
  return merged.length ? merged : [raw];
}

async function streamLlmReply(env, model, messages, onDelta) {
  try {
    const response = await env.AI.run(model, { messages, stream: true });
    if (response && typeof response.getReader === "function") {
      const reader = response.getReader();
      const decoder = new TextDecoder();
      let full = "";
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (!t || t === "data: [DONE]") continue;
          let payload = t.startsWith("data:") ? t.slice(5).trim() : t;
          try {
            const j = JSON.parse(payload);
            const piece =
              j.response || j.text || j.delta ||
              j.choices?.[0]?.delta?.content ||
              j.choices?.[0]?.text || "";
            if (piece) {
              full += piece;
              if (onDelta) onDelta(piece, full);
            }
          } catch {
            if (payload && payload !== "[DONE]") {
              full += payload;
              if (onDelta) onDelta(payload, full);
            }
          }
        }
      }
      if (buffer.trim()) {
        try {
          const j = JSON.parse(buffer.trim().replace(/^data:\s*/, ""));
          const piece = j.response || j.text || "";
          if (piece) { full += piece; if (onDelta) onDelta(piece, full); }
        } catch {
          full += buffer.trim();
        }
      }
      return String(full).trim();
    }
  } catch (e) {
    console.error("stream llm fallback", e?.message || e);
  }
  const response = await env.AI.run(model, { messages });
  const text = typeof response === "string"
    ? response
    : (response?.response || response?.result?.response || response?.text || JSON.stringify(response));
  return String(text).trim();
}

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function bufferFromAiAudio(aiResult) {
  if (aiResult instanceof ArrayBuffer) return { bytes: aiResult, contentType: "audio/mpeg" };
  if (aiResult instanceof Uint8Array) return { bytes: aiResult.buffer, contentType: "audio/mpeg" };
  if (aiResult instanceof ReadableStream || (aiResult && typeof aiResult.getReader === "function")) {
    const resp = new Response(aiResult);
    const bytes = await resp.arrayBuffer();
    return { bytes, contentType: resp.headers.get("content-type") || "audio/mpeg" };
  }
  if (typeof aiResult === "string") {
    const binary = atob(aiResult.replace(/^data:audio\/\w+;base64,/, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes: bytes.buffer, contentType: "audio/mpeg" };
  }
  if (aiResult && typeof aiResult === "object") {
    if (aiResult.audio) return bufferFromAiAudio(aiResult.audio);
    if (aiResult.buffer) return bufferFromAiAudio(aiResult.buffer);
  }
  throw new Error("unexpected_tts_format");
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { console.error("ws send failed", e?.message || e); }
}

export class AstonVoiceSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response(JSON.stringify({
        ok: false, error: "websocket_required",
        hint: "Connect with Upgrade: websocket to /v1/voice/ws"
      }), { status: 426, headers: { "content-type": "application/json" } });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const tenant = request.headers.get("x-aston-tenant") || url.searchParams.get("tenant") || "default";
    const speaker = url.searchParams.get("speaker") || "luna";
    const lang = url.searchParams.get("lang") || "es";
    const provider = url.searchParams.get("provider") || "cloudflare";

    const state = {
      tenant, speaker, lang, provider,
      voice_id: url.searchParams.get("voice_id") || null,
      history: [],
      authenticated: Boolean(request.headers.get("x-aston-actor")),
      stream_tts: true,
      stream_llm: true,
      enable_orchestrator: url.searchParams.get("enable_orchestrator") === "1"
    };
    this.sessions.set(server, state);

    try {
      const saved = await this.ctx.storage.get("history");
      if (Array.isArray(saved)) state.history = saved.slice(-MAX_HISTORY);
    } catch (_) {}

    send(server, {
      type: "ready", ok: true, plugin: "voice-realtime", version: "9.6.0", tenant,
      capabilities: {
        stt: Boolean(this.env.AI), tts: Boolean(this.env.AI), llm: Boolean(this.env.AI),
        elevenlabs: Boolean(this.env.ELEVENLABS_API_KEY), r2: Boolean(this.env.ASTON_R2),
        stream_tts: true, stream_llm: true,
        tools: true, ontology: true, cases: true, orchestrator: true, phase: "E"
      },
      config: { speaker, lang, provider, stream_tts: true, stream_llm: true, enable_orchestrator: state.enable_orchestrator },
      protocol: {
        client: ["auth", "config", "audio", "text", "ping", "end"],
        server: ["ready", "transcript", "reply", "reply_delta", "audio", "audio_chunk", "audio_end", "status", "error", "pong"]
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const state = this.sessions.get(ws) || {
      tenant: "default", speaker: "luna", lang: "es", provider: "cloudflare",
      history: [], authenticated: false, stream_tts: true, stream_llm: true, enable_orchestrator: false
    };
    this.sessions.set(ws, state);

    let msg;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text);
    } catch {
      send(ws, { type: "error", error: "invalid_json" });
      return;
    }

    const type = String(msg?.type || "").toLowerCase();

    if (type === "ping") { send(ws, { type: "pong", ts: Date.now() }); return; }
    if (type === "end") {
      try { ws.close(1000, "client_end"); } catch (_) {}
      this.sessions.delete(ws);
      return;
    }

    if (type === "auth") {
      const token = String(msg.token || "");
      if (this.env.ASTON_API_TOKEN && token === this.env.ASTON_API_TOKEN) {
        state.authenticated = true;
        if (msg.tenant) state.tenant = String(msg.tenant).slice(0, 64);
        send(ws, { type: "ready", ok: true, authenticated: true, tenant: state.tenant });
      } else if (!this.env.ASTON_API_TOKEN) {
        state.authenticated = true;
        send(ws, { type: "ready", ok: true, authenticated: true, note: "no_token_configured" });
      } else {
        send(ws, { type: "error", error: "unauthorized" });
      }
      return;
    }

    if (type === "config") {
      if (msg.speaker) state.speaker = String(msg.speaker).slice(0, 64);
      if (msg.lang) state.lang = String(msg.lang).slice(0, 8);
      if (msg.provider) state.provider = String(msg.provider).slice(0, 32);
      if (msg.voice_id) state.voice_id = String(msg.voice_id).slice(0, 128);
      if (msg.llm_model) state.llm_model = String(msg.llm_model).slice(0, 128);
      if (typeof msg.stream_tts === "boolean") state.stream_tts = msg.stream_tts;
      if (typeof msg.stream_llm === "boolean") state.stream_llm = msg.stream_llm;
      if (typeof msg.enable_orchestrator === "boolean") state.enable_orchestrator = msg.enable_orchestrator;
      send(ws, {
        type: "ready", ok: true,
        config: {
          speaker: state.speaker, lang: state.lang, provider: state.provider,
          voice_id: state.voice_id || null,
          stream_tts: state.stream_tts !== false,
          stream_llm: state.stream_llm !== false,
          enable_orchestrator: state.enable_orchestrator === true
        }
      });
      return;
    }

    if (type === "text" || type === "audio") {
      if (this.env.ASTON_API_TOKEN && !state.authenticated) {
        send(ws, { type: "error", error: "unauthorized", hint: "Send {type:'auth', token:'...' } first" });
        return;
      }
      try {
        await this.runTurn(ws, state, msg);
      } catch (e) {
        send(ws, { type: "error", error: "turn_failed", detail: String(e?.message || e).slice(0, 400) });
      }
      return;
    }

    send(ws, { type: "error", error: "unknown_type", allowed: ["auth", "config", "audio", "text", "ping", "end"] });
  }

  async webSocketClose(ws) { this.sessions.delete(ws); }
  async webSocketError(ws) { this.sessions.delete(ws); }

  async runTurn(ws, state, msg) {
    if (!this.env.AI) { send(ws, { type: "error", error: "ai_unavailable" }); return; }

    let userText = "";

    if (msg.type === "audio") {
      send(ws, { type: "status", phase: "stt" });
      let b64 = msg.audio_base64 || msg.audio || "";
      if (typeof b64 !== "string" || !b64) { send(ws, { type: "error", error: "audio_base64_required" }); return; }
      if (b64.includes("base64,")) b64 = b64.split("base64,").pop();
      if (b64.length > MAX_AUDIO_B64) { send(ws, { type: "error", error: "audio_too_large", max_chars: MAX_AUDIO_B64 }); return; }
      const input = { audio: b64 };
      if (state.lang) input.language = state.lang;
      const sttResult = await this.env.AI.run(STT_MODEL, input);
      userText = typeof sttResult === "string"
        ? sttResult
        : (sttResult?.text || sttResult?.transcript || sttResult?.result || "");
      userText = String(userText).trim();
      send(ws, { type: "transcript", text: userText });
      if (!userText) { send(ws, { type: "error", error: "empty_transcript" }); return; }
    } else {
      userText = String(msg.text || "").trim();
      if (!userText) { send(ws, { type: "error", error: "text_required" }); return; }
      if (userText.length > 4000) userText = userText.slice(0, 4000);
    }

    state.history.push({ role: "user", content: userText });
    if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);

    send(ws, { type: "status", phase: "tools" });
    let toolContext = "";
    let toolsUsed = [];
    try {
      const toolPack = await buildVoiceToolContext(this.env, {
        tenant: state.tenant || "default",
        text: userText,
        enable_orchestrator: state.enable_orchestrator === true
      });
      toolContext = toolPack.context || "";
      toolsUsed = toolPack.tools_used || [];
      if (toolsUsed.length) send(ws, { type: "status", phase: "tools", tools_used: toolsUsed });
    } catch (te) {
      console.error("voice tools", te?.message || te);
    }

    send(ws, { type: "status", phase: "llm" });
    const system = {
      role: "system",
      content: "You are ASTON OS voice assistant with access to live platform tools (ontology graph, operational cases, optional multi-agent orchestrator). Reply briefly in the same language as the user. Prefer 1–3 short spoken sentences. No markdown, no bullet lists. Use tool facts when present; if tools returned nothing useful, say so briefly."
    };
    const model = state.llm_model || this.env.AI_MODEL || LLM_DEFAULT;
    const streamLlm = state.stream_llm !== false;
    const streamTts = state.stream_tts !== false;

    const messages = [system, ...state.history];
    if (toolContext) {
      messages.splice(1, 0, { role: "system", content: "Tool results for this turn:\n" + toolContext.slice(0, 3500) });
    }

    let replyText = "";
    try {
      if (streamLlm) {
        replyText = await streamLlmReply(this.env, model, messages, (delta, full) => {
          send(ws, { type: "reply_delta", text: delta, full: full.slice(0, 2000) });
        });
      } else {
        const response = await this.env.AI.run(model, { messages });
        replyText = typeof response === "string"
          ? response
          : (response?.response || response?.result?.response || response?.text || JSON.stringify(response));
      }
      replyText = String(replyText).trim().slice(0, 2000);
    } catch (e) {
      send(ws, { type: "error", error: "llm_failed", detail: String(e?.message || e).slice(0, 300) });
      return;
    }

    if (!replyText) { send(ws, { type: "error", error: "empty_reply" }); return; }

    state.history.push({ role: "assistant", content: replyText });
    try {
      await this.ctx.storage.put("history", state.history.slice(-MAX_HISTORY));
      await this.ctx.storage.put("meta", { tenant: state.tenant, updated_at: new Date().toISOString() });
    } catch (_) {}

    send(ws, { type: "reply", text: replyText });

    send(ws, { type: "status", phase: "tts" });
    try {
      if (streamTts) {
        const sentences = splitSentences(replyText);
        send(ws, { type: "status", phase: "tts", mode: "stream", chunks_planned: sentences.length });
        let totalBytes = 0;
        for (let i = 0; i < sentences.length; i++) {
          const sentence = sentences[i];
          try {
            const audioPayload = await this.synthesize(state, sentence);
            if (audioPayload) {
              totalBytes += audioPayload.size;
              send(ws, {
                type: "audio_chunk",
                index: i,
                total: sentences.length,
                final: i === sentences.length - 1,
                text: sentence,
                content_type: audioPayload.contentType,
                size_bytes: audioPayload.size,
                audio_base64: audioPayload.base64,
                provider: audioPayload.provider
              });
            }
          } catch (chunkErr) {
            send(ws, {
              type: "error", error: "tts_chunk_failed", index: i,
              detail: String(chunkErr?.message || chunkErr).slice(0, 200),
              text: sentence.slice(0, 120)
            });
          }
        }
        send(ws, { type: "audio_end", chunks: sentences.length, size_bytes: totalBytes, mode: "stream" });
      } else {
        const audioPayload = await this.synthesize(state, replyText);
        if (audioPayload) {
          send(ws, {
            type: "audio",
            content_type: audioPayload.contentType,
            size_bytes: audioPayload.size,
            audio_base64: audioPayload.base64,
            provider: audioPayload.provider,
            mode: "oneshot"
          });
        }
      }
    } catch (e) {
      send(ws, {
        type: "error", error: "tts_failed",
        detail: String(e?.message || e).slice(0, 300),
        note: "text reply was delivered"
      });
    }

    send(ws, { type: "status", phase: "done" });
  }

  async synthesize(state, text) {
    const provider = state.provider || "cloudflare";
    const speaker = state.speaker || "luna";

    if (provider === "elevenlabs" || String(speaker).startsWith("clone:")) {
      if (!this.env.ELEVENLABS_API_KEY) throw new Error("elevenlabs_key_required");
      let voiceId = state.voice_id;
      if (String(speaker).startsWith("clone:") && this.env.ASTON_DB) {
        const cid = String(speaker).slice(6);
        try {
          const row = await this.env.ASTON_DB.prepare(
            "SELECT external_id FROM voice_clones WHERE id = ? AND tenant = ?"
          ).bind(cid, state.tenant).first();
          if (row?.external_id) voiceId = row.external_id;
        } catch (_) {}
      }
      if (!voiceId) throw new Error("voice_id_required_for_elevenlabs");
      const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": this.env.ELEVENLABS_API_KEY,
          "content-type": "application/json",
          accept: "audio/mpeg"
        },
        body: JSON.stringify({ text: text.slice(0, 5000), model_id: "eleven_multilingual_v2" })
      });
      if (!elRes.ok) throw new Error(`elevenlabs_tts_${elRes.status}`);
      const bytes = await elRes.arrayBuffer();
      return { base64: arrayBufferToBase64(bytes), contentType: "audio/mpeg", size: bytes.byteLength, provider: "elevenlabs" };
    }

    const lang = (state.lang || "es").toLowerCase().slice(0, 5);
    const model = TTS_MODELS[lang] || TTS_MODELS.default;
    const aiResult = await this.env.AI.run(model, {
      text: text.slice(0, 5000),
      speaker: String(speaker).toLowerCase(),
      encoding: "mp3"
    });
    const { bytes, contentType } = await bufferFromAiAudio(aiResult);
    return { base64: arrayBufferToBase64(bytes), contentType, size: bytes.byteLength, provider: "cloudflare", model };
  }
}

export async function handleVoiceRealtime(request, env, path, method, url, cors, helpers) {
  const { json } = helpers;

  if (method === "GET" && path === "/v1/voice/realtime") {
    return json({
      ok: true,
      plugin: "voice-realtime",
      version: "9.6.0",
      phase: "E",
      websocket: "/v1/voice/ws",
      requires: ["ASTON_VOICE", "AI"],
      active: Boolean(env.ASTON_VOICE) && Boolean(env.AI),
      tools: ["ontology_search", "ontology_traverse", "cases_list", "stats", "orchestrator_run"],
      protocol: {
        connect: "wss://<host>/v1/voice/ws?tenant=default&lang=es&speaker=luna",
        auth: { type: "auth", token: "<ASTON_API_TOKEN>" },
        text_turn: { type: "text", text: "Quién es Acme en la ontología" },
        audio_turn: { type: "audio", audio_base64: "<wav/mp3 base64>" },
        config: { type: "config", speaker: "luna", lang: "es", provider: "cloudflare", stream_tts: true, enable_orchestrator: false }
      },
      events_from_server: ["ready", "transcript", "reply", "reply_delta", "audio", "audio_chunk", "audio_end", "status", "error", "pong"],
      streaming: {
        default: true,
        disable: { type: "config", stream_tts: false, stream_llm: false },
        tools_phase: { type: "status", phase: "tools", tools_used: ["ontology_search"] }
      }
    }, 200, cors);
  }

  if (path === "/v1/voice/ws") {
    if (!env.ASTON_VOICE) {
      return json({
        ok: false, error: "plugin_inactive", plugin: "voice-realtime",
        missing_bindings: ["ASTON_VOICE"]
      }, 503, cors);
    }
    if (!env.AI) {
      return json({ ok: false, error: "plugin_inactive", plugin: "voice-realtime", missing_bindings: ["AI"] }, 503, cors);
    }

    const upgrade = request.headers.get("Upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return json({ ok: false, error: "websocket_required", hint: "Use WebSocket upgrade on /v1/voice/ws" }, 426, cors);
    }

    const tenant = request.headers.get("x-aston-tenant") || url.searchParams.get("tenant") || "default";
    const stub = env.ASTON_VOICE.get(env.ASTON_VOICE.idFromName(`voice:${tenant}`));
    return stub.fetch(new Request("https://voice.internal/ws?" + url.searchParams.toString(), {
      headers: request.headers,
      method: request.method
    }));
  }

  return null;
}
