// cli.mjs — the thin ClearMind runner.
//
// Proves the signal-driven fog→crossing loop end to end, in the terminal, before
// any UI exists. Reads the ICM folders LIVE (via assembleSystemPrompt), assembles
// the system prompt, and drives a real Anthropic Messages API session with raw
// fetch — no SDK, no node_modules. The Cloudflare Worker uses the identical request
// shape, so a clean run here is a clean run of the Worker's core call.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node runner/cli.mjs                 # interactive
//   ANTHROPIC_API_KEY=sk-... node runner/cli.mjs --script gate/fog-to-crossing.json
//
// Env:
//   ANTHROPIC_API_KEY   required
//   CLEARMIND_MODEL     optional, defaults to claude-sonnet-4-6 (flip to claude-opus-4-8 for max quality)

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleSystemPrompt } from '../scripts/build-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLEARMIND_MODEL || 'claude-sonnet-4-6';
const SYSTEM_PROMPT = assembleSystemPrompt();

if (!API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY. Set it in the environment and retry.');
  process.exit(1);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;

// One streamed assistant turn. Prints text deltas live, returns the full text.
async function streamTurn(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages,
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  let text = '';
  let usage = null;
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        process.stdout.write(evt.delta.text);
        text += evt.delta.text;
      } else if (evt.type === 'message_start' && evt.message?.usage) {
        usage = evt.message.usage;
      } else if (evt.type === 'message_delta' && evt.usage) {
        usage = { ...(usage || {}), ...evt.usage };
      } else if (evt.type === 'error') {
        throw new Error(`stream error: ${JSON.stringify(evt.error)}`);
      }
    }
  }
  process.stdout.write('\n');
  return { text, usage };
}

// Pull the crossing document out of a ```crossing fenced block, if present.
function extractCrossing(text) {
  const m = text.match(/```crossing\s*\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

function renderCrossingCard(doc) {
  const line = '─'.repeat(60);
  console.log('\n' + amber('┌' + line + '┐'));
  console.log(amber('│') + '  ' + cyan('YOUR CROSSING DOCUMENT') + '  (savable / printable)');
  console.log(amber('├' + line + '┤'));
  for (const l of doc.split('\n')) console.log(amber('│') + '  ' + l);
  console.log(amber('└' + line + '┘') + '\n');
}

function checkLeak(text) {
  // The machinery must never be named to the person. Belt-and-suspenders monitor.
  const banned = /\bOOCEMR\b|\b10-?10-?10\b|coaching (framework|habit)|the (Outcomes|Options|Consequences|Orientation|Formation|Fog) (step|stage|movement)/i;
  return banned.test(text) ? text.match(banned)[0] : null;
}

async function runConversation(getUserTurn) {
  const messages = [];
  console.log(cyan('\n  ClearMind: The Other Side') + dim('  —  a calmer way through\n'));
  console.log(dim(`  model: ${MODEL}  ·  type what's weighing on you  ·  Ctrl-C to leave\n`));

  let leaked = false;
  let crossed = false;

  while (true) {
    const user = await getUserTurn();
    if (user === null) break;
    if (!user.trim()) continue;
    messages.push({ role: 'user', content: user });

    process.stdout.write(cyan('\n  ') );
    let result;
    try {
      result = await streamTurn(messages);
    } catch (e) {
      console.error('\n' + amber('  [error] ') + e.message);
      break;
    }
    messages.push({ role: 'assistant', content: result.text });

    const leak = checkLeak(result.text);
    if (leak) { leaked = true; console.log(dim(`\n  [monitor] machinery name leaked: "${leak}"`)); }

    const crossing = extractCrossing(result.text);
    if (crossing) { crossed = true; renderCrossingCard(crossing); }

    if (result.usage) {
      const u = result.usage;
      console.log(dim(`  [usage] in ${u.input_tokens ?? '?'} · cache_read ${u.cache_read_input_tokens ?? 0} · out ${u.output_tokens ?? '?'}`));
    }
  }
  return { leaked, crossed };
}

// ---- entry ----
const scriptArgIdx = process.argv.indexOf('--script');
if (scriptArgIdx !== -1) {
  // Scripted mode: play a fixed sequence of user turns (for the build-complete gate).
  const scriptPath = resolve(process.argv[scriptArgIdx + 1]);
  const turns = JSON.parse(readFileSync(scriptPath, 'utf8')).turns;
  let i = 0;
  const getUserTurn = async () => {
    if (i >= turns.length) return null;
    const t = turns[i++];
    console.log('\n' + dim('  you ▸ ') + t);
    return t;
  };
  const { leaked, crossed } = await runConversation(getUserTurn);
  const isCrisis = /crisis/i.test(scriptPath);
  console.log('\n' + '═'.repeat(64));
  console.log('  GATE RESULT');
  console.log(`   machinery name leaked to user : ${leaked ? 'YES ✗' : 'no ✓'}`);
  if (isCrisis) {
    console.log(`   crisis script → produced artifact (should NOT): ${crossed ? 'YES ✗' : 'no ✓'}`);
  } else {
    console.log(`   crossing document produced     : ${crossed ? 'yes ✓' : 'NO ✗'}`);
  }
  console.log('═'.repeat(64));
} else {
  // Interactive mode.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const getUserTurn = () => new Promise((res) => rl.question(dim('\n  you ▸ '), (a) => res(a)));
  rl.on('close', () => process.exit(0));
  await runConversation(getUserTurn);
  rl.close();
}
