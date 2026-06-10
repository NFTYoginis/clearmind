// ClearMind Worker — thin streaming proxy with server-side key + budget/abuse guards.
//
// The browser holds the transcript and POSTs the full message history each turn to
// /api/chat. The Worker injects the cached system prompt (the assembled ICM repo) and
// the ANTHROPIC_API_KEY secret, enforces guards, and streams Claude's reply back. The
// API key is NEVER sent to or reachable by the client.
//
// Regenerate the bundled system prompt after editing any ICM file:
//   node ../scripts/build-prompt.mjs   (writes src/system-prompt.generated.js)

import { SYSTEM_PROMPT } from './system-prompt.generated.js';

// ---- budget / abuse guards (public no-account tool = we pay per session) ----
const MAX_MESSAGES = 48;      // ~24 exchanges; the crossing almost always lands well before this
const MAX_MSG_CHARS = 4000;   // per single user message (anti prompt-stuffing)
const MAX_TOTAL_CHARS = 30000;// whole transcript (caps per-session context cost)
const MAX_TOKENS = 2048;      // per response

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') return json({ error: 'method', message: 'POST only.' }, 405);
      return handleChat(request, env);
    }

    // Everything else is the static no-account UI.
    return env.ASSETS.fetch(request);
  },
};

async function handleChat(request, env) {
  // 1) Per-IP rate limit (native [[ratelimits]] binding).
  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  try {
    const { success } = await env.CHAT_RL.limit({ key: ip });
    if (!success) {
      return json(
        { error: 'rate_limit', message: 'A lot of requests just now — give it a few seconds and try again.' },
        429,
      );
    }
  } catch (_) {
    // If the binding is unavailable (e.g. local dev without it), fail open — guards below still apply.
  }

  // 2) Parse + validate the transcript the client sent.
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'bad_request', message: 'Could not read the request.' }, 400);
  }

  const raw = Array.isArray(body?.messages) ? body.messages : null;
  if (!raw || raw.length === 0) {
    return json({ error: 'bad_request', message: 'No conversation to continue.' }, 400);
  }
  if (raw.length > MAX_MESSAGES) {
    return json({
      error: 'session_limit',
      message:
        "We've gone a long way around this together. If the crossing hasn't landed yet, it can help to take a breath and start fresh — sometimes the clearest version comes on the second pass.",
    }, 200);
  }

  // Accept only user/assistant string turns. The server owns the system prompt —
  // any client-supplied system/other role is dropped.
  const messages = [];
  let total = 0;
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content) continue;
    if (m.role === 'user' && content.length > MAX_MSG_CHARS) {
      return json({
        error: 'too_long',
        message: "That's a lot to take in at once — try giving me the most pressing piece first.",
      }, 200);
    }
    total += content.length;
    messages.push({ role: m.role, content });
  }
  if (total > MAX_TOTAL_CHARS) {
    return json({
      error: 'session_limit',
      message:
        "We've covered a lot. If it still feels unresolved, starting a fresh pass on just the heaviest piece often gets there faster.",
    }, 200);
  }
  if (messages.length === 0 || messages[0].role !== 'user') {
    return json({ error: 'bad_request', message: 'Start by telling me what is weighing on you.' }, 400);
  }

  // 3) Call Claude with the cached system prompt, streamed. Same request shape the
  //    thin runner proved. Key stays server-side.
  const model = env.CLEARMIND_MODEL || 'claude-sonnet-4-6';
  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        // Stable, byte-identical prefix across all users/turns → cached (~0.1x on reads).
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages,
        stream: true,
      }),
    });
  } catch (_) {
    return json({ error: 'upstream', message: "I couldn't reach my own thoughts just then — try once more." }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const status = upstream.status === 429 ? 429 : 502;
    const message =
      upstream.status === 429
        ? 'A lot of people are thinking things through right now — give it a moment and try again.'
        : "Something went wrong on my end. Give it another try in a moment.";
    return json({ error: 'upstream', message }, status);
  }

  // 4) Stream the SSE straight back to the browser (the UI filters for text deltas
  //    and the crossing block). No buffering — calm, gradual delivery.
  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-clearmind-model': model,
    },
  });
}
