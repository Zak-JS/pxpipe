# Caveman eval: does rule-based prose compression save tokens without dropping facts?

Harness for the `caveman` prose compressor (`src/core/caveman.ts`, contract in
`src/core/prose.ts`). Six fixtures (~3-4 KB each) modeled on sparse-prose tool
results a Claude Code session actually sees — the exact content the
profitability gate declines to image. Deterministic string checks throughout,
no LLM grader.

## What it measures, per fixture

1. **Size**: chars and o200k tokens before/after, % token reduction.
2. **Fact audit**: every fact string extracted from the ORIGINAL must appear
   verbatim in the compressed output. Fact classes: URLs, UUIDs, hex ≥ 6,
   semver, numbers (decimals/percent/units), ISO dates, file paths,
   UPPER_SNAKE, camelCase, kebab-case, dotted identifiers, quoted strings,
   backtick code spans, Capitalized multiword runs. Any miss is a FAILURE with
   the missing string printed.
3. **Idempotence**: `compress(compress(x)) === compress(x)`.

The auditor audits itself on every run: identity must extract > 0 facts and
audit clean, and a planted deletion (a URL removed from fixture a) must be
caught. If `caveman.ts` is missing entirely, the harness runs only that
self-test and exits.

## Fixtures

| file | shape | expectation |
|---|---|---|
| `fixtures/a-webfetch.txt` | WebFetch-style technical answer, fact-dense prose | compress |
| `fixtures/b-readme.md` | README: prose + code fences + table | compress prose, structure byte-exact |
| `fixtures/c-api-guide.md` | API guide prose, inline code + paths | compress |
| `fixtures/d-issue-thread.txt` | issue thread: usernames, SHAs, dates | compress |
| `fixtures/e-code-control.txt` | mostly code (control) | ~0% |
| `fixtures/f-log-control.txt` | structured log lines (control) | ~0% |

## Run

```bash
pnpm tsx eval/caveman/run.mjs
```

Needs `pnpm install` (tsx imports the TS source directly; a built
`dist/core/caveman.js` is preferred when present). Writes `results.json`
per-fixture rows and prints a summary table. Exit code 0 only if every
fixture passes.

## Pass criteria

- Zero fact misses on every fixture.
- Idempotence holds on every fixture.
- Prose fixtures (a-d): ≥ 15% token reduction.
- Control fixtures (e-f): ≤ 2% token reduction.

## Results

**Current status: pass-through STUB.** `src/core/caveman.ts` is Worker A's
placeholder (returns input unchanged), so the table below shows the stub:
controls pass, prose fixtures fail the ≥ 15% gate at 0%. The integrator
re-runs and replaces this table after the real compressor lands.

| fixture | tokens | tok reduction | facts | misses | idem | pass |
|---|---|---|---|---|---|---|
| a-webfetch.txt | 730→730 | 0% | 55 | 0 | yes | FAIL (stub) |
| b-readme.md | 876→876 | 0% | 93 | 0 | yes | FAIL (stub) |
| c-api-guide.md | 970→970 | 0% | 97 | 0 | yes | FAIL (stub) |
| d-issue-thread.txt | 970→970 | 0% | 87 | 0 | yes | FAIL (stub) |
| e-code-control.txt | 900→900 | 0% (ctl) | 65 | 0 | yes | PASS |
| f-log-control.txt | 1350→1350 | 0% (ctl) | 177 | 0 | yes | PASS |

Auditor self-test: 574 facts extracted across 6 fixtures, identity audits
clean, planted deletion caught.

## Known blind spots of the fact audit

- **Presence, not position or count.** A fact appearing twice in the original
  and once in the output still passes. Small bare numbers ("2", "30") can be
  satisfied by a coincidental match elsewhere.
- **Capitalized sentence starts.** The proper-name class matches any
  Capitalized multiword run, so "The catch" extracts alongside "Bramblewood
  Labs". This over-extracts (harmless: identity always contains them) but a
  compressor that lowercases a surviving sentence start would be flagged as a
  miss — arguably correct under the byte-exact contract, but it is grammar,
  not a fact.
- **Uncapitalized prose facts.** A claim carried entirely in lowercase prose
  with no number or identifier ("retrying is always safe") is invisible to
  the extractor. The audit protects fact *strings*, not meaning.
- **All-letter hex.** The hex class requires at least one digit to avoid
  matching English words that are accidentally hex ("deeded", "efface"). A
  real SHA fragment that is all letters (`deadbeef`, `cafebabe`) is therefore
  not extracted as hex — though full 40-char SHAs always contain digits in
  practice, and dotted/kebab/camel classes do not cover this either.
- **Multi-line quoted spans.** Quoted-string classes stop at newlines by
  design; a quote spanning lines is only protected via its inner fragments.
