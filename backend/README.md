# Backend (Multi-tenant MVP)

`backend/` is the new primary backend for the restaurant bot SaaS refactor.

## Stack
- Node.js + Express (CommonJS)
- Firestore (Firebase Admin SDK using ADC/env credentials)
- provider-agnostic transport gateway with `whatsapp-web.js` adapter
- OpenAI parsing with regex fallback

## Architecture Split
- Core product layer: `src/domain/*`, `src/routes/*`, repositories for restaurants/menu/customers/orders/payments/inbound
- Transport/channel layer: `src/transport/*`, `src/channels/*`
- Core services call `channelGateway` instead of provider-specific APIs.
- Provider adapters are registered by channel key (`whatsapp-web` today; more can be added later).

## Environment
Copy `.env.example` to `.env` and set values:

```bash
PORT=3002
NODE_ENV=development
OPENAI_API_KEY=...
BACKEND_DEFAULT_RESTAURANT_ID=restaurant_demo
WHATSAPP_QR_TTL_SECONDS=120
INBOUND_MENU_COOLDOWN_SECONDS=90
BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME=false
BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME=true
WHATSAPP_RUNTIME_BASE_URL=http://localhost:3001
WHATSAPP_RUNTIME_API_KEY=replace_with_runtime_admin_key
WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS=15000
FIREBASE_SERVICE_ACCOUNT_PATH=/absolute/path/to/service-account.json
OUTBOX_INLINE_SEND_ENABLED=true
OUTBOX_WORKER_ENABLED=false
OUTBOX_WORKER_POLL_MS=1500
OUTBOX_WORKER_BATCH_SIZE=5
OUTBOX_LEASE_MS=30000
OUTBOX_MAX_ATTEMPTS=5
OUTBOX_RETRY_BASE_MS=1000
OUTBOX_RETRY_MAX_MS=60000
```

Firebase Admin init order:
1. `FIREBASE_SERVICE_ACCOUNT_PATH` (if provided)
2. local `backend/serviceAccountKey.json` (if present)
3. Application Default Credentials (ADC)

ADC example for local:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

## Install + Run
```bash
cd backend
npm install
npm run start
```

Run outbox worker:
```bash
cd backend
OUTBOX_WORKER_ENABLED=true npm run worker:outbox
```

Run pilot smoke test:
```bash
cd backend
npm run pilot:smoke -- --restaurantId <restaurantId> --apiKey <keyId.secret>
```

Health check:
```bash
curl http://localhost:3002/health
curl http://localhost:3002/status
```

## API Authentication
All protected routes require:

```http
x-api-key: <keyId>.<secret>
```

API keys are stored under:
`restaurants/{restaurantId}/apiKeys/{keyId}`

Seed/update a key:
```bash
cd backend
npm run create:api-key -- <restaurantId> <keyId> <secret> [scopesCsv] [name]
```

Example scopes:
- `orders.read,orders.write,orders.transition`
- `menu.read,menu.write`
- `payments.read,payments.write`
- `deliveryZones.read,deliveryZones.write`
- `messages.inbound`
- `outbox.read,outbox.manage`
- `channels.session.read,channels.session.manage`
- `whatsapp.session.read,whatsapp.session.manage`
- `restaurants.read,restaurants.write`

## Main API Base
Tenant-aware API base:

`/api/restaurants/:restaurantId`

Key endpoints:
- `GET /orders`
- `GET /orders/:orderId`
- `GET /orders/:orderId/messages`
- `POST /orders/:orderId/confirm`
- `POST /orders/:orderId/approve`
- `POST /orders/:orderId/cancel`
- `POST /orders/:orderId/unavailable-items`
- `POST /orders/:orderId/transition`
- `POST /orders/:orderId/payment-receipts`
- `GET /orders/:orderId/payment-receipts`
- `POST /orders/:orderId/payment-review/confirm`
- `POST /orders/:orderId/payment-review/reject`
- `GET /menu-items`, `POST /menu-items`, `PATCH /menu-items/:itemId`, `DELETE /menu-items/:itemId`
- `GET /delivery-zones`, `POST /delivery-zones`, `PATCH /delivery-zones/:zoneId`, `DELETE /delivery-zones/:zoneId`
- `GET /restaurant`, `PUT /restaurant`
- `PATCH /restaurant/bot`
- `POST /messages/inbound`
- `GET /outbox/messages`
- `GET /outbox/messages/:messageId`
- `GET /outbox/stats`
- `POST /outbox/messages/:messageId/retry`
- `GET /ops/pilot-snapshot`
- `POST /channels/:channel/session/start`
- `POST /channels/:channel/session/disconnect`
- `POST /channels/:channel/session/restart`
- `GET /channels/:channel/session/status`
- `GET /channels/:channel/session/qr`
- `POST /whatsapp/session/start`
- `POST /whatsapp/session/disconnect`
- `POST /whatsapp/session/restart`
- `GET /whatsapp/session/status`
- `GET /whatsapp/session/qr`

