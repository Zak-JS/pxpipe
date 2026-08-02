# flatcache

A tiny disk-backed memoization layer for Node. Version 2.3.1 requires Node >= 18.17.0 and has exactly one runtime dependency (`fast-json-stable-stringify` at 2.1.0). The whole package is 14.2 KB unpacked.

## Why

Most caching libraries assume you want an LRU in memory. flatcache assumes the opposite: your process restarts often (serverless, CI, watch-mode tooling) and the expensive thing you are protecting is a network call or a compile step that is identical across runs. It writes one JSON file per cache under `.flatcache/` and loads it lazily on first read. In the wild, this cut cold-start dependency resolution in the pnpm-based monorepo it was extracted from by 61%, from 8.4 s to 3.3 s.

## Install

```bash
pnpm add flatcache
# or
npm install flatcache --save
```

## Quick start

```js
import { createCache } from 'flatcache';

const cache = createCache({ dir: '.flatcache', name: 'registry-meta' });

const meta = await cache.memo('react@19.0.0', async () => {
  const res = await fetch('https://registry.npmjs.org/react/19.0.0');
  return res.json();
});
```

The `memo` key is hashed with SHA-256 and truncated to 16 hex chars for the on-disk filename, so keys can be arbitrarily long. Values must survive `JSON.stringify`; a `Map` or a `Buffer` will be silently mangled, which is the single most reported issue (see #142).

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `dir` | string | `.flatcache` | Created with mode 0o700 if missing |
| `name` | string | `default` | One JSON file per name |
| `ttlMs` | number | `Infinity` | Stale entries pruned on load, not on a timer |
| `maxBytes` | number | `52428800` | 50 MB; oldest-written entries evicted first |
| `serialize` | function | `JSON.stringify` | Swap in `superjson` for Dates and Maps |

## Behavior you should know about

Writes are debounced 200 ms and flushed with `fsync` on process exit via a `beforeExit` hook. A hard kill (SIGKILL, OOM) inside that window loses at most the last 200 ms of writes; the file itself is written atomically with a rename from a `.tmp` sibling, so it never corrupts. Concurrent processes sharing one cache directory are safe for reads but last-writer-wins for writes. If you need multi-process coordination, you want `proper-lockfile` or an actual database, not this.

The TTL check happens at load time only. A long-lived process holding a cache open past its `ttlMs` will keep serving stale entries until restart. This is a deliberate trade-off documented in ADR-003; a timer-based sweep was rejected because it kept the event loop alive and broke short-lived CLI tools that expected to exit immediately.

## Benchmarks

Measured on an M2 MacBook Air, Node 20.11.1, macOS 14.5, warm APFS cache. The comparison point is `node-persist` 3.1.3.

| Operation | flatcache | node-persist |
|---|---|---|
| cold load, 10k entries | 19 ms | 340 ms |
| get (hit) | 0.0008 ms | 0.9 ms |
| set + debounced flush | 0.004 ms | 1.2 ms |

The gap on cold load comes from storing everything in one file instead of 10,000 files; one `read(2)` beats ten thousand `open(2)` calls every time.

## License

MIT. Extracted from the Attic build tooling at Bramblewood Labs; the git history before 1.0.0 lives in the original monorepo.
