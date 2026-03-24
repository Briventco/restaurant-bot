# API Handoff (V1 Admin Portal)

This document is the frontend integration contract for the backend MVP.

## Base URL

Tenant base:

`https://<backend-host>/api/restaurants/{restaurantId}`

Health checks:

- `GET /health`
- `GET /status`

## Auth

All tenant routes require:

```http
x-api-key: <keyId>.<secret>
```

## Common response shapes

Success:

```json
{
  "success": true
}
```

Error:

```json
{
  "error": "Human readable message",
  "details": {
    "optional": "context"
  }
}
```

`details` appears only for some validation/transition errors.

## Endpoint list (V1 scope)

### Restaurant settings

- `GET /restaurant`
- `PUT /restaurant`
- `PATCH /restaurant/bot`

### Menu items

- `GET /menu-items`
- `POST /menu-items`
- `PATCH /menu-items/:itemId`
- `DELETE /menu-items/:itemId`

### Orders

- `GET /orders?status=<status>&limit=<n>`
- `GET /orders/:orderId`
- `GET /orders/:orderId/messages?limit=<n>`
- `POST /orders/:orderId/confirm`
- `POST /orders/:orderId/approve` (alias of confirm)
- `POST /orders/:orderId/unavailable-items`
- `POST /orders/:orderId/transition`
- `POST /orders/:orderId/cancel`

### Payment review

- `POST /orders/:orderId/payment-receipts`
- `GET /orders/:orderId/payment-receipts`
- `POST /orders/:orderId/payment-review/confirm`
- `POST /orders/:orderId/payment-review/reject`

### Delivery zones

- `GET /delivery-zones`
- `POST /delivery-zones`
- `PATCH /delivery-zones/:zoneId`
- `DELETE /delivery-zones/:zoneId`

### WhatsApp session

- `GET /whatsapp/session/status`
- `POST /whatsapp/session/start`
- `POST /whatsapp/session/disconnect`
- `POST /whatsapp/session/restart`
- `GET /whatsapp/session/qr`

### Outbox (ops/admin)

- `GET /outbox/messages?status=<status>&limit=<n>`
- `GET /outbox/messages/:messageId`
- `GET /outbox/stats`
- `POST /outbox/messages/:messageId/retry`

## Request / response examples

### 1) Update restaurant settings

`PUT /restaurant`

```json
{
  "name": "Lead Mall",
  "timezone": "Africa/Lagos",
  "flow": {
    "allowDirectAwaitingPaymentFromPending": false
  },
  "bot": {
    "enabled": true,
    "ignoreGroupChats": true,
    "allowedChannels": ["whatsapp-web"]
  }
}
```

Response:

```json
{
  "restaurant": {
    "id": "lead_mall",
    "name": "Lead Mall"
  }
}
```

### 2) Create menu item

`POST /menu-items`

```json
{
  "name": "Jollof rice",
  "price": 1500,
  "available": true
}
```

Response:

```json
{
  "item": {
    "id": "abc123",
    "name": "Jollof rice",
    "price": 1500,
    "available": true
  }
}
```

### 3) Approve (confirm) order

`POST /orders/:orderId/approve`

Response:

```json
{
  "success": true,
  "message": "Order approved and customer notified",
  "order": {
    "id": "order_1",
    "status": "confirmed"
  }
}
```

### 4) Mark unavailable items

`POST /orders/:orderId/unavailable-items`

```json
{
  "items": ["Fish"],
  "note": "Out of stock"
}
```

Response:

```json
{
  "success": true,
  "message": "Customer notified successfully",
  "order": {
    "id": "order_2",
    "status": "awaiting_customer_update",
    "unavailableItems": ["Fish"]
  }
}
```

### 5) Cancel order

`POST /orders/:orderId/cancel`

```json
{
  "reason": "customer_requested_cancel"
}
```

Response:

```json
{
  "success": true,
  "order": {
    "id": "order_3",
    "status": "cancelled"
  }
}
```

### 6) Payment review confirm

`POST /orders/:orderId/payment-review/confirm`

```json
{
  "receiptId": "receipt_1",
  "note": "Verified transfer"
}
```

Response:

```json
{
  "success": true,
  "order": {
    "id": "order_4",
    "status": "confirmed",
    "paymentState": "paid"
  },
  "receipt": {
    "id": "receipt_1",
    "status": "approved"
  }
}
```

### 7) Payment review reject

`POST /orders/:orderId/payment-review/reject`

```json
{
  "receiptId": "receipt_1",
  "reason": "amount_mismatch",
  "note": "Please resubmit receipt"
}
```

Response:

```json
{
  "success": true,
  "order": {
    "id": "order_4",
    "status": "awaiting_payment",
    "paymentState": "rejected"
  },
  "receipt": {
    "id": "receipt_1",
    "status": "rejected"
  }
}
```

### 8) Delivery zone create

`POST /delivery-zones`

```json
{
  "name": "Ikeja",
  "fee": 1000,
  "etaMinutes": 45,
  "enabled": true,
  "notes": "Mainland delivery"
}
```

Response:

```json
{
  "success": true,
  "zone": {
    "id": "zone_1",
    "name": "Ikeja",
    "fee": 1000,
    "etaMinutes": 45,
    "enabled": true
  }
}
```

### 9) WhatsApp session status

`GET /whatsapp/session/status`

Response:

```json
{
  "session": {
    "restaurantId": "lead_mall",
    "status": "connected",
    "runtimeOwner": "external-whatsapp-runtime"
  }
}
```

### 10) Outbox stats

`GET /outbox/stats`

Response:

```json
{
  "stats": {
    "counts": {
      "queued": 0,
      "processing": 0,
      "sent": 10,
      "failed": 0
    },
    "pendingTotal": 0
  }
}
```

## Notes for frontend

- Use `restaurantId` in path for every tenant-scoped call.
- Prefer dedicated action endpoints (`approve`, `cancel`, `payment-review/*`) for UI actions.
- `POST /orders/:orderId/transition` remains available for advanced/manual transitions.
