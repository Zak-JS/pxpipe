#!/usr/bin/env node
/**
 * Caveman prose-compressor eval harness.
 *
 * Run from the repo root with:   pnpm tsx eval/caveman/run.mjs
 * (tsx is required so the runner can import src/core/caveman.ts directly;
 * a built dist/core/caveman.js is used instead when present.)
 *
 * Per fixture: chars/tokens before+after, % reduction, a fact audit
 * (every fact string extracted from the ORIGINAL must appear verbatim in
 * the compressed output), and an idempotence check (compress twice, same
 * result). Writes results.json next to this script and prints a table.
 *
 * If the compressor is not built yet, the harness degrades to a self-test:
 * it audits the identity function (every fact of x must appear in x) and
 * additionally verifies the auditor CATCHES a planted deletion, so the
 * audit logic itself has a receipt before Worker A lands.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const resultsPath = join(here, 'results.json');

// Pass thresholds (documented in README.md).
const PROSE_MIN_TOKEN_REDUCTION = 0.15; // fixtures a-d
const CONTROL_MAX_TOKEN_REDUCTION = 0.02; // fixtures e-f
const CONTROL_FIXTURES = new Set(['e-code-control.txt', 'f-log-control.txt']);

// ---------------------------------------------------------------------------
// Compressor loading: prefer built dist, else import the TS source (needs tsx).
// ---------------------------------------------------------------------------

async function loadCompressor() {
  const distPath = join(here, '..', '..', 'dist', 'core', 'caveman.js');
  const srcPath = join(here, '..', '..', 'src', 'core', 'caveman.ts');
  for (const p of [distPath, srcPath]) {
    if (!existsSync(p)) continue;
    const mod = await import(p);
    const compressor = pickCompressor(mod);
    if (compressor) return { compressor, source: p };
    console.error(`Found ${p} but no ProseCompressor export (looked for a { id, compress } object or a compress function).`);
    process.exit(1);
  }
  return { compressor: null, source: null };
}

/** Accept either an exported ProseCompressor object or a bare compress(). */
function pickCompressor(mod) {
  const candidates = [mod.cavemanCompressor, mod.caveman, mod.default, mod.compressor, mod];
  for (const c of candidates) {
    if (c && typeof c.compress === 'function') {
      return (text) => normalizeResult(c.compress(text), text);
    }
  }
  if (typeof mod.compress === 'function') {
    return (text) => normalizeResult(mod.compress(text), text);
  }
  return null;
}

