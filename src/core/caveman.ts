// STUB: Worker A replaces this file
//
// Minimal pass-through implementation of the ProseCompressor contract
// (src/core/prose.ts) so the wiring in transform.ts typechecks and runs
// before the real rule-based compressor lands. Returns input unchanged,
// which the caller's negligible-savings gate discards — net behavior with
// this stub is a no-op.

import type { ProseCompressor } from './prose.js';

export const cavemanCompressor: ProseCompressor = {
  id: 'caveman',
  compress(text: string) {
    return { text, removedChars: 0, protectedSpans: 0, rewrittenSentences: 0 };
  },
};
