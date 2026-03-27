# Portal Auth Architecture (Firebase Auth + Firestore Profiles)

This backend now supports portal user auth with Firebase ID tokens, while keeping legacy API-key auth for existing integrations.

## Identity + Profile Model

- Identity: Firebase Auth user (`uid`) verified from `Authorization: Bearer <idToken>`.
- Profile store: Firestore `users/{uid}`.
- Backend authorization source: Firestore profile role + permissions.

## User Profile Schema

Path:

`users/{uid}`

Required fields:

- `uid`
- `email`
- `displayName`
- `role` (`super_admin` | `restaurant_admin` | `restaurant_staff`)
- `restaurantId` (`null` for `super_admin`, required for restaurant roles)
- `permissions` (array, `["*"]` allowed for super admin)
- `isActive` (boolean)
- `createdAt`
- `updatedAt`

## Example Seed Documents

`users/firebase_uid_123`:

```json
{
  "uid": "firebase_uid_123",
  "email": "owner@leadmall.com",
  "displayName": "Lead Mall Owner",
  "role": "restaurant_admin",
  "restaurantId": "lead_mall",
  "permissions": [
    "orders.read",
    "orders.update",
    "menu.read",
    "menu.write",
    "payments.read",
    "payments.review",
    "delivery.read",
    "delivery.write",
    "whatsapp.read",
    "settings.read",
    "settings.write"
  ],
  "isActive": true
}
```

`users/firebase_uid_super_1`:

```json
{
  "uid": "firebase_uid_super_1",
  "email": "ops@brivent.com",
  "displayName": "Brivent Ops",
  "role": "super_admin",
  "restaurantId": null,
  "permissions": ["*"],
  "isActive": true
}
```

## Middleware Layer

- `requireAuth`
  - Verifies Firebase ID token.
  - Loads `users/{uid}`.
  - Rejects missing/invalid token, missing profile, inactive user.
  - Attaches:
    - `req.user = { uid, email, displayName, role, restaurantId, permissions }`
    - compatible `req.auth` object for existing business handlers.

- `requireRole(...roles)`
  - Enforces role membership.

- `requirePermission(...permissions)`
  - Supports `allOf` + `anyOf` rules.
  - `*` bypasses all permission checks.

- `requireRestaurantScope`
  - `super_admin`: allowed across restaurants.
  - other roles: `req.user.restaurantId` must match `:restaurantId`.

## Route Protection Behavior

- `/api/v1/auth/*`: portal auth lifecycle.
- `/api/v1/admin/*`: `requireAuth + requireRole("super_admin")`.
- `/api/v1/restaurants/:restaurantId/*`: hybrid auth for migration:
  - if `Authorization` header is present: portal auth + restaurant scope + permission checks.
  - otherwise: legacy `x-api-key` behavior.

## Default Role Permission Map

- `super_admin`: `["*"]`
- `restaurant_admin`: broad operations permissions (orders/menu/payments/delivery/sessions/settings/outbox).
- `restaurant_staff`: read + limited write permissions.

See implementation in `src/auth/permissions.js`.

## Error Shape

Portal auth middleware and auth routes return:

```json
{
  "success": false,
  "error": {
    "code": "token_invalid",
    "message": "Invalid or expired authentication token"
  }
}
```

Common codes:

- `missing_token`
- `token_invalid`
- `user_profile_missing`
- `user_inactive`
- `forbidden`
- `forbidden_scope`
