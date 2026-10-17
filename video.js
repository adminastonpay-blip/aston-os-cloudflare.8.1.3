// ASTON AI Video — text-to-video + image-to-video (v8.12.0)
// Models: alibaba/wan-3.0 (t2v), alibaba/wan-2.7-i2v (i2v)
// Routes: POST /v1/ai/video, GET /v1/ai/video/models

const DEFAULT_T2V = "alibaba/wan-3.0";
const DEFAULT_I2V = "alibaba/wan-2.7-i2v";
const RESOLUTIONS = new Set(["480P", "720P", "1080P"]);
const RATIOS = new Set(["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4"]);

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function extractVideoPayload(aiResult) {
  if (aiResult && typeof aiResult === "object") {
    const url = aiResult.video || aiResult.result?.video || aiResult.url || aiResult.result?.url || null;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      return { kind: "url", video_url: url, contentType: "video/mp4" };
    }
    if (typeof aiResult.video_base64 === "string") {
      const binary = atob(aiResult.video_base64.replace(/^data:video\/\w+;base64,/, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { kind: "bytes", bytes: bytes.buffer, contentType: "video/mp4" };
    }
  }
  if (typeof aiResult === "string") {
    if (/^https?:\/\//i.test(aiResult)) return { kind: "url", video_url: aiResult, contentType: "video/mp4" };
    if (aiResult.length > 64) {
      try {
        const binary = atob(aiResult.replace(/^data:video\/\w+;base64,/, ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return { kind: "bytes", bytes: bytes.buffer, contentType: "video/mp4" };
      } catch { /* fall through */ }
    }
  }
  if (aiResult instanceof ReadableStream || (aiResult && typeof aiResult.getReader === "function")) {
    const resp = new Response(aiResult);
    const buf = await resp.arrayBuffer();
    return { kind: "bytes", bytes: buf, contentType: resp.headers.get("content-type") || "video/mp4" };
  }
  if (aiResult instanceof ArrayBuffer) return { kind: "bytes", bytes: aiResult, contentType: "video/mp4" };
  if (aiResult instanceof Uint8Array) return { kind: "bytes", bytes: aiResult.buffer, contentType: "video/mp4" };
  return null;
}

export async function handleVideo(request, env, path, method, url, cors, helpers) {
  const { json, authorized, ensureSchema, audit, trackUsage, readJson } = helpers;

  if (method === "GET" && path === "/v1/ai/video/models") {
    return json({
      ok: true, plugin: "ai-video",
      models: [
        { id: DEFAULT_T2V, mode: "text-to-video", resolutions: ["480P", "720P", "1080P"], ratios: [...RATIOS], duration_sec: { min: 1, max: 15, default: 5 } },
        { id: DEFAULT_I2V, mode: "image-to-video", resolutions: ["720P", "1080P"], duration_sec: { min: 2, max: 15, default: 5 }, requires: ["image_url or image_base64"] }
      ],
      note: "Requires Workers AI binding. Third-party models may need account enablement."
    }, 200, cors);
  }

  if (method === "POST" && path === "/v1/ai/video") {
    const auth = await authorized(request, env, "ai");
    if (!auth) return json({ ok: false, error: "unauthorized" }, 401, cors);
    if (!env.AI) return json({ ok: false, error: "plugin_inactive", plugin: "ai-video", missing_bindings: ["AI"] }, 503, cors);

    const body = await readJson(request);
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const imageUrl = typeof body?.image_url === "string" ? body.image_url.trim() : "";
    const imageBase64 = typeof body?.image_base64 === "string" ? body.image_base64 : "";
    const mode = imageUrl || imageBase64 ? "image-to-video" : "text-to-video";

    if (mode === "text-to-video" && !prompt) return json({ ok: false, error: "prompt_required" }, 400, cors);
    if (prompt.length > 2500) return json({ ok: false, error: "prompt_too_long", max: 2500 }, 400, cors);

    const model = (typeof body?.model === "string" && body.model.trim()) || env.AI_VIDEO_MODEL || (mode === "image-to-video" ? DEFAULT_I2V : DEFAULT_T2V);
    let resolution = String(body?.resolution || (mode === "image-to-video" ? "720P" : "480P")).toUpperCase();
    if (resolution === "480") resolution = "480P";
    if (resolution === "720") resolution = "720P";
    if (resolution === "1080") resolution = "1080P";
    if (!RESOLUTIONS.has(resolution)) return json({ ok: false, error: "invalid_resolution", allowed: [...RESOLUTIONS] }, 400, cors);

    let ratio = String(body?.ratio || "adaptive");
    if (!RATIOS.has(ratio)) return json({ ok: false, error: "invalid_ratio", allowed: [...RATIOS] }, 400, cors);
    const duration = Math.max(1, Math.min(15, Number(body?.duration) || 5));

    const input = { prompt: prompt || "Animate this scene smoothly" };
    if (mode === "text-to-video") {
      input.resolution = resolution; input.ratio = ratio; input.duration = duration;
    } else {
      input.resolution = resolution === "480P" ? "720P" : resolution;
      input.duration = Math.max(2, duration);
      if (imageUrl) input.image = imageUrl;
      else if (imageBase64) input.image = imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}`;
      if (typeof body?.negative_prompt === "string") input.negative_prompt = body.negative_prompt.slice(0, 500);
    }

    try {
      const aiResult = await env.AI.run(model, input);
      const extracted = await extractVideoPayload(aiResult);
      if (!extracted) {
        return json({
          ok: false, error: "unexpected_ai_video_format",
          detail: "Model returned an unrecognized payload",
          raw_keys: aiResult && typeof aiResult === "object" ? Object.keys(aiResult).slice(0, 20) : [],
          hint: "Model may not be enabled on this account"
        }, 502, cors);
      }

      const id = crypto.randomUUID();
      let stored = false, r2Key = null, sizeBytes = null;
      let videoUrl = extracted.kind === "url" ? extracted.video_url : null;
      let contentType = extracted.contentType || "video/mp4";

      if (extracted.kind === "bytes" && env.ASTON_R2) {
        r2Key = `${auth.tenant}/videos/${id}.mp4`;
        sizeBytes = extracted.bytes.byteLength;
        try {
          await env.ASTON_R2.put(r2Key, extracted.bytes, {
            httpMetadata: { contentType },
            customMetadata: { tenant: auth.tenant, model, prompt: (prompt || "").slice(0, 500), mode }
          });
          stored = true;
        } catch (e) { console.error("R2 video put failed", e?.message || e); }
      }

      if (extracted.kind === "url" && env.ASTON_R2 && body?.mirror_to_r2 === true) {
        try {
          const remote = await fetch(extracted.video_url);
          if (remote.ok) {
            const buf = await remote.arrayBuffer();
            r2Key = `${auth.tenant}/videos/${id}.mp4`;
            sizeBytes = buf.byteLength;
            contentType = remote.headers.get("content-type") || "video/mp4";
            await env.ASTON_R2.put(r2Key, buf, { httpMetadata: { contentType }, customMetadata: { tenant: auth.tenant, model } });
            stored = true;
          }
        } catch (e) { console.error("mirror video failed", e?.message || e); }
      }

      if (env.ASTON_DB) {
        try {
          if (typeof ensureSchema === "function") await ensureSchema(env.ASTON_DB);
          await env.ASTON_DB.prepare(
            "INSERT INTO media (id, tenant, kind, prompt, model, r2_key, content_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(id, auth.tenant, "video", (prompt || imageUrl || "i2v").slice(0, 2000), model, stored ? r2Key : null, contentType, sizeBytes, new Date().toISOString()).run();
        } catch (e) { console.error("media video insert failed", e?.message || e); }
      }

      if (typeof trackUsage === "function") await trackUsage(env, auth.tenant, "ai.video", 1);
      if (typeof audit === "function") await audit(env, auth.tenant, auth.actor, "ai.video", `${model}:${id}`);

      const responsePayload = {
        ok: true, id, plugin: "ai-video", mode, model,
        prompt: (prompt || "").slice(0, 200),
        resolution: input.resolution, duration: input.duration,
        content_type: contentType, size_bytes: sizeBytes,
        video_url: videoUrl, stored_in_r2: stored, r2_key: stored ? r2Key : null
      };
      if (extracted.kind === "bytes" && (body?.return_base64 === true || body?.return_base64 === "true")) {
        if (extracted.bytes.byteLength <= 6 * 1024 * 1024) responsePayload.video_base64 = arrayBufferToBase64(extracted.bytes);
        else { responsePayload.base64_skipped = true; responsePayload.hint = "Video too large for base64"; }
      }
      return json(responsePayload, 201, cors);
    } catch (e) {
      return json({
        ok: false, error: "video_generation_failed", detail: String(e?.message || e).slice(0, 400), model,
        hint: "Enable the video model on Cloudflare AI, or try 480P / shorter duration."
      }, 502, cors);
    }
  }
  return null;
}
