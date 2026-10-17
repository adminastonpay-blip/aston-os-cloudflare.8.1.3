import { handleVoiceClone } from "./voice-clone.js";
// ASTON Voice plugin — Phase 1 (TTS / STT / voices) v8.7.0 + clone wire
const TTS_MODELS = {
  en: "@cf/deepgram/aura-2-en",
  es: "@cf/deepgram/aura-2-es",
  default: "@cf/deepgram/aura-2-en"
};

const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";

const VOICES = [
  { id: "luna", name: "Luna", gender: "female", langs: ["en"] },
  { id: "asteria", name: "Asteria", gender: "female", langs: ["en"] },
  { id: "athena", name: "Athena", gender: "female", langs: ["en"] },
  { id: "hera", name: "Hera", gender: "female", langs: ["en"] },
  { id: "stella", name: "Stella", gender: "female", langs: ["en"] },
  { id: "orion", name: "Orion", gender: "male", langs: ["en"] },
  { id: "apollo", name: "Apollo", gender: "male", langs: ["en"] },
  { id: "arcas", name: "Arcas", gender: "male", langs: ["en"] },
  { id: "zeus", name: "Zeus", gender: "male", langs: ["en"] },
  { id: "hermes", name: "Hermes", gender: "male", langs: ["en"] }
];

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
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

