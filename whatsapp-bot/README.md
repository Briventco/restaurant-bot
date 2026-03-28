# WhatsApp Bot Runtime

Transport-focused `whatsapp-web.js` runtime with tenant-isolated sessions.

This service now supports:
- single-tenant fallback mode (default)
- sharded multi-tenant mode (Option C) with a hard cap of `<= 5` tenants per process
- tenant-scoped inbound pipeline and outbound delivery
- manual tenant controls and runtime observability endpoints

It remains a dedicated-number-per-restaurant system, not a shared marketplace number.

## Runtime Modes

### 1) Single mode (default fallback)
- `BOT_RUNTIME_MODE=single`
- Uses legacy envs (`BOT_RESTAURANT_ID`, `WHATSAPP_CLIENT_ID`, `BACKEND_API_*`)
- Runs one tenant per process

### 2) Multi mode (sharded)
- `BOT_RUNTIME_MODE=multi`
- Requires `BOT_TENANTS_FILE=<path-to-tenants.json>`
- Loads multiple tenant configs in one process (max enabled tenants capped to `BOT_MAX_TENANTS_PER_PROCESS`, hard-limited to 5)

## Tenant Config Model (`BOT_TENANTS_FILE`)

```json
{
  "version": 1,
  "shardId": "wa-shard-1",
  "maxTenantsPerProcess": 5,
  "tenants": [
    {
      "restaurantId": "rest_abc",
      "enabled": true,
      "disabledReason": "",
      "whatsappClientId": "wa_rest_abc",
      "backendApiBaseUrl": "http://backend:3002",
      "backendApiKey": "keyId.secret",
      "allowAllChats": false,
      "allowedChatIds": ["2348012345678@c.us"],
      "allowedPhonePrefixes": ["234"],
      "ignoreGroupChats": true,
      "reconnect": {
        "baseDelayMs": 5000,
        "maxDelayMs": 120000,
        "maxAttemptsBeforePause": 20
      }
    }
  ]
}
```

## Tenant Isolation

Each tenant runtime is isolated by:
- unique `restaurantId`
- unique `whatsappClientId` (LocalAuth namespace)
- dedicated inbound dedupe store
- dedicated outbound idempotency store
- dedicated inbound chat queue and outbound queue counters
- dedicated backend API key / tenant route scope

Auth/cache namespaces remain isolated through WhatsApp LocalAuth `clientId`.

## Status FSM

Primary states:
- `disabled`
- `starting`
- `qr_required`
- `authenticating`
- `connected`
- `disconnected`
- `reconnecting`
- `paused`
- `error`

Common transitions:
- `starting -> qr_required -> authenticating -> connected`
- `connected -> disconnected -> reconnecting -> starting`
- `reconnecting -> paused` (on reconnect exhaustion)
- any active state -> `paused` (manual pause)
- `paused -> starting` (resume)

## Tenant Health Snapshot

`GET /runtime/v1/tenants/:restaurantId/status` returns tenant snapshot fields including:
- `status`
- `enabled`
- `disabledReason`
- `pausedReason`
- `statusDetail`
- `needsAttention`
- `lastHeartbeat`
- `lastConnectedAt`
- `lastDisconnectReason`
- `reconnectAttemptCount`
- `inboundQueueSize`
- `outboundQueueSize`
- `qrAvailable`
- `lastQrAt`
- `lastErrorAt`
- `lastErrorCode`
- `lastErrorMessage`
- `runtimeInstanceId`

Ops visibility emphasis:
- `paused`: `pausedReason` + `needsAttention=true`
- `disconnected`: `lastDisconnectReason` + `needsAttention=true`
- `error`: `lastErrorAt`/`lastErrorMessage` + `needsAttention=true`
- `disabled`: `disabledReason` + `needsAttention=true`

## Manual Tenant Controls

All runtime control routes require header:
- `x-runtime-key: <BOT_RUNTIME_ADMIN_KEY>`

Endpoints:
- `GET /runtime/v1/tenants`
- `GET /runtime/v1/tenants/:restaurantId/status`
- `GET /runtime/v1/tenants/:restaurantId/qr`
- `POST /runtime/v1/tenants/:restaurantId/pause`
- `POST /runtime/v1/tenants/:restaurantId/resume`
- `POST /runtime/v1/tenants/:restaurantId/restart`

## External Outbound Contract

Backend outbox worker calls:
- `POST /runtime/v1/tenants/:restaurantId/outbound/send`

Request body:
```json
{
  "outboxMessageId": "<required>",
  "channel": "whatsapp-web",
  "to": "2348012345678@c.us",
  "text": "Your order is confirmed",
  "messageType": "order_confirmed",
  "sourceAction": "confirmOrder",
  "sourceRef": "order_123",
  "attempt": 1,
  "metadata": {}
}
```

Success response:
```json
{
  "accepted": true,
  "status": "sent | already_sent | in_flight",
  "deduped": false,
  "outboxMessageId": "...",
  "handledByRuntimeInstance": "wa-shard-1:host:pid",
  "tenantStatus": "connected",
  "runtimeSendTimeoutMs": 12000,
  "inboundQueueSize": 0,
  "outboundQueueSize": 0
}
```

