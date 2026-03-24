# Backend Architecture

## Target Split

### 1) Core Product Layer
- `src/domain/services/*`
- `src/domain/policies/*`
- `src/domain/templates/*`
- `src/repositories/*` (tenant-scoped business data)
- `src/routes/*` (tenant API surface)

Core behavior includes restaurant config, menu, customers, order flow, status transitions, and payment receipt handling.
Outbound reliability includes durable outbox + worker retry processing.

### 2) Transport/Channel Layer
- `src/transport/providers/providerRegistry.js`
- `src/transport/providers/channelGateway.js`
- `src/transport/session/channelSessionService.js`
- `src/channels/*` adapter implementations

Transport adapters own provider-specific mechanics (session start, QR handling, provider event mapping, outbound send).
Core services interact with transport via `channelGateway`.

## Current Providers
- `whatsapp-web` adapter (`src/channels/whatsapp-web/*`)
- dormant runtime adapter for deployments where outbound/session runtime is external

## Session Model
- Canonical: `providerSessions/{restaurantId__channel}`
- Compatibility mirror: `whatsappSessions/{restaurantId}` for `whatsapp-web`

## API Surface
- Generic channel session routes:
  - `POST /api/restaurants/:restaurantId/channels/:channel/session/start`
  - `POST /api/restaurants/:restaurantId/channels/:channel/session/disconnect`
  - `POST /api/restaurants/:restaurantId/channels/:channel/session/restart`
  - `GET /api/restaurants/:restaurantId/channels/:channel/session/status`
  - `GET /api/restaurants/:restaurantId/channels/:channel/session/qr`
- Legacy compatibility aliases kept:
  - `/api/restaurants/:restaurantId/whatsapp/session/*`
- Outbox ops endpoints:
  - `/api/restaurants/:restaurantId/outbox/messages`
  - `/api/restaurants/:restaurantId/outbox/messages/:messageId`
  - `/api/restaurants/:restaurantId/outbox/stats`
  - `/api/restaurants/:restaurantId/outbox/messages/:messageId/retry`
- Pilot ops snapshot endpoint:
  - `/api/restaurants/:restaurantId/ops/pilot-snapshot`

## Known Gaps
- Multi-tenant runtime idempotency in `whatsapp-bot` is currently in-memory per process (not durable across restart).
- No distributed shard coordinator yet; tenant-to-shard assignment is file/config driven.
- `functions/` Twilio code remains as legacy reference and should be removed behind feature-flag decommission plan.
