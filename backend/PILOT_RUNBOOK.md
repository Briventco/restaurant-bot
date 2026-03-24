# Pilot Readiness Runbook

This runbook is for first live pilots with restaurant-owned dedicated WhatsApp numbers.

## 1) End-to-End Onboarding Checklist (New Restaurant)

1. Create restaurant record and basic profile.
2. Add menu items with correct names, prices, and availability.
3. Configure bot policy on restaurant record:
   - `bot.enabled=true`
   - `bot.ignoreGroupChats=true`
   - `bot.allowedChannels` includes `whatsapp-web`
   - `bot.allowedPhonePrefixes` and/or `bot.allowedChatIds` as needed
4. Create API key for the bot/runtime integration with scopes:
   - `messages.inbound`
   - `orders.read,orders.write,orders.transition`
   - `menu.read`
   - `outbox.read,outbox.manage`
   - `channels.session.read,channels.session.manage`
5. Add tenant entry to runtime tenant config (`whatsapp-bot/tenants.<env>.json`):
   - unique `restaurantId`
   - unique `whatsappClientId`
   - correct `backendApiBaseUrl`
   - correct `backendApiKey`
   - `enabled=true`
6. Deploy/reload runtime shard with updated tenant config.
7. Fetch tenant QR and complete WhatsApp authentication:
   - `GET /runtime/v1/tenants/:restaurantId/qr`
8. Confirm tenant status is stable:
   - `connected`
   - `reconnectAttemptCount=0`
   - `needsAttention=false`
9. Run pilot smoke test (script or manual flow).
10. Validate dashboard/ops visibility:
   - orders list
   - outbox stats
   - session status
   - pilot snapshot endpoint
11. Handover support contacts and incident response expectations.

## 2) Minimal Observability for Pilots

### Runtime (whatsapp-bot)
- `GET /runtime/v1/tenants`
- `GET /runtime/v1/tenants/:restaurantId/status`
- `GET /runtime/v1/tenants/:restaurantId/qr`
- `POST /runtime/v1/tenants/:restaurantId/pause`
- `POST /runtime/v1/tenants/:restaurantId/resume`
- `POST /runtime/v1/tenants/:restaurantId/restart`

Status fields to watch:
- `status`
- `disabledReason`
- `pausedReason`
- `lastErrorAt`
- `lastQrAt`
- `lastDisconnectReason`
- `reconnectAttemptCount`
- `inboundQueueSize`
- `outboundQueueSize`
- `qrAvailable`
- `needsAttention`

### Backend (tenant-scoped)
- `GET /api/restaurants/:restaurantId/ops/pilot-snapshot`
- `GET /api/restaurants/:restaurantId/outbox/stats`
- `GET /api/restaurants/:restaurantId/outbox/messages?status=...`
- `GET /api/restaurants/:restaurantId/orders?limit=...`
- `GET /api/restaurants/:restaurantId/orders/:orderId/messages`
- `GET /api/restaurants/:restaurantId/whatsapp/session/status`

## 3) Smoke Test Flow

## Option A: Script (recommended)

```bash
cd backend
npm run pilot:smoke -- \
  --baseUrl http://localhost:3002 \
  --restaurantId <restaurantId> \
  --apiKey <keyId.secret> \
  --chatId <whatsappChatId> \
  --customerPhone <phone>
```

What it validates:
1. tenant connected status read
2. inbound greeting received
3. inbound order processed and order created
4. outbound confirmation sent (via order message log)
5. unavailable-item flow (second order)
6. tenant restart path
7. pilot snapshot retrieval

Use a dedicated internal test customer chat/phone for this flow to avoid polluting real customer threads.

## Option B: Manual API sequence

1. `GET /whatsapp/session/status`
2. `POST /messages/inbound` (greeting)
3. `POST /messages/inbound` (order text)
4. verify new order with `GET /orders`
5. `POST /orders/:orderId/confirm`
6. verify outbound confirmation in `GET /orders/:orderId/messages`
7. create second order via inbound
8. `POST /orders/:orderId/unavailable-items`
9. verify unavailable outbound message in order messages
10. `POST /whatsapp/session/restart`
11. `GET /ops/pilot-snapshot`

