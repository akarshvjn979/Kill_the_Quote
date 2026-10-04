// Vercel Function (web-standard Request/Response): holds the AI key on the server and streams the reply back.
// Switch provider with the AI_PROVIDER environment variable: "anthropic" (default), "gemini" or "openai".
// The browser always receives Anthropic-style stream events, so index.html never changes.

const PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
const MODELS = {
  anthropic: { quick: process.env.MODEL_QUICK || "claude-haiku-4-5-20251001", default: process.env.MODEL_DEFAULT || "claude-sonnet-5-5" },
  gemini: { quick: process.env.GEMINI_MODEL_QUICK || "gemini-3.1-flash-lite", default: process.env.GEMINI_MODEL_DEFAULT || "gemini-3.5-flash" },
  openai: { quick: process.env.OPENAI_MODEL_QUICK || "gpt-5.4-nano", default: process.env.OPENAI_MODEL_DEFAULT || "gpt-5.4-mini" },
};

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const sse = (obj) => "event: " + obj.type + "\ndata: " + JSON.stringify(obj) + "\n\n";

export async function POST(req) {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const pass = req.headers.get("x-app-passcode") || "";
  if (!process.env.APP_PASSCODE || pass !== process.env.APP_PASSCODE) return json(401, { error: "Wrong passcode" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Bad JSON" }); }
  if (body.ping) return json(200, { ok: true, provider: PROVIDER });

  const tier = body.tier === "quick" ? "quick" : "default";
  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  if (!messages.length || messages[messages.length - 1].role !== "user") return json(400, { error: "Last message must be from the user" });
  const images = Array.isArray(body.images) ? body.images.slice(0, 5) : [];

  if (PROVIDER === "gemini") return gemini(body, tier, messages, images);
  if (PROVIDER === "openai") return openai(body, tier, messages, images);
  return anthropic(body, tier, messages, images);
}

async function anthropic(body, tier, messages, images) {
  if (!process.env.ANTHROPIC_API_KEY) return json(500, { error: "ANTHROPIC_API_KEY is not set in Vercel" });
  const msgs = messages.map((m, i) =>
    i === messages.length - 1 && images.length
      ? { role: "user", content: [...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })), { type: "text", text: String(m.content) }] }
      : { role: m.role, content: String(m.content) });
  const up = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELS.anthropic[tier], max_tokens: tier === "quick" ? 4096 : 16000, stream: true, ...(body.system ? { system: String(body.system) } : {}), messages: msgs }),
  });
  if (!up.ok) return upstreamError(up);
  return new Response(up.body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

async function gemini(body, tier, messages, images) {
  if (!process.env.GEMINI_API_KEY) return json(500, { error: "GEMINI_API_KEY is not set in Vercel" });
  const contents = messages.map((m, i) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [
      ...(i === messages.length - 1 ? images.map((im) => ({ inlineData: { mimeType: im.media_type, data: im.data } })) : []),
      { text: String(m.content) },
    ],
  }));
  const wantsJson = !!body.system && /json/i.test(body.system);
  const up = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini[tier]}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      contents,
      ...(body.system ? { systemInstruction: { parts: [{ text: String(body.system) }] } } : {}),
      generationConfig: { maxOutputTokens: tier === "quick" ? 8192 : 32768, ...(wantsJson ? { responseMimeType: "application/json" } : {}) },
    }),
  });
  if (!up.ok) return upstreamError(up);

  // Translate Gemini's stream into the Anthropic-style events the page already understands.
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "", finish = null, usage = null;
  const model = MODELS.gemini[tier];
  const out = new TransformStream({
    start(ctl) { ctl.enqueue(enc.encode(sse({ type: "message_start", message: { model } }))); },
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, k); buf = buf.slice(k + 2);
        const line = ev.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
        if (d.error) { ctl.enqueue(enc.encode(sse({ type: "error", error: { type: "api_error", message: d.error.message } }))); continue; }
        const cand = d.candidates && d.candidates[0];
        for (const p of (cand && cand.content && cand.content.parts) || []) {
          if (p.text && !p.thought) ctl.enqueue(enc.encode(sse({ type: "content_block_delta", delta: { type: "text_delta", text: p.text } })));
        }
        if (cand && cand.finishReason) finish = cand.finishReason;
        if (d.usageMetadata) usage = d.usageMetadata;
      }
    },
    flush(ctl) {
      ctl.enqueue(enc.encode(sse({ type: "message_delta", delta: { stop_reason: finish === "MAX_TOKENS" ? "max_tokens" : "end_turn" },
        ...(usage ? { usage: { input_tokens: usage.promptTokenCount || 0, output_tokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0) } } : {}) })));
      ctl.enqueue(enc.encode(sse({ type: "message_stop" })));
    },
  });
  return new Response(up.body.pipeThrough(out), { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

async function openai(body, tier, messages, images) {
  if (!process.env.OPENAI_API_KEY) return json(500, { error: "OPENAI_API_KEY is not set in Vercel" });
  const model = MODELS.openai[tier];
  const msgs = [
    ...(body.system ? [{ role: "system", content: String(body.system) }] : []),
    ...messages.map((m, i) =>
      i === messages.length - 1 && images.length
        ? { role: "user", content: [{ type: "text", text: String(m.content) }, ...images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.media_type};base64,${im.data}` } }))] }
        : { role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }),
  ];
  const wantsJson = !!body.system && /json/i.test(body.system);
  const up = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      model, messages: msgs, stream: true, stream_options: { include_usage: true },
      max_completion_tokens: tier === "quick" ? 8192 : 32768,
      reasoning_effort: process.env.OPENAI_REASONING || (tier === "quick" ? "none" : "low"),
      ...(wantsJson ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!up.ok) return upstreamError(up);

  // Translate OpenAI's stream into the Anthropic-style events the page already understands.
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "", finish = null, usage = null;
  const out = new TransformStream({
    start(ctl) { ctl.enqueue(enc.encode(sse({ type: "message_start", message: { model } }))); },
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, k); buf = buf.slice(k + 2);
        const line = ev.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let d; try { d = JSON.parse(payload); } catch { continue; }
        if (d.error) { ctl.enqueue(enc.encode(sse({ type: "error", error: { type: "api_error", message: d.error.message } }))); continue; }
        const ch = d.choices && d.choices[0];
        if (ch && ch.delta && ch.delta.content) ctl.enqueue(enc.encode(sse({ type: "content_block_delta", delta: { type: "text_delta", text: ch.delta.content } })));
        if (ch && ch.finish_reason) finish = ch.finish_reason;
        if (d.usage) usage = d.usage;
      }
    },
    flush(ctl) {
      ctl.enqueue(enc.encode(sse({ type: "message_delta", delta: { stop_reason: finish === "length" ? "max_tokens" : "end_turn" },
        ...(usage ? { usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } } : {}) })));
      ctl.enqueue(enc.encode(sse({ type: "message_stop" })));
    },
  });
  return new Response(up.body.pipeThrough(out), { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

async function upstreamError(up) {
  let msg = "Upstream error " + up.status;
  try { const e = await up.json(); msg = (e.error && e.error.message) || msg; } catch {}
  return json(up.status === 429 || up.status === 529 ? 429 : up.status === 413 ? 413 : 502, { error: msg });
}
