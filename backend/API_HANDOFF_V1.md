# API Handoff (V1 Admin Portal)

This document is the frontend integration contract for the backend MVP.

## Base URL

Versioned API base:

`https://<backend-host>/api/v1`

Tenant base:

`https://<backend-host>/api/v1/restaurants/{restaurantId}`

Production deployment:

`https://restaurant-bot-11mh.onrender.com/api/v1`

Public/infra endpoints:

- `GET /`
- `GET /api/v1/health` (canonical)
- `GET /api/v1/status` (canonical)
- `GET /health` (alias of `/api/v1/health`)
- `GET /status` (alias of `/api/v1/status`)

## Auth

Portal user auth (recommended):

```http
Authorization: Bearer <firebase-id-token>
```

Legacy/internal fallback (still supported):

```http
x-api-key: <keyId>.<secret>
```

Auth endpoints:

- `POST /api/v1/auth/session`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/logout`

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

### Portal auth

- `POST /api/v1/auth/session`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/logout`

### Super admin scaffold

- `GET /api/v1/admin/dashboard`
- `GET /api/v1/admin/restaurants`
- `GET /api/v1/admin/restaurants/{restaurantId}`
- `GET /api/v1/admin/sessions`
- `GET /api/v1/admin/outbox`

### Restaurant settings

- `GET /api/v1/restaurants/{restaurantId}/restaurant`
- `PUT /api/v1/restaurants/{restaurantId}/restaurant`
- `PATCH /api/v1/restaurants/{restaurantId}/restaurant/bot`

### Menu items

- `GET /api/v1/restaurants/{restaurantId}/menu-items`
- `POST /api/v1/restaurants/{restaurantId}/menu-items`
- `PATCH /api/v1/restaurants/{restaurantId}/menu-items/{itemId}`
- `DELETE /api/v1/restaurants/{restaurantId}/menu-items/{itemId}`

### Orders

- `GET /api/v1/restaurants/{restaurantId}/orders?status=<status>&limit=<n>`
- `GET /api/v1/restaurants/{restaurantId}/orders/{orderId}`
- `GET /api/v1/restaurants/{restaurantId}/orders/{orderId}/messages?limit=<n>`
- `POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/confirm`
- `POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/approve` (alias of confirm)
- `POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/unavailable-items`
- `POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/transition`
- `POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/cancel`

### Payment review

- `POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/payment-receipts`
- `GET /api/v1/restaurants/{restaurantId}/orders/{orderId}/payment-receipts`
- `POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/payment-review/confirm`
- `POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/payment-review/reject`

### Delivery zones

- `GET /api/v1/restaurants/{restaurantId}/delivery-zones`
- `POST /api/v1/restaurants/{restaurantId}/delivery-zones`
- `PATCH /api/v1/restaurants/{restaurantId}/delivery-zones/{zoneId}`
- `DELETE /api/v1/restaurants/{restaurantId}/delivery-zones/{zoneId}`

### WhatsApp session

- `GET /api/v1/restaurants/{restaurantId}/whatsapp/session/status`
- `POST /api/v1/restaurants/{restaurantId}/whatsapp/session/start`
- `POST /api/v1/restaurants/{restaurantId}/whatsapp/session/disconnect`
- `POST /api/v1/restaurants/{restaurantId}/whatsapp/session/restart`
- `GET /api/v1/restaurants/{restaurantId}/whatsapp/session/qr`
- `GET /api/v1/restaurants/{restaurantId}/whatsapp/session/qr?includeImage=true`

### Outbox (ops/admin)

- `GET /api/v1/restaurants/{restaurantId}/outbox/messages?status=<status>&limit=<n>`
- `GET /api/v1/restaurants/{restaurantId}/outbox/messages/{messageId}`
- `GET /api/v1/restaurants/{restaurantId}/outbox/stats`
- `POST /api/v1/restaurants/{restaurantId}/outbox/messages/{messageId}/retry`

## Request / response examples

### 1) Update restaurant settings

`PUT /api/v1/restaurants/{restaurantId}/restaurant`

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

`POST /api/v1/restaurants/{restaurantId}/menu-items`

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

`POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/approve`

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

`POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/unavailable-items`

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

`POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/cancel`

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

`POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/payment-review/confirm`

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

`POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/payment-review/reject`

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

`POST /api/v1/restaurants/{restaurantId}/delivery-zones`

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

`GET /api/v1/restaurants/{restaurantId}/whatsapp/session/status`

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

### 9b) WhatsApp session QR

`GET /api/v1/restaurants/{restaurantId}/whatsapp/session/qr?includeImage=true`

Response (shape varies by runtime/provider):

```json
{
  "qr": {
    "qr": "2@abc...raw_qr_text_or_base64...",
    "generatedAtMs": 1743200000000,
    "expiresAtMs": 1743200120000,
    "imageDataUrl": "data:image/png;base64,iVBORw0KGgo..."
  }
}
```

Frontend handling rule:
- prefer `qr.imageDataUrl` when present
- otherwise render `qr.qr` as a QR image client-side (raw text fallback)

### 10) Outbox stats

`GET /api/v1/restaurants/{restaurantId}/outbox/stats`

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
- For portal requests, send Firebase ID token in `Authorization: Bearer <token>`.
- Legacy `x-api-key` remains valid for migration and internal integrations.
- `/api/v1/admin/*` endpoints require `super_admin` role.
- Prefer dedicated action endpoints (`approve`, `cancel`, `payment-review/*`) for UI actions.
- `POST /api/v1/restaurants/{restaurantId}/orders/{orderId}/transition` remains available for advanced/manual transitions.
