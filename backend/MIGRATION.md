# Migration Notes: `functions/` -> `backend/`

## Reused from `functions/`
The new backend ports and reuses the strongest domain behavior from `functions/index.js`:
- text normalization
- menu item matching
- subtotal and total calculation
- active-order lookup per customer
- unavailable-item customer flow
- customer-edit flow that updates the same order
- customer-facing message templates for order lifecycle interactions

## What Changed
- Introduced a new `backend/` Express service as the primary backend path.
- Removed Twilio usage from the new backend path.
- Added provider-agnostic channel architecture and implemented `whatsapp-web.js` adapter.
- Added `channelGateway` + `providerRegistry` so core services no longer call provider adapters directly.
- Added generic channel session routes:
  - `/api/restaurants/:restaurantId/channels/:channel/session/*`
- Kept `/whatsapp/session/*` as compatibility aliases.
- Added outbound outbox + worker foundation:
  - `outboundOutbox/{messageId}`
  - outbox-first persistence before provider send attempt
  - inline send default preserved, worker retry support added
- Added tenant-aware repository layer and route scoping.
- Added provider session repository model:
  - `providerSessions/{restaurantId__channel}`
  - legacy `whatsappSessions/{restaurantId}` mirror for compatibility.
- Added per-tenant API key auth model (`keyId.secret`) with scoped permissions and rotation-ready storage.
- Extended API-key scope checks to support `{ anyOf, allOf }` rules.
- Added explicit transition policy and status guardrails.
- Added status history as subcollection:
  - `restaurants/{restaurantId}/orders/{orderId}/statusHistory/{entryId}`
- Moved payment receipts under order:
  - `restaurants/{restaurantId}/orders/{orderId}/paymentReceipts/{receiptId}`
- Added idempotency placeholder for inbound messages:
  - `restaurants/{restaurantId}/inboundEvents/{providerMessageId}`
- Added protected, ephemeral QR flow (in-memory QR with metadata in Firestore session state).
- Added temporary compatibility routes with deprecation warnings and headers.

## Current TODOs
- Migrate `admin/` to new tenant-aware API routes.
- Add staff/user auth + RBAC beyond API-key model.
- Add durable runtime-side idempotency backing store if/when shard density increases beyond current operating profile.
- Add stronger monitoring/metrics/alerting and audit dashboards.
- Add integration tests against Firestore emulator.

## Intentional Non-goals in This MVP
- No payment gateway integration (manual transfer + receipt review only).
- No Twilio in new backend.
- No rewrite of `functions/`; it remains as legacy reference during transition.