export async function handleVoice(request, env, path, method, url, cors, helpers) {
  const { json, authorized, ensureSchema, audit, trackUsage, readJson } = helpers;

  if (method === "GET" && path === "/v1/voice/voices") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    return json({
      ok: true,
      plugin: "voice",
      tts_models: TTS_MODELS,
      stt_model: STT_MODEL,
      voices: VOICES,
      clone_available: Boolean(env.ELEVENLABS_API_KEY),
      note: "Aura-2 speakers; clones need ELEVENLABS_API_KEY; speaker=clone:<id> + provider=elevenlabs"
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/voice/tts") {
    const auth = await authorized(request, env, "ai");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);

    const body = await readJson(request);
    const provider = String(body?.provider || "cloudflare").toLowerCase();
    const speakerEarly = String(body?.speaker || body?.voice || "luna");
    if (provider === "elevenlabs" || speakerEarly.startsWith("clone:")) {
      if (!env.ELEVENLABS_API_KEY) return json({ ok: false, error: "elevenlabs_key_required" }, 503, cors);
      const textEl = typeof body?.text === "string" ? body.text.trim() : "";
      if (!textEl) return json({ ok: false, error: "text_required" }, 400, cors);
      let voiceId = body?.external_id || body?.voice_id;
      if (speakerEarly.startsWith("clone:") && env.ASTON_DB) {
        try {
          const row = await env.ASTON_DB.prepare("SELECT external_id FROM voice_clones WHERE id = ? AND tenant = ?").bind(speakerEarly.slice(6), auth.tenant).first();
          if (row?.external_id) voiceId = row.external_id;
        } catch (_) {}
      }
      if (!voiceId) return json({ ok: false, error: "voice_id_or_clone_required" }, 400, cors);
      try {
        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json", "accept": "audio/mpeg" },
          body: JSON.stringify({ text: textEl.slice(0, 5000), model_id: body?.model || "eleven_multilingual_v2" })
        });
        if (!elRes.ok) return json({ ok: false, error: "elevenlabs_tts_failed", detail: (await elRes.text()).slice(0, 400) }, 502, cors);
        const bytes = await elRes.arrayBuffer();
        const id = crypto.randomUUID();
        let stored = false;
        const r2Key = `${auth.tenant}/voice/${id}.mp3`;
        if (env.ASTON_R2) { try { await env.ASTON_R2.put(r2Key, bytes, { httpMetadata: { contentType: "audio/mpeg" } }); stored = true; } catch (_) {} }
        if (typeof trackUsage === "function") await trackUsage(env, auth.tenant, "voice.tts", 1);
        await audit(env, auth.tenant, auth.actor, "voice.tts", `elevenlabs:${voiceId}`);
        const payload = { ok: true, plugin: "voice", id, provider: "elevenlabs", voice_id: voiceId, size_bytes: bytes.byteLength, stored_in_r2: stored, r2_key: stored ? r2Key : null };
        if (body?.return_base64 === true || body?.return_base64 === "true") payload.audio_base64 = arrayBufferToBase64(bytes);
        return json(payload, 201, cors);
      } catch (e) {
        return json({ ok: false, error: "tts_failed", detail: String(e?.message || e).slice(0, 300) }, 502, cors);
      }
    }
    if (!env.AI) return json({ ok: false, error: "plugin_inactive", plugin: "voice", missing_bindings: ["AI"] }, 503, cors);

    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ ok: false, error: "text_required" }, 400, cors);
    if (text.length > 5000) return json({ ok: false, error: "text_too_long", max: 5000 }, 400, cors);

    const lang = String(body?.lang || "en").toLowerCase().slice(0, 5);
    const model = body?.model || TTS_MODELS[lang] || TTS_MODELS.default;
    const speaker = String(body?.speaker || body?.voice || "luna").toLowerCase();
    const encoding = body?.encoding || "mp3";

    try {
      const aiResult = await env.AI.run(model, { text, speaker, encoding });
      const { bytes, contentType } = await bufferFromAiAudio(aiResult);
      const id = crypto.randomUUID();
      const ext = encoding === "linear16" || encoding === "wav" ? "wav" : "mp3";
      const r2Key = `${auth.tenant}/voice/${id}.${ext}`;
      let stored = false;
      const sizeBytes = bytes.byteLength;

      if (env.ASTON_R2) {
        try {
          await env.ASTON_R2.put(r2Key, bytes, {
            httpMetadata: { contentType },
            customMetadata: { tenant: auth.tenant, model, speaker, kind: "tts" }
          });
          stored = true;
        } catch (e) {
          console.error("R2 voice put failed", e?.message || e);
        }
      }

      if (env.ASTON_DB) {
        try {
          await ensureSchema(env.ASTON_DB);
          await env.ASTON_DB.prepare(
            "INSERT INTO media (id, tenant, kind, prompt, model, r2_key, content_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            id, auth.tenant, "tts", text.slice(0, 2000), model,
            stored ? r2Key : null, contentType, sizeBytes, new Date().toISOString()
          ).run();
        } catch (e) {
          console.error("media tts insert failed", e?.message || e);
        }
      }

      if (typeof trackUsage === "function") await trackUsage(env, auth.tenant, "voice.tts", 1);
      await audit(env, auth.tenant, auth.actor, "voice.tts", `${model}:${speaker}:${id}`);

      const payload = {
        ok: true,
        plugin: "voice",
        id,
        model,
        speaker,
        lang,
        content_type: contentType,
        size_bytes: sizeBytes,
        stored_in_r2: stored,
        r2_key: stored ? r2Key : null
      };
      if (body?.return_base64 === true || body?.return_base64 === "true") {
        payload.audio_base64 = arrayBufferToBase64(bytes);
      }
      return json(payload, 201, cors);
    } catch (e) {
      return json({
        ok: false,
        error: "tts_failed",
        detail: String(e?.message || e).slice(0, 400),
        hint: "Check Workers AI Aura-2 model availability and speaker id"
      }, 502, cors);
    }
  }

  if (method === "POST" && path === "/v1/voice/stt") {
    const auth = await authorized(request, env, "ai");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.AI) return json({ ok: false, error: "plugin_inactive", plugin: "voice", missing_bindings: ["AI"] }, 503, cors);

    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    let audioBase64 = null;
    let language = null;
    let model = STT_MODEL;

    if (contentType.includes("application/json")) {
      const body = await readJson(request);
      if (!body) return json({ ok: false, error: "json_required" }, 400, cors);
      audioBase64 = body.audio_base64 || body.audio || null;
      if (typeof audioBase64 === "string" && audioBase64.includes("base64,")) {
        audioBase64 = audioBase64.split("base64,").pop();
      }
      language = body.language || body.lang || null;
      if (body.model) model = String(body.model);
    } else if (contentType.includes("multipart/form-data") || contentType.includes("audio/") || contentType.includes("application/octet-stream")) {
      try {
        if (contentType.includes("multipart/form-data")) {
          const form = await request.formData();
          const file = form.get("audio") || form.get("file");
          if (!file || typeof file.arrayBuffer !== "function") {
            return json({ ok: false, error: "audio_file_required", hint: "multipart field audio|file" }, 400, cors);
          }
          const buf = await file.arrayBuffer();
          audioBase64 = arrayBufferToBase64(buf);
          language = form.get("language") || form.get("lang") || null;
        } else {
          const buf = await request.arrayBuffer();
          if (!buf || buf.byteLength < 32) return json({ ok: false, error: "audio_body_required" }, 400, cors);
          if (buf.byteLength > 25 * 1024 * 1024) return json({ ok: false, error: "audio_too_large", max_mb: 25 }, 400, cors);
          audioBase64 = arrayBufferToBase64(buf);
        }
      } catch (e) {
        return json({ ok: false, error: "audio_parse_failed", detail: String(e?.message || e).slice(0, 200) }, 400, cors);
      }
    } else {
      return json({
        ok: false,
        error: "unsupported_content_type",
        hint: "Use application/json {audio_base64} or multipart/audio body"
      }, 415, cors);
    }

    if (!audioBase64) return json({ ok: false, error: "audio_required" }, 400, cors);

    try {
      const input = { audio: audioBase64 };
      if (language) input.language = String(language).slice(0, 16);
      const result = await env.AI.run(model, input);
      const text = typeof result === "string"
        ? result
        : (result?.text || result?.transcript || result?.result || JSON.stringify(result));

      if (typeof trackUsage === "function") await trackUsage(env, auth.tenant, "voice.stt", 1);
      await audit(env, auth.tenant, auth.actor, "voice.stt", model);

      return json({
        ok: true,
        plugin: "voice",
        model,
        text: String(text),
        language: language || null
      }, 200, cors);
    } catch (e) {
      return json({
        ok: false,
        error: "stt_failed",
        detail: String(e?.message || e).slice(0, 400),
        hint: "Check audio format (wav/mp3) and Workers AI Whisper availability"
      }, 502, cors);
    }
  }

  {
    const cloneRes = await handleVoiceClone(request, env, path, method, url, cors, helpers);
    if (cloneRes) return cloneRes;
  }
  return null;
}