`GET /ops/pilot-snapshot` requires all scopes:
- `orders.read`
- `outbox.read`
- `channels.session.read`

`POST /messages/inbound` is the transport handoff endpoint for `whatsapp-bot/`.
The bot sends normalized inbound events and backend returns `shouldReply` + `replyText`.

Restaurant-level bot controls live on `restaurants/{restaurantId}.bot`:
- `enabled` (boolean)
- `ignoreGroupChats` (boolean)
- `allowedChatIds` (array of WhatsApp chat IDs)
- `allowedPhonePrefixes` (array, e.g. `["234"]`)
- `allowedChannels` (array, e.g. `["whatsapp-web"]`)

## Session + QR
- One provider session per restaurant per channel.
- Session state is in `providerSessions/{restaurantId__channel}`.
- For compatibility, `whatsappSessions/{restaurantId}` is still mirrored for `whatsapp-web`.
- Raw QR is kept in protected in-memory cache only.
- QR route is API-key protected and tenant-scoped.

Runtime ownership:
- Phase 1 default is `BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME=false`.
- `whatsapp-bot/` is the only active WhatsApp runtime.
- Preferred transport mode for multi-tenant rollout:
  - `BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME=false`
  - `BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME=true`
  - backend outbox worker sends outbound messages to `whatsapp-bot` runtime API.

Startup sanity checks:
- backend fails fast if both runtime modes are enabled.
- backend fails fast if external runtime mode is enabled without base URL/API key.
- backend logs warnings if outbound delivery is effectively disabled.

## Compatibility Routes (Temporary)
These exist for admin migration and are deprecated:
- `GET /getOrders`
- `POST /confirmOrder`
- `POST /markItemsUnavailable`

Behavior:
- Map to `BACKEND_DEFAULT_RESTAURANT_ID`
- Require the same `x-api-key`
- Emit deprecation headers (`X-Deprecated`, `X-Replacement-Endpoint`, `Sunset`)

## Firestore Model
- `restaurants/{restaurantId}`
- `restaurants/{restaurantId}/apiKeys/{keyId}`
- `restaurants/{restaurantId}/menuItems/{itemId}`
- `restaurants/{restaurantId}/customers/{customerId}`
- `restaurants/{restaurantId}/orders/{orderId}`
- `restaurants/{restaurantId}/orders/{orderId}/statusHistory/{entryId}`
- `restaurants/{restaurantId}/orders/{orderId}/paymentReceipts/{receiptId}`
- `restaurants/{restaurantId}/orders/{orderId}/messages/{messageId}`
- `restaurants/{restaurantId}/inboundEvents/{providerMessageId}`
- `providerSessions/{restaurantId__channel}`
- `outboundOutbox/{messageId}`
- `whatsappSessions/{restaurantId}`

Operational docs include `restaurantId`, `createdAt`, `updatedAt`.
Orders/customers/messages include `channel`, `channelCustomerId`, `customerPhone`.

## Outbox
Outbound sends are outbox-first and retry-safe:
- Message intent is persisted before any provider send attempt.
- Inline send remains enabled by default (`OUTBOX_INLINE_SEND_ENABLED=true`).
- Background worker retries failures (`npm run worker:outbox`).
- If a channel adapter runtime is disabled, outbox sends will remain retrying/failed until a live runtime is available.
- External runtime timeout and retry behavior:
  - backend request timeout is strict (`WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS`, default `15000`)
  - runtime-side send timeout is enforced in `whatsapp-bot` (`BOT_RUNTIME_SEND_TIMEOUT_MS`, default `12000`)
  - runtime response `status=in_flight` is treated as retryable (not terminal success) to avoid false-positive completion.

See [OUTBOX.md](./OUTBOX.md) for schema, lifecycle, idempotency, worker lease logic, and ops endpoints.
See [PILOT_RUNBOOK.md](./PILOT_RUNBOOK.md) for first-pilot onboarding, smoke testing, and support operations.
See [API_HANDOFF_V1.md](./API_HANDOFF_V1.md) for frontend integration contract and examples.
See [MVP_ENDPOINT_INVENTORY.md](./MVP_ENDPOINT_INVENTORY.md) for endpoint inventory (exists/added/updated).
See [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) for deployment-ready runbook.
