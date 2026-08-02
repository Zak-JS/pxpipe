/**
 * Prose compression contract — the seam between pxpipe's gate and any
 * prose compressor backend.
 *
 * pxpipe's profitability gate declines to image sparse prose (~3.5 chars/token
 * loses money as pixels). This interface is the second path for exactly that
 * declined content: compress the words themselves instead of rendering them.
 *
 * Backend 1 (this fork's MVP): `caveman` — deterministic rule-based stripping
 * of reconstructable grammar (src/core/caveman.ts). Zero deps, zero I/O.
 * Backend 2 (planned): `llmlingua2` — learned token-classification pruning via
 * @atjsh/llmlingua-2, opt-in because it pulls transformers.js + a model file.
 *
 * Invariants every backend MUST hold:
 * - Deterministic: same input, same output.
 * - Pure and synchronous-safe: no network, no disk, no globals.
 * - Fact-preserving: numbers, identifiers (hex/sha/uuid/semver), URLs, file
 *   paths, quoted strings, code spans/fences, and markdown/table structure
 *   pass through byte-exact. When in doubt, keep the token.
 * - Line-honest: structural lines (headings, lists, tables, code) are never
 *   reflowed; only prose sentences are compressed.
 */

export interface ProseCompressionResult {
  /** The compressed text. Equal to the input when nothing was safe to remove. */
  text: string;
  /** Characters removed (input length minus output length, >= 0). */
  removedChars: number;
  /** Count of spans protected as fact-bearing and passed through untouched. */
  protectedSpans: number;
  /** Sentences (or lines) that were rewritten, for event accounting. */
  rewrittenSentences: number;
}

export interface ProseCompressor {
  /** Stable backend id recorded in tracker events, e.g. "caveman". */
  readonly id: string;
  compress(text: string): ProseCompressionResult;
}
