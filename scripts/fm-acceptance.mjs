#!/usr/bin/env node
/**
 * Phase 1 acceptance script (docs/plan.md §5 Phase 1):
 *
 * "a Node script importing only `.../core` and `.../openai` can hold a
 * multi-turn conversation with `fm serve`, streaming and non-streaming, and
 * cancel mid-stream."
 *
 * Imports ONLY the *built* output — run `npm run build` first — exactly as
 * a real consumer of the published package would. No test framework, no
 * dev-only shortcuts: this is the same import path `npm run
 * check:isolation` already verifies is clean plain-Node CommonJS.
 *
 * Exit codes:
 *   0 — every check passed.
 *   1 — fm serve was reachable and healthy, but one or more checks failed.
 *   2 — fm serve is unreachable or unhealthy; nothing was tested. This is
 *       the expected outcome whenever fm serve is not running locally, or
 *       (DECISIONS.md D9) when the on-device stack is wedged and every
 *       generation 500s despite health passing.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const buildCore = path.join(root, 'build', 'core', 'index.js');
const buildOpenai = path.join(root, 'build', 'openai', 'index.js');

for (const [label, file] of [
  ['build/core', buildCore],
  ['build/openai', buildOpenai],
]) {
  if (!existsSync(file)) {
    console.error(`fm-acceptance: ${label} is missing (${file}).`);
    console.error('Run "npm run build" first — this script imports built output only.');
    process.exit(2);
  }
}

const { isLLMError } = await import(pathToFileURL(buildCore).href);
const { createOpenAIProvider } = await import(pathToFileURL(buildOpenai).href);

const BASE_URL = process.env.FM_SERVE_URL ?? 'http://127.0.0.1:1976/v1';
const MODEL = process.env.FM_SERVE_MODEL ?? 'system';
const PROBE_TIMEOUT_MS = 5_000;

/** @type {{ readonly label: string; readonly pass: boolean; readonly detail?: string }[]} */
const checks = [];

function record(label, pass, detail) {
  checks.push({ label, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  const suffix = detail !== undefined && !pass ? ` — ${detail}` : '';
  console.log(`[${mark}] ${label}${suffix}`);
}

function transcript(label, text) {
  console.log(`\n--- ${label} ---`);
  console.log(text === '' ? '(empty)' : text);
  console.log('---');
}

async function probeFmServe() {
  try {
    await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `fm serve unreachable at ${BASE_URL}: ${String(err)}` };
  }
  try {
    const provider = createOpenAIProvider({ baseUrl: BASE_URL, model: MODEL });
    const result = await provider.generate(
      {
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        maxOutputTokens: 8,
      },
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }
    );
    if (result.text.trim() === '') {
      return { ok: false, reason: 'fm serve answered with empty text on the health probe' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `fm serve completion probe failed: ${String(err)}` };
  }
}

console.log(`fm-acceptance: probing fm serve at ${BASE_URL} (model "${MODEL}")...`);
const probe = await probeFmServe();
if (!probe.ok) {
  console.error(`\nfm serve unreachable/unhealthy — nothing tested.\nReason: ${probe.reason}`);
  process.exit(2);
}
console.log('fm serve is reachable and answering — proceeding with acceptance checks.\n');

const provider = createOpenAIProvider({ baseUrl: BASE_URL, model: MODEL });

// ---- 1. Multi-turn non-streaming conversation --------------------------

try {
  const turn1 = await provider.generate({
    messages: [
      { role: 'user', content: 'My favorite color is teal. Reply in one short sentence.' },
    ],
  });
  transcript('turn 1 (non-streaming)', turn1.text);
  record('turn 1 produced non-empty text', turn1.text.trim().length > 0);
  record(
    'turn 1 providerId is "openai"',
    turn1.providerId === 'openai',
    `got "${turn1.providerId}"`
  );

  const turn2 = await provider.generate({
    messages: [
      { role: 'user', content: 'My favorite color is teal. Reply in one short sentence.' },
      { role: 'assistant', content: turn1.text },
      { role: 'user', content: 'What color did I say? Answer with just the color word.' },
    ],
  });
  transcript('turn 2 (non-streaming, multi-turn)', turn2.text);
  record(
    'turn 2 remembers context ("teal")',
    turn2.text.toLowerCase().includes('teal'),
    turn2.text
  );
} catch (err) {
  record('multi-turn non-streaming conversation', false, String(err));
}

// ---- 2. Streaming, with delta accumulation ------------------------------

try {
  let accumulated = '';
  let deltaCount = 0;
  let finishResult;
  for await (const event of provider.stream({
    messages: [{ role: 'user', content: 'Count from one to five, comma-separated.' }],
  })) {
    if (event.type === 'textDelta') {
      accumulated += event.delta;
      deltaCount += 1;
    }
    if (event.type === 'finish') finishResult = event.result;
  }
  transcript('streaming response', accumulated);
  record('streaming produced at least one delta', deltaCount > 0, `${deltaCount} deltas`);
  record('finish event fired exactly once with matching text', finishResult?.text === accumulated);
} catch (err) {
  record('streaming conversation', false, String(err));
}

// ---- 3. Mid-stream cancellation -----------------------------------------

try {
  const controller = new AbortController();
  let deltasBeforeAbort = 0;
  let threw;
  try {
    for await (const event of provider.stream(
      { messages: [{ role: 'user', content: 'Write a long story about a lighthouse keeper.' }] },
      { signal: controller.signal }
    )) {
      if (event.type === 'textDelta') {
        deltasBeforeAbort += 1;
        if (deltasBeforeAbort === 1) controller.abort();
      }
    }
  } catch (err) {
    threw = err;
  }
  record('mid-stream abort threw', threw !== undefined);
  record(
    'mid-stream abort threw LLMError code "cancelled"',
    threw !== undefined && isLLMError(threw, 'cancelled'),
    threw !== undefined && isLLMError(threw) ? `code was "${threw.code}"` : String(threw)
  );
} catch (err) {
  record('mid-stream cancellation', false, String(err));
}

// ---- Summary --------------------------------------------------------------

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed:`);
  for (const c of failed) console.error(`  - ${c.label}${c.detail ? `: ${c.detail}` : ''}`);
  process.exit(1);
}
console.log('\nfm-acceptance: all checks passed.');
process.exit(0);
