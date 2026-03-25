# MVP Endpoint Inventory (Admin Portal)

This inventory maps the backend route surface to the V1 admin portal scope.

## Exists (usable)

1. Restaurant details/settings
- `GET /api/v1/restaurants/:restaurantId/restaurant`
- `PUT /api/v1/restaurants/:restaurantId/restaurant`
- `PATCH /api/v1/restaurants/:restaurantId/restaurant/bot`

2. Menu CRUD
- `GET /api/v1/restaurants/:restaurantId/menu-items`
- `POST /api/v1/restaurants/:restaurantId/menu-items`
- `PATCH /api/v1/restaurants/:restaurantId/menu-items/:itemId`
- `DELETE /api/v1/restaurants/:restaurantId/menu-items/:itemId`

3. Orders
- `GET /api/v1/restaurants/:restaurantId/orders`
- `GET /api/v1/restaurants/:restaurantId/orders/:orderId`
- `GET /api/v1/restaurants/:restaurantId/orders/:orderId/messages`
- `POST /api/v1/restaurants/:restaurantId/orders/:orderId/confirm`
- `POST /api/v1/restaurants/:restaurantId/orders/:orderId/unavailable-items`
- `POST /api/v1/restaurants/:restaurantId/orders/:orderId/transition`

4. WhatsApp session status/control
- `GET /api/v1/restaurants/:restaurantId/whatsapp/session/status`
- `POST /api/v1/restaurants/:restaurantId/whatsapp/session/start`
- `POST /api/v1/restaurants/:restaurantId/whatsapp/session/disconnect`
- `POST /api/v1/restaurants/:restaurantId/whatsapp/session/restart`
- `GET /api/v1/restaurants/:restaurantId/whatsapp/session/qr`

5. Outbox
- `GET /api/v1/restaurants/:restaurantId/outbox/messages`
- `GET /api/v1/restaurants/:restaurantId/outbox/messages/:messageId`
- `GET /api/v1/restaurants/:restaurantId/outbox/stats`
- `POST /api/v1/restaurants/:restaurantId/outbox/messages/:messageId/retry`

6. Health/deploy checks
- `GET /health`
- `GET /status`

## Added for MVP completion

1. Explicit order actions
- `POST /api/v1/restaurants/:restaurantId/orders/:orderId/approve`
- `POST /api/v1/restaurants/:restaurantId/orders/:orderId/cancel`

2. Payment review actions
- `POST /api/v1/restaurants/:restaurantId/orders/:orderId/payment-review/confirm`
- `POST /api/v1/restaurants/:restaurantId/orders/:orderId/payment-review/reject`

3. Delivery zones CRUD
- `GET /api/v1/restaurants/:restaurantId/delivery-zones`
- `POST /api/v1/restaurants/:restaurantId/delivery-zones`
- `PATCH /api/v1/restaurants/:restaurantId/delivery-zones/:zoneId`
- `DELETE /api/v1/restaurants/:restaurantId/delivery-zones/:zoneId`

## Updated (non-breaking)

1. Session restart timeout control
- `POST /api/v1/restaurants/:restaurantId/whatsapp/session/restart`
  accepts optional `requestTimeoutMs` for safer operational control.

2. Startup validation
- backend now fails fast for invalid runtime mode/env combinations.

## Still out of MVP scope

1. Advanced delivery pricing logic (distance/time matrix).
2. Fully automated payment reconciliation provider integrations.
3. Marketplace/shared-number behavior (intentionally excluded).
