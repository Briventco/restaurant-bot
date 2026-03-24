# MVP Endpoint Inventory (Admin Portal)

This inventory maps the backend route surface to the V1 admin portal scope.

## Exists (usable)

1. Restaurant details/settings
- `GET /api/restaurants/:restaurantId/restaurant`
- `PUT /api/restaurants/:restaurantId/restaurant`
- `PATCH /api/restaurants/:restaurantId/restaurant/bot`

2. Menu CRUD
- `GET /api/restaurants/:restaurantId/menu-items`
- `POST /api/restaurants/:restaurantId/menu-items`
- `PATCH /api/restaurants/:restaurantId/menu-items/:itemId`
- `DELETE /api/restaurants/:restaurantId/menu-items/:itemId`

3. Orders
- `GET /api/restaurants/:restaurantId/orders`
- `GET /api/restaurants/:restaurantId/orders/:orderId`
- `GET /api/restaurants/:restaurantId/orders/:orderId/messages`
- `POST /api/restaurants/:restaurantId/orders/:orderId/confirm`
- `POST /api/restaurants/:restaurantId/orders/:orderId/unavailable-items`
- `POST /api/restaurants/:restaurantId/orders/:orderId/transition`

4. WhatsApp session status/control
- `GET /api/restaurants/:restaurantId/whatsapp/session/status`
- `POST /api/restaurants/:restaurantId/whatsapp/session/start`
- `POST /api/restaurants/:restaurantId/whatsapp/session/disconnect`
- `POST /api/restaurants/:restaurantId/whatsapp/session/restart`
- `GET /api/restaurants/:restaurantId/whatsapp/session/qr`

5. Outbox
- `GET /api/restaurants/:restaurantId/outbox/messages`
- `GET /api/restaurants/:restaurantId/outbox/messages/:messageId`
- `GET /api/restaurants/:restaurantId/outbox/stats`
- `POST /api/restaurants/:restaurantId/outbox/messages/:messageId/retry`

6. Health/deploy checks
- `GET /health`
- `GET /status`

## Added for MVP completion

1. Explicit order actions
- `POST /api/restaurants/:restaurantId/orders/:orderId/approve`
- `POST /api/restaurants/:restaurantId/orders/:orderId/cancel`

2. Payment review actions
- `POST /api/restaurants/:restaurantId/orders/:orderId/payment-review/confirm`
- `POST /api/restaurants/:restaurantId/orders/:orderId/payment-review/reject`

3. Delivery zones CRUD
- `GET /api/restaurants/:restaurantId/delivery-zones`
- `POST /api/restaurants/:restaurantId/delivery-zones`
- `PATCH /api/restaurants/:restaurantId/delivery-zones/:zoneId`
- `DELETE /api/restaurants/:restaurantId/delivery-zones/:zoneId`

## Updated (non-breaking)

1. Session restart timeout control
- `POST /api/restaurants/:restaurantId/whatsapp/session/restart`
  accepts optional `requestTimeoutMs` for safer operational control.

2. Startup validation
- backend now fails fast for invalid runtime mode/env combinations.

## Still out of MVP scope

1. Advanced delivery pricing logic (distance/time matrix).
2. Fully automated payment reconciliation provider integrations.
3. Marketplace/shared-number behavior (intentionally excluded).
