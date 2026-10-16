// ASTON Voice Clone — ElevenLabs IVC + speak (v8.8.0)
function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function ensureClonesTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS voice_clones (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)"
  ).run();
}

export async function handleVoiceClone(request, env, path, method, url, cors, helpers) {
  const { json, authorized, ensureSchema, audit, trackUsage, readJson } = helpers;

  if (method === "POST" && path === "/v1/voice/clone") {
    const auth = await authorized(request, env, "ai");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ELEVENLABS_API_KEY) {
      return json({
        ok: false,
        error: "clone_provider_unavailable",
        hint: "Set secret ELEVENLABS_API_KEY. Workers AI has no native voice cloning."
      }, 503, cors);
    }
    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    let name = "clone";
    let description = "";
    const files = [];
    try {
      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        name = String(form.get("name") || "clone").slice(0, 120);
        description = String(form.get("description") || "").slice(0, 500);
        for (const key of ["files", "file", "audio", "sample"]) {
          for (const v of form.getAll(key)) {
            if (v && typeof v.arrayBuffer === "function") files.push(v);
          }
        }
      } else if (contentType.includes("application/json")) {
        const body = await readJson(request);
        if (!body) return json({ ok: false, error: "json_required" }, 400, cors);
        name = String(body.name || "clone").slice(0, 120);
        description = String(body.description || "").slice(0, 500);
        const list = Array.isArray(body.samples) ? body.samples : Array.isArray(body.files) ? body.files : body.audio_base64 ? [body.audio_base64] : [];
        for (let i = 0; i < list.length; i++) {
          let b64 = typeof list[i] === "string" ? list[i] : list[i]?.audio_base64;
          if (!b64) continue;
          if (b64.includes("base64,")) b64 = b64.split("base64,").pop();
          const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          files.push(new File([binary], `sample-${i}.mp3`, { type: "audio/mpeg" }));
        }
      } else {
        return json({ ok: false, error: "use_multipart_or_json" }, 415, cors);
      }
    } catch (e) {
      return json({ ok: false, error: "clone_parse_failed", detail: String(e?.message || e).slice(0, 200) }, 400, cors);
    }
    if (!files.length) return json({ ok: false, error: "audio_samples_required" }, 400, cors);
    if (files.length > 5) return json({ ok: false, error: "too_many_samples", max: 5 }, 400, cors);

    try {
      const form = new FormData();
      form.append("name", `${auth.tenant}:${name}`);
      if (description) form.append("description", description);
      for (const f of files) form.append("files", f, f.name || "sample.mp3");
      const elRes = await fetch("https://api.elevenlabs.io/v1/voices/add", {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
        body: form
      });
      const elText = await elRes.text();
      let elJson; try { elJson = JSON.parse(elText); } catch { elJson = { raw: elText.slice(0, 400) }; }
      if (!elRes.ok) return json({ ok: false, error: "elevenlabs_clone_failed", status: elRes.status, detail: elJson }, 502, cors);
      const externalId = elJson.voice_id || elJson.voiceId;
      if (!externalId) return json({ ok: false, error: "no_voice_id", detail: elJson }, 502, cors);
      const id = crypto.randomUUID();
      if (env.ASTON_DB) {
        await ensureSchema(env.ASTON_DB);
        await ensureClonesTable(env.ASTON_DB);
        await env.ASTON_DB.prepare(
          "INSERT INTO voice_clones (id, tenant, name, provider, external_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(id, auth.tenant, name, "elevenlabs", externalId, "ready", new Date().toISOString()).run();
      }
      if (typeof trackUsage === "function") await trackUsage(env, auth.tenant, "voice.clone", 1);
      await audit(env, auth.tenant, auth.actor, "voice.clone", `${name}:${externalId}`);
      return json({
        ok: true, plugin: "voice", id, name, provider: "elevenlabs", external_id: externalId, status: "ready",
        note: "TTS: POST /v1/voice/tts { provider:\"elevenlabs\", speaker:\"clone:" + id + "\", text:\"...\" }"
      }, 201, cors);
    } catch (e) {
      return json({ ok: false, error: "clone_failed", detail: String(e?.message || e).slice(0, 400) }, 502, cors);
    }
  }

  if (method === "GET" && path === "/v1/voice/clones") {
    const auth = await authorized(request, env, "read");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.ASTON_DB) return json({ ok: false, error: "d1_unavailable" }, 503, cors);
    await ensureSchema(env.ASTON_DB);
    await ensureClonesTable(env.ASTON_DB);
    const result = await env.ASTON_DB.prepare(
      "SELECT id, name, provider, external_id, status, created_at FROM voice_clones WHERE tenant = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(auth.tenant).all();
    return json({ ok: true, plugin: "voice", clone_available: Boolean(env.ELEVENLABS_API_KEY), clones: result.results || [] }, 200, cors);
  }

  if (method === "DELETE" && path.startsWith("/v1/voice/clones/")) {
    const auth = await authorized(request, env, "write");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const cloneId = path.slice("/v1/voice/clones/".length).split("/")[0];
    if (!cloneId || !env.ASTON_DB) return json({ ok: false, error: "clone_id_required" }, 400, cors);
    await ensureSchema(env.ASTON_DB);
    await ensureClonesTable(env.ASTON_DB);
    const row = await env.ASTON_DB.prepare("SELECT * FROM voice_clones WHERE id = ? AND tenant = ?").bind(cloneId, auth.tenant).first();
    if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
    if (env.ELEVENLABS_API_KEY && row.external_id) {
      try {
        await fetch(`https://api.elevenlabs.io/v1/voices/${row.external_id}`, {
          method: "DELETE", headers: { "xi-api-key": env.ELEVENLABS_API_KEY }
        });
      } catch (_) {}
    }
    await env.ASTON_DB.prepare("DELETE FROM voice_clones WHERE id = ? AND tenant = ?").bind(cloneId, auth.tenant).run();
    await audit(env, auth.tenant, auth.actor, "voice.clone.delete", cloneId);
    return json({ ok: true, deleted: cloneId }, 200, cors);
  }

  if (method === "POST" && path === "/v1/voice/speak") {
    const auth = await authorized(request, env, "ai");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    const body = await readJson(request);
    let text = typeof body?.text === "string" ? body.text.trim() : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!text && !prompt) return json({ ok: false, error: "text_or_prompt_required" }, 400, cors);
    if (prompt && env.AI) {
      try {
        const model = body.llm_model || env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
        const response = await env.AI.run(model, {
          messages: [
            { role: "system", content: "Reply briefly in the same language. Max 2 sentences." },
            { role: "user", content: prompt }
          ]
        });
        text = typeof response === "string" ? response : (response?.response || String(response));
      } catch (e) {
        return json({ ok: false, error: "llm_failed", detail: String(e?.message || e).slice(0, 200) }, 502, cors);
      }
    }
    const provider = String(body?.provider || "cloudflare").toLowerCase();
    const speaker = String(body?.speaker || "luna");
    if (provider === "elevenlabs" || speaker.startsWith("clone:")) {
      if (!env.ELEVENLABS_API_KEY) return json({ ok: false, error: "elevenlabs_key_required" }, 503, cors);
      let voiceId = body?.external_id || body?.voice_id;
      if (speaker.startsWith("clone:") && env.ASTON_DB) {
        const row = await env.ASTON_DB.prepare(
          "SELECT external_id FROM voice_clones WHERE id = ? AND tenant = ?"
        ).bind(speaker.slice(6), auth.tenant).first();
        if (row?.external_id) voiceId = row.external_id;
      }
      if (!voiceId) return json({ ok: false, error: "voice_id_required" }, 400, cors);
      const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json", "accept": "audio/mpeg" },
        body: JSON.stringify({ text: String(text).slice(0, 5000), model_id: body?.model || "eleven_multilingual_v2" })
      });
      if (!elRes.ok) return json({ ok: false, error: "elevenlabs_tts_failed", detail: (await elRes.text()).slice(0, 300) }, 502, cors);
      const bytes = await elRes.arrayBuffer();
      const id = crypto.randomUUID();
      let stored = false;
      const r2Key = `${auth.tenant}/voice/${id}.mp3`;
      if (env.ASTON_R2) {
        try { await env.ASTON_R2.put(r2Key, bytes, { httpMetadata: { contentType: "audio/mpeg" } }); stored = true; } catch (_) {}
      }
      if (typeof trackUsage === "function") await trackUsage(env, auth.tenant, "voice.tts", 1);
      const payload = { ok: true, plugin: "voice", id, text: String(text).slice(0, 500), provider: "elevenlabs", voice_id: voiceId, size_bytes: bytes.byteLength, stored_in_r2: stored, r2_key: stored ? r2Key : null };
      if (body?.return_base64 === true || body?.return_base64 === "true") payload.audio_base64 = arrayBufferToBase64(bytes);
      return json(payload, 201, cors);
    }
    return json({ ok: false, error: "use_tts_for_cloudflare", hint: "POST /v1/voice/tts for Aura speakers, or provider=elevenlabs for clones" }, 400, cors);
  }

  return null;
}
