# Backend Deployment Checklist (MVP)

## 1) Required environment

Set in production environment:

- `NODE_ENV=production`
- `PORT` (default `3002`)
- `FIREBASE_SERVICE_ACCOUNT_PATH` or `GOOGLE_APPLICATION_CREDENTIALS`
- `BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME=false`
- `BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME=true`
- `WHATSAPP_RUNTIME_BASE_URL`
- `WHATSAPP_RUNTIME_API_KEY`
- `WHATSAPP_RUNTIME_REQUEST_TIMEOUT_MS` (default `15000`)
- `OUTBOX_INLINE_SEND_ENABLED=true`
- `OUTBOX_WORKER_ENABLED=true` (recommended in production)
- `OUTBOX_WORKER_POLL_MS`, `OUTBOX_WORKER_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS`

## 2) Startup sanity checks (fail-fast)

Backend startup now validates:

1. internal + external runtime both enabled -> startup fails.
2. external runtime enabled but URL/key missing -> startup fails.
3. both runtime modes disabled -> warning logged.
4. outbox inline + worker both disabled -> warning logged.

## 3) Build / run

```bash
cd backend
npm ci
npm run start
```

Outbox worker (separate process):

```bash
cd backend
OUTBOX_WORKER_ENABLED=true npm run worker:outbox
```

## 4) Post-deploy verification

1. `GET /health` returns `200` and `ok=true`.
2. `GET /status` returns `runtimeMode` and uptime.
3. `GET /api/v1/restaurants/:restaurantId/whatsapp/session/status` responds for at least one tenant.
4. `GET /api/v1/restaurants/:restaurantId/menu-items` returns data.
5. `GET /api/v1/restaurants/:restaurantId/outbox/stats` returns stats object.

## 5) Smoke path (recommended)

Run controlled smoke:

```bash
cd backend
npm run pilot:smoke -- --restaurantId <id> --apiKey <keyId.secret>
```

Notes:
- restart step is best-effort cleanup (non-fatal warning on timeout).
- if re-running frequently, use unique chatId/customerPhone to avoid stale active-order collisions.

## 6) Security and ops guardrails

1. Rotate runtime and API keys before production launch.
2. Restrict ingress to backend and runtime admin ports.
3. Ensure logs include request IDs and tenant IDs in deployment platform.
4. Alert on:
   - outbox failed count increase
   - runtime session status in `error|disconnected|paused|disabled`

## 7) Rollback basics

1. Keep previous backend image/build available.
2. Roll back backend first; preserve Firestore data.
3. Keep runtime tenant configs unchanged during backend rollback unless runtime endpoints changed.
