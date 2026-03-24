# Outbound Outbox

## Purpose
Durable, retry-safe outbound messaging for backend-triggered sends (confirm order, unavailable-item notices, and other staff/system outbound actions).

Outbox behavior:
1. Persist message intent first.
2. Attempt inline delivery (default enabled).
3. Worker retries failed delivery attempts.

## Collection
`outboundOutbox/{messageId}`

`messageId` is deterministic: `sha256(idempotencyKey)`.

## Document Schema
- `messageId`: deterministic ID
- `idempotencyKey`
- `idempotencyHash`
- `payloadHash`
- `restaurantId`
- `channel`
- `recipient`
- `text`
- `messageType`
- `sourceAction`
- `sourceRef`
- `metadata`
- `status`: `queued | processing | retrying | sent | failed`
- `attemptCount`
- `maxAttempts`
- `nextAttemptAtMs`
- `leaseOwner`
- `leaseExpiresAtMs`
- `lastAttemptAtMs`
- `lastError` (`message`, `code`, `stack`)
- `providerMessageId`
- `providerResponse`
- `createdAtMs`
- `updatedAtMs`
- `sentAtMs`
- `failedAtMs`
- `lifecycle`: append-only state events

## Lifecycle
- `queued`: persisted and waiting
- `processing`: currently leased by inline dispatcher or worker
- `retrying`: failed attempt, waiting for next attempt
- `sent`: terminal success
- `failed`: terminal exhausted failure

## Idempotency
- Caller supplies `idempotencyKey`.
- Same key + same payload => deduped (returns existing outbox item).
- Same key + different payload => conflict (prevents accidental key reuse).

## Lease Contract
- Before send attempt, dispatcher/worker claims lease:
  - sets `status=processing`
  - sets `leaseOwner`
  - sets `leaseExpiresAtMs`
- If worker crashes, expired leases become reclaimable.
- Only lease owner can finalize a claim while lease is active.

## Retry Policy
- Retry delay uses bounded exponential backoff.
- Attempt count increments after each real send attempt (success or failure).
- When `attemptCount >= maxAttempts`, status becomes `failed`.
- If a provider runtime is disabled (for example `whatsapp-web` runtime disabled in backend),
  outbox items will retry and eventually end as `failed` unless another active adapter/runtime can deliver.

External runtime semantics:
- Runtime endpoint timeout is treated retryable.
- Runtime `status=in_flight` is treated retryable (not terminal success).
- Runtime `status=already_sent` or `status=sent` are treated success.
- Successful runtime responses include `handledByRuntimeInstance` for shard/debug traceability.

## Runtime Flags
- `OUTBOX_INLINE_SEND_ENABLED` (default `true`)
- `OUTBOX_WORKER_ENABLED` (default `false`)
- `OUTBOX_WORKER_POLL_MS` (default `1500`)
- `OUTBOX_WORKER_BATCH_SIZE` (default `5`)
- `OUTBOX_LEASE_MS` (default `30000`)
- `OUTBOX_MAX_ATTEMPTS` (default `5`)
- `OUTBOX_RETRY_BASE_MS` (default `1000`)
- `OUTBOX_RETRY_MAX_MS` (default `60000`)

## Worker Runbook
Local:
```bash
cd backend
OUTBOX_WORKER_ENABLED=true npm run worker:outbox
```

Production:
- Run `npm run worker:outbox` as a separate process/container.
- Keep backend API process and worker process independent.
- Scale workers cautiously (start with 1 instance, then increase if needed).

## Ops Visibility Endpoints (tenant-scoped)
- `GET /api/restaurants/:restaurantId/outbox/messages`
- `GET /api/restaurants/:restaurantId/outbox/messages/:messageId`
- `GET /api/restaurants/:restaurantId/outbox/stats`
- `POST /api/restaurants/:restaurantId/outbox/messages/:messageId/retry`
