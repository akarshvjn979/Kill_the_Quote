// Vercel Edge Function: keeps the Anthropic API key on the server and streams the reply back.
export const config = { runtime: "edge" };

const MODELS = {
  quick: process.env.MODEL_QUICK || "claude-haiku-4-5-20251001",
  default: process.env.MODEL_DEFAULT || "claude-sonnet-5-5",
};
const MAX_TOKENS = { quick: 4096, default: 16000 };

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const pass = req.headers.get("x-app-passcode") || "";
  if (!process.env.APP_PASSCODE || pass !== process.env.APP_PASSCODE) return json(401, { error: "Wrong passcode" });
  if (!process.env.ANTHROPIC_API_KEY) return json(500, { error: "ANTHROPIC_API_KEY is not set in Vercel" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Bad JSON" }); }
  if (body.ping) return json(200, { ok: true });

  const tier = body.tier === "quick" ? "quick" : "default";
  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  if (!messages.length || messages[messages.length - 1].role !== "user") return json(400, { error: "Last message must be from the user" });

  // Attach images (photos / scanned pages) to the final user turn.
  const msgs = messages.map((m, i) => {
    if (i !== messages.length - 1 || !Array.isArray(body.images) || !body.images.length) return { role: m.role, content: String(m.content) };
    return {
      role: "user",
      content: [
        ...body.images.slice(0, 5).map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
        { type: "text", text: String(m.content) },
      ],
    };
  });

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODELS[tier],
      max_tokens: MAX_TOKENS[tier],
      stream: true,
      ...(body.system ? { system: String(body.system) } : {}),
      messages: msgs,
    }),
  });

  if (!upstream.ok) {
    let msg = "Upstream error " + upstream.status;
    try { msg = (await upstream.json()).error?.message || msg; } catch {}
    return json(upstream.status === 429 || upstream.status === 529 ? 429 : upstream.status === 413 ? 413 : 502, { error: msg });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
