# Sessions API guide

This guide covers the session lifecycle endpoints. All examples assume the base URL `https://api.parchment.dev/v2` and a bearer token with the `sessions:write` scope. Requests without that scope receive a 403 with error code `SCOPE_MISSING`; requests with an expired token receive a 401 with `TOKEN_EXPIRED` and a `WWW-Authenticate` header you can use to distinguish the two without parsing the body.

## Creating a session

Send a POST to `/sessions` with a JSON body. The only required field is `agentId`; everything else has a server-side default. The response arrives in under 120 ms at p50 and you should time out at 5 s, because the endpoint is idempotent when you supply an `Idempotency-Key` header and retrying is always safe.

The `ttlSeconds` field is clamped to the range 60 to 86400. Values outside the range are not rejected; they are silently clamped, and the effective value is returned in the response as `effectiveTtlSeconds`. This surprises people. If you need to know whether clamping occurred, compare the two fields; the API will never tell you directly. The default is 3600.

A successful create returns 201 with a `Location` header and a body containing `sessionId`, which is a UUIDv7 such as `018f6d2e-9a41-7cc0-b1a5-3e8f0a92c441`. Because UUIDv7 embeds a timestamp, session IDs sort chronologically, and the dashboard relies on this; do not generate your own IDs client-side.

## Reading and listing

GET `/sessions/{sessionId}` returns the full resource. The `state` field is one of `pending`, `active`, `draining`, or `closed`, and transitions are strictly one-directional; you will never observe `draining` followed by `active`. Poll with the `If-None-Match` header and the ETag from the previous response; a 304 costs you nothing against the rate limit, while a full GET costs one unit of the 600-per-minute budget.

Listing is GET `/sessions` with cursor pagination. Pass `limit` (max 200, default 25) and the opaque `cursor` from the previous page. Cursors expire after 15 minutes; an expired cursor returns 410 with `CURSOR_EXPIRED`, and the correct recovery is to restart from the first page, not to retry. Filtering by state is `?state=active` and multiple states are comma-separated. There is no filtering by creation time; if you need that, use the export endpoint described in `docs/exports.md`.

## Closing and the drain window

DELETE `/sessions/{sessionId}` does not destroy anything immediately. It moves the session to `draining`, during which in-flight work is allowed to finish but new work is rejected with 409 `SESSION_DRAINING`. The drain window is controlled by the `drainGraceSeconds` field set at creation time, default 30, maximum 300. After the window the state becomes `closed` and the resource remains readable for 7 days before it is purged.

If you call DELETE twice, the second call returns 200 (not 404, not 409) with the current resource state. This makes shutdown handlers safe to write naively. The one genuinely destructive variant is `DELETE /sessions/{sessionId}?force=true`, which skips the drain window, cancels in-flight work, and is restricted to tokens carrying the `sessions:admin` scope.

## Webhooks

Register a webhook endpoint in the dashboard under Settings, then Webhooks. Every delivery is signed: the `X-Parchment-Signature` header contains an HMAC-SHA256 of the raw body keyed with your signing secret, hex-encoded, prefixed with `v1=`. Verify it against the raw bytes before JSON parsing; parsing first and re-serializing will change key order and the signature will not match. This is the cause of roughly half of all webhook support tickets, per the 2025-11 support retrospective.

Deliveries retry on any non-2xx response with exponential backoff at 1, 4, 16, 64, and 256 seconds, then give up and mark the endpoint degraded. A degraded endpoint is retried once per hour, and after 24 consecutive failures it is disabled and an email goes to the org owner. The event you almost certainly want is `session.closed`; the full catalogue is in `docs/webhook-events.md`, and the reference verifier implementation lives in `examples/verify-webhook/index.ts`.