Failure response includes:
- `accepted=false`
- `retryable`
- `errorCode`
- `message`
- `handledByRuntimeInstance`
- `tenantStatus`

## Timeout + Retry Strategy

Runtime-side send timeout:
- `BOT_RUNTIME_SEND_TIMEOUT_MS` (default `12000`)

Backend runtime request timeout:
- `WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS` (default `15000`)
- keep this greater than runtime send timeout to avoid premature backend aborts

Expected behavior:
- request timeout and `TENANT_NOT_CONNECTED` are retryable
- `TENANT_DISABLED` / `TENANT_PAUSED` are non-retryable
- runtime `status=in_flight` is treated retryable by backend adapter (not terminal success)

## Runtime Idempotency Storage (Current Phase)

Outbound idempotency store:
- tenant-scoped in-memory map (`createInMemoryIdempotencyStore`)
- key: `outboxMessageId`
- states: `processing`, `sent`, `failed`

Retention defaults:
- `BOT_RUNTIME_OUTBOUND_INFLIGHT_TTL_MS=90000`
- `BOT_RUNTIME_OUTBOUND_SENT_TTL_MS=86400000`
- `BOT_RUNTIME_OUTBOUND_FAILED_TTL_MS=1800000`

Important:
- idempotency memory does **not** survive process restart
- durable dedupe across restarts remains anchored by backend outbox idempotency (`outboundOutbox/{messageId}`)

## Local Run

```bash
cd whatsapp-bot
npm install
npm start
```

## Render Deployment (Chromium)

Render-safe setup for `whatsapp-web.js`:
- this runtime uses `puppeteer` (not only `puppeteer-core`)
- `postinstall` runs `node scripts/installChromium.js`
- installer executes `npx puppeteer browsers install chrome`
- runtime resolves executable path from:
  1) `PUPPETEER_EXECUTABLE_PATH` or `CHROME_BIN`
  2) Puppeteer-managed bundled Chromium path

Render service settings:
- Root Directory: `whatsapp-bot`
- Build Command: `npm install`
- Start Command: `npm run start`

Required env guidance:
- do **not** set `PUPPETEER_SKIP_DOWNLOAD=true`
- keep `PUPPETEER_HEADLESS=true`
- optionally set `WHATSAPP_AUTH_DATA_PATH` to a mounted persistent disk path for session durability

Startup logs now include:
- `CHROMIUM_DIAGNOSTICS = ...`
- `RUNTIME_CONFIG = ...` (includes resolved executable path + auth data path)
- `RUNTIME_ROUTE_MAP = ...`

## Key Environment

- `PORT` (default `3001`)
- `BOT_RUNTIME_MODE` (`single` or `multi`)
- `BOT_SHARD_ID` (default `wa-shard-default`)
- `BOT_MAX_TENANTS_PER_PROCESS` (default `5`, hard-capped to `<=5`)
- `BOT_TENANTS_FILE` (required for `multi`)
- `BOT_RUNTIME_ADMIN_KEY` (required for runtime control APIs)
- `BOT_RUNTIME_SEND_TIMEOUT_MS` (default `12000`)
- `BOT_RUNTIME_QR_TTL_MS` (default `120000`)
- `BOT_RUNTIME_HEARTBEAT_MS` (default `15000`)
- `BOT_RUNTIME_OUTBOUND_INFLIGHT_TTL_MS` (default `90000`)
- `BOT_RUNTIME_OUTBOUND_SENT_TTL_MS` (default `86400000`)
- `BOT_RUNTIME_OUTBOUND_FAILED_TTL_MS` (default `1800000`)

Single-mode legacy vars still supported:
- `BOT_ENABLED`
- `BOT_RESTAURANT_ID`
- `WHATSAPP_CLIENT_ID`
- `WHATSAPP_AUTH_DATA_PATH` (default `.wwebjs_auth`)
- `BACKEND_API_BASE_URL`
- `BACKEND_API_PREFIX` (default `/api/v1`)
- `BACKEND_API_KEY`
- `PUPPETEER_HEADLESS` (default `true`)
- `PUPPETEER_EXECUTABLE_PATH` (optional override)

Runtime health endpoints:
- `GET /`
- `GET /health`
- `GET /status`

## Shard Deployment Guidance (5 / 10 / 20)

### First 5 restaurants
- 1 runtime process
- `BOT_MAX_TENANTS_PER_PROCESS=5`
- keep 1 backend outbox worker
- monitor tenant statuses and reconnect counts daily

### 10 restaurants
- 2 runtime processes (two shard IDs)
- split tenants 5 + 5
- keep strict unique `whatsappClientId` per tenant
- start tracking per-shard `needsAttention` count

### 20 restaurants
- 4 runtime processes (5 tenants each)
- use explicit tenant-to-shard assignment in config files
- keep manual pause/restart runbook for noisy tenants
- avoid increasing per-process cap before stability data is strong

## Notes

- Dedupe/queue/idempotency stores in runtime are in-memory.
- Backend outbox is durable and remains source-of-truth for retry lifecycle.
- Node 20 LTS is recommended for `whatsapp-web.js` + native `fetch`.