## 4) Top 5 Pilot Failure Scenarios

### 1) Tenant disconnected / never connects
Detection:
- runtime status `disconnected|error|paused`
- rising `reconnectAttemptCount`
- `needsAttention=true`
Recovery:
1. get QR (`/runtime/v1/tenants/:id/qr`) and re-authenticate.
2. if unstable, pause then restart tenant.
3. if still failing, clear tenant auth cache for that tenant namespace and re-link.

### 2) Inbound messages not creating orders
Detection:
- no new `inboundEvents`
- no new orders
- policy reason from inbound route (ignored)
Recovery:
1. verify `messages.inbound` API key and tenant `backendApiKey`.
2. verify restaurant bot policy (`enabled`, allowlists, channel).
3. send controlled inbound payload to `/messages/inbound` and inspect response type.

### 3) Outbound confirmations delayed/failed
Detection:
- `outbox/stats` shows growing `retrying|failed`
- outbox items have `lastError` and high `attemptCount`
Recovery:
1. verify runtime endpoint connectivity and key.
2. check runtime tenant status is `connected`.
3. retry failed outbox messages with `/outbox/messages/:id/retry`.
4. if tenant paused/disabled, resume and reprocess.

### 4) Wrong-tenant routing risk
Detection:
- outbound/inbound references unexpected `restaurantId`
- tenant config mismatch between `restaurantId` and API key
Recovery:
1. pause affected tenant immediately.
2. validate tenant config mapping (`restaurantId`, `whatsappClientId`, `backendApiKey`).
3. run smoke test again before resume.

### 5) Restart/redeploy regressions
Detection:
- after restart, tenant not reconnecting
- temporary spike in outbox retries/timeouts
Recovery:
1. perform controlled one-tenant restart first.
2. verify status and smoke checks before next tenant.
3. keep outbox worker running; allow retries to drain once runtime is healthy.

## 5) Safest Rollout Path

## 1 Restaurant
1. Run backend + outbox worker + one runtime process.
2. Keep `BOT_RUNTIME_MODE=single` or `multi` with one enabled tenant.
3. Validate full smoke test and monitor for 24-48h.

## 2 Restaurants
1. Use `multi` mode with two tenants in one shard (cap stays 5).
2. Onboard second tenant only after first is stable.
3. Run smoke test per tenant; restart tenants one at a time.

## 3-5 Restaurants
1. Keep cap at 5 tenants per process.
2. Onboard incrementally (one tenant/day or slower).
3. Use pilot snapshot per tenant daily and watch outbox backlog trends.
4. If one noisy tenant degrades runtime, pause that tenant first instead of restarting all.

## Concise Launch Checklist

1. Tenant config added and validated (`restaurantId`, `whatsappClientId`, API key).
2. QR scanned and tenant status is `connected`.
3. Menu has at least one available item.
4. Smoke test passed end-to-end.
5. Outbox stats clean (`failed=0`, backlog acceptable).
6. Support contacts and escalation owner assigned.

## Support Runbook (Common Issues)

### Issue: `paused` tenant
1. check `pausedReason`.
2. fix root cause (auth/network/reconnect exhaustion).
3. call resume; verify connected.

### Issue: `disabled` tenant
1. check `disabledReason` and tenant config.
2. set `enabled=true` in tenant config.
3. restart shard or reload config deployment.

### Issue: no QR available
1. ensure tenant is in `starting|qr_required` path.
2. restart tenant and fetch QR quickly (QR is ephemeral).

### Issue: outbox failed messages
1. inspect `lastError` on outbox messages.
2. restore runtime connectivity.
3. manual retry failed outbox items.

### Issue: inbound ignored unexpectedly
1. inspect bot policy on restaurant.
2. verify `channelCustomerId` allowlist/phone prefix.
3. re-test inbound with controlled payload.

## Not Yet Safe to Promise to Clients

1. Zero-downtime reconnect guarantees across all disconnect classes.
2. Durable runtime-level idempotency across runtime process restarts.
3. Fully automated multi-shard orchestration/rebalancing.
4. Guaranteed instant delivery in adverse WhatsApp/web session incidents.
5. Full production-grade alerting/incident automation (current visibility is API/log based).