/** Contract says compress() returns ProseCompressionResult; tolerate a bare string. */
function normalizeResult(res, input) {
  if (typeof res === 'string') return res;
  if (res && typeof res.text === 'string') return res.text;
  throw new Error(`compress() returned neither string nor { text }: ${JSON.stringify(res)?.slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
// Fact extraction. Each class is (name, regex, optional filter). Classes may
// overlap; that is fine because the audit is a verbatim-inclusion check, not
// a positional one. Everything is extracted from the ORIGINAL text.
// ---------------------------------------------------------------------------

const FACT_CLASSES = [
  // URLs first (longest, most specific).
  ['url', /https?:\/\/[^\s)\]>"'`]+/g],
  // UUIDs (v4/v7 shapes).
  ['uuid', /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g],
  // Hex runs >= 6 chars containing at least one digit (avoids plain words like "deeded").
  ['hex', /\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{6,64}\b/g],
  // Semver, optionally with prerelease tag.
  ['semver', /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\b/g],
  // Numbers: integers with separators, decimals, percents, common unit suffixes.
  ['number', /\b\d[\d,]*(?:\.\d+)?\s?(?:%|ms|s\b|KB|MB|GB|k\b|x\b)?/g],
  // Dates (ISO-ish).
  ['date', /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g],
  // File paths: at least one slash, path-ish charset, not a URL fragment.
  ['path', /(?<!\/)\b(?:[.~]{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\b/g],
  // UPPER_SNAKE constants.
  ['upper_snake', /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g],
  // camelCase identifiers.
  ['camel', /\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g],
  // kebab-case identifiers (also catches package names, usernames minus the @).
  ['kebab', /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g],
  // Dotted identifiers / filenames / domains (both sides must start with a letter
  // or underscore, so sentence boundaries like "end. The" never match).
  ['dotted', /\b[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+\b/g],
  // Quoted strings and inline code spans.
  ['double_quoted', /"[^"\n]{1,120}"/g],
  ['single_quoted', /'[^'\n]{1,120}'/g],
  ['backtick', /`[^`\n]{1,200}`/g],
  // Capitalized multiword runs (proper names). KNOWN BLIND SPOT: also matches
  // capitalized sentence starts like "The catch"; see README.
  ['proper_name', /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g],
];

export function extractFacts(text) {
  const facts = new Map(); // fact string -> class of first extraction
  for (const [cls, re] of FACT_CLASSES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      let fact = m[0].trim();
      // URLs greedily grab trailing sentence punctuation; strip it.
      if (cls === 'url') fact = fact.replace(/[.,;:!?]+$/, '');
      if (fact.length < 2) continue; // single chars are noise, not facts
      if (!facts.has(fact)) facts.set(fact, cls);
    }
  }
  return facts;
}

export function auditFacts(original, compressed) {
  const facts = extractFacts(original);
  const misses = [];
  for (const [fact, cls] of facts) {
    if (!compressed.includes(fact)) misses.push({ class: cls, fact });
  }
  return { extracted: facts.size, misses };
}

// ---------------------------------------------------------------------------
// Auditor self-test: identity must audit clean, and a planted deletion must
// be caught. Run in both modes; it is cheap and keeps the audit honest.
// ---------------------------------------------------------------------------

function auditorSelfTest(fixtures) {
  let extractedTotal = 0;
  for (const { name, text } of fixtures) {
    const { extracted, misses } = auditFacts(text, text);
    extractedTotal += extracted;
    if (misses.length > 0) {
      console.error(`SELF-TEST FAIL: identity audit missed ${misses.length} facts in ${name}:`);
      for (const m of misses.slice(0, 5)) console.error(`  [${m.class}] ${m.fact}`);
      return false;
    }
  }
  // Negative control: delete a known fact, auditor must flag it.
  const guinea = fixtures[0];
  const planted = 'https://nodejs.org/api/worker_threads.html';
  if (!guinea.text.includes(planted)) {
    console.error(`SELF-TEST FAIL: negative-control fact not present in ${guinea.name}`);
    return false;
  }
  const mutilated = guinea.text.split(planted).join('');
  const { misses } = auditFacts(guinea.text, mutilated);
  if (!misses.some((m) => m.fact === planted)) {
    console.error('SELF-TEST FAIL: auditor did not catch a planted deletion');
    return false;
  }
  console.log(`Auditor self-test PASS: ${extractedTotal} facts extracted across ${fixtures.length} fixtures, identity audits clean, planted deletion caught (${misses.length} miss${misses.length === 1 ? '' : 'es'} flagged).`);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const fixtures = readdirSync(fixturesDir)
  .filter((f) => /\.(txt|md)$/.test(f))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(fixturesDir, name), 'utf8') }));

if (fixtures.length === 0) {
  console.error(`No fixtures found in ${fixturesDir}`);
  process.exit(1);
}

const { compressor, source } = await loadCompressor();

if (!compressor) {
  console.log('compressor not built yet (no src/core/caveman.ts or dist/core/caveman.js) — running auditor self-test against the identity function instead.\n');
  process.exit(auditorSelfTest(fixtures) ? 0 : 1);
}

console.log(`Compressor loaded from ${source}\n`);
if (!auditorSelfTest(fixtures)) process.exit(1);
console.log('');

const rows = [];
let anyFail = false;

for (const { name, text } of fixtures) {
  const isControl = CONTROL_FIXTURES.has(name);
  const out = compressor(text);
  const out2 = compressor(out);

  const charsBefore = text.length;
  const charsAfter = out.length;
  const tokensBefore = countTokens(text);
  const tokensAfter = countTokens(out);
  const tokenReduction = tokensBefore === 0 ? 0 : (tokensBefore - tokensAfter) / tokensBefore;

  const { extracted, misses } = auditFacts(text, out);
  const idempotent = out2 === out;

  const reductionOk = isControl
    ? tokenReduction <= CONTROL_MAX_TOKEN_REDUCTION
    : tokenReduction >= PROSE_MIN_TOKEN_REDUCTION;
  const pass = misses.length === 0 && idempotent && reductionOk;
  if (!pass) anyFail = true;

  rows.push({
    fixture: name,
    control: isControl,
    charsBefore,
    charsAfter,
    tokensBefore,
    tokensAfter,
    tokenReductionPct: +(tokenReduction * 100).toFixed(1),
    factsExtracted: extracted,
    factMisses: misses,
    idempotent,
    pass,
  });

  if (misses.length > 0) {
    console.error(`FACT AUDIT FAILURES in ${name} (${misses.length}):`);
    for (const m of misses) console.error(`  [${m.class}] ${JSON.stringify(m.fact)}`);
  }
  if (!idempotent) console.error(`IDEMPOTENCE FAILURE in ${name}: second pass changed the output.`);
}

writeFileSync(resultsPath, JSON.stringify({ generatedAt: new Date().toISOString(), compressor: source, rows }, null, 2) + '\n');

// Summary table.
const header = ['fixture', 'chars', 'tokens', 'tok reduction', 'facts', 'misses', 'idem', 'pass'];
const table = rows.map((r) => [
  r.fixture,
  `${r.charsBefore}→${r.charsAfter}`,
  `${r.tokensBefore}→${r.tokensAfter}`,
  `${r.tokenReductionPct}%${r.control ? ' (ctl)' : ''}`,
  String(r.factsExtracted),
  String(r.factMisses.length),
  r.idempotent ? 'yes' : 'NO',
  r.pass ? 'PASS' : 'FAIL',
]);
const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ');
console.log('\n' + fmt(header));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const row of table) console.log(fmt(row));

console.log(`\nResults written to ${resultsPath}`);
process.exit(anyFail ? 1 : 0);
