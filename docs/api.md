# API Reference

Base URL: `http://localhost:4000/api/v1`

## Envelopes

Every response uses one of two standard envelopes.

**Success**
```json
{
  "success": true,
  "data": { "...": "resource or array" },
  "meta": { "page": 1, "limit": 20, "total": 150, "totalPages": 8 }
}
```
`meta` appears only on paginated list endpoints.

**Error**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [{ "field": "priority", "message": "Must be between 1 and 10" }]
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Malformed request |
| `VALIDATION_ERROR` | 400 | Zod validation failure (`details[]` has field errors) |
| `UNAUTHORIZED` | 401 | Missing/invalid token or worker token |
| `FORBIDDEN` | 403 | RBAC role insufficient |
| `NOT_FOUND` | 404 | Resource missing |
| `CONFLICT` | 409 | Unique constraint violation |
| `RATE_LIMITED` | 429 | Over 100 requests/min per user |

**Authentication**: all routes except `/auth/*` and worker-internal endpoints require `Authorization: Bearer <accessToken>`.
**RBAC hierarchy**: `VIEWER < MEMBER < ADMIN < OWNER` — enforced server-side on every org-scoped route.

---

## Auth

### POST `/auth/register`
Auth: none. Creates a user, returns a JWT pair.

```json
// Request
{ "email": "alice@example.com", "password": "supersecret1", "name": "Alice" }
```
```json
// Response 201
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
    "user": { "id": "0f8a...", "email": "alice@example.com", "name": "Alice" }
  }
}
```

### POST `/auth/login`
Auth: none.
```json
// Request
{ "email": "demo@jobscheduler.dev", "password": "demo1234" }
```
Response `200`: same shape as register.

### POST `/auth/refresh`
Auth: none. Token rotation — old refresh token is replaced by the new pair.
```json
// Request
{ "refreshToken": "<refreshToken>" }
```
```json
// Response 200
{ "success": true, "data": { "accessToken": "...", "refreshToken": "...", "user": { } } }
```

### GET `/auth/me`
Auth: Bearer token. → `{ "success": true, "data": { "id", "email", "name", "createdAt" } }`

### POST `/auth/logout`
Auth: Bearer token. Stateless — client discards tokens.
→ `{ "success": true, "data": { "message": "Logged out" } }`

---

## Organizations

### POST `/orgs` — auth: Bearer · role: any authenticated user
The creator automatically becomes OWNER in the same transaction.
```json
// Request
{ "name": "Acme Corp", "description": "Demo organization" }
```
```json
// Response 201
{ "success": true, "data": { "id": "3baf…", "name": "Acme Corp", "slug": "acme", "description": "Demo organization" } }
```

### GET `/orgs` — auth: Bearer
Lists my organizations with my role.
```json
// Response 200
{ "success": true, "data": [ { "id": "…", "slug": "acme", "name": "Acme Corp", "myRole": "OWNER", "_count": { "projects": 1, "members": 2 } } ] }
```

### GET `/orgs/:orgSlug` — role: VIEWER+
Returns org with members (id, name, email, role).

### PATCH `/orgs/:orgSlug` — role: ADMIN+
Body: `{ "name?": "New name", "description?": "…" }` → updated org.

### DELETE `/orgs/:orgSlug` — role: OWNER
Cascade-deletes projects, queues and jobs. → `{ "success": true, "data": { "deleted": true } }`

### POST `/orgs/:orgSlug/members` — role: ADMIN+
```json
// Request
{ "email": "bob@example.com", "role": "MEMBER" }   // role: ADMIN | MEMBER | VIEWER
```
Response `201`: membership object incl. user info. `404` if no such user, `409` if already a member.

### PATCH `/orgs/:orgSlug/members/:userId` — role: ADMIN+ (OWNER required to grant OWNER)
Body: `{ "role": "ADMIN" }` → updated membership.

### DELETE `/orgs/:orgSlug/members/:userId` — role: ADMIN+
Removes a member. The org OWNER cannot be removed (`403`).

---

## Projects — `/orgs/:orgSlug/projects`

| Method | Path | Role | Body / notes |
|---|---|---|---|
| POST | `/` | ADMIN+ | `{ "name": "Platform Jobs", "description?" : "…" }` → 201, slug auto-generated |
| GET | `/` | VIEWER+ | List with `_count.queues` |
| GET | `/:projectSlug` | VIEWER+ | Single project |
| PATCH | `/:projectSlug` | ADMIN+ | Partial `{ name?, description? }` |
| DELETE | `/:projectSlug` | OWNER | Cascade-deletes queues + jobs |

---

## Retry Policies — `/projects/:projectId/retry-policies`

### POST `/` — role: ADMIN+
```json
// Request
{
  "name": "Aggressive Retry",
  "strategy": "EXPONENTIAL",        // FIXED | LINEAR | EXPONENTIAL
  "maxAttempts": 5,
  "initialDelayMs": 1000,
  "maxDelayMs": 60000,
  "multiplier": 2
}
```
```json
// Response 201
{ "success": true, "data": { "id": "pol_…", "strategy": "EXPONENTIAL", "maxAttempts": 5, … } }
```

GET `/` · GET `/:policyId` (VIEWER+) · PATCH `/:policyId` (ADMIN+, partial body) · DELETE `/:policyId` (ADMIN+)

---

## Queues

Base: `/projects/:projectId/queues`. Dashboard aliases: `GET /queues/:queueId` and `GET /queues/:queueId/stats`.

### POST `/` — role: ADMIN+
```json
// Request
{
  "name": "Emails",
  "description": "Outbound email delivery",
  "priority": 8,                    // 1–10 scheduling weight
  "concurrencyLimit": 20,
  "rateLimitPerMin": 60,            // optional, null = unlimited
  "retryPolicyId": "pol_…",         // optional default retry policy
  "shardKey": null                  // optional shard partition
}
```
```json
// Response 201
{ "success": true, "data": { "id": "q_…", "slug": "emails", "isPaused": false, … } }
```

### GET `/?page=1&limit=20&isPaused=false` — role: VIEWER+
Queues with **live stats** attached:
```json
// Response 200
{
  "success": true,
  "data": [{
    "id": "q_…", "name": "Default", "isPaused": false,
    "stats": {
      "pending": 4, "scheduled": 1, "running": 2, "completed": 49,
      "failed": 1, "dead": 1, "depth": 5,
      "throughputPerMin": 3, "failureRate": 0.039, "avgDurationMs": 583
    }
  }],
  "meta": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}
```

### PATCH `/:queueId` — role: ADMIN+ · partial config update
### DELETE `/:queueId` — role: ADMIN+ · cascades jobs
### POST `/:queueId/pause` / POST `/:queueId/resume` — role: ADMIN+
Paused queues are skipped by the claim query itself (kill switch inside SQL).

### GET `/:queueId/stats?from&to` — role: VIEWER+
Live counters plus hourly timeline:
```json
// Response 200
{
  "success": true,
  "data": {
    "live": { "depth": 5, "throughputPerMin": 3, "failureRate": 0.039, "avgDurationMs": 583, … },
    "timeline": [ { "bucket": "2026-08-23T14:00:00.000Z", "completed": 12, "failed": 1, "avgDurationMs": 512 } ],
    "from": "…", "to": "…"
  }
}
```

---

## Jobs

Base: `/queues/:queueId/jobs`. Detail alias: `GET /jobs/:jobId` (no queue id needed).

### POST `/` — role: MEMBER+ — create job (all shapes)

**Immediate**
```json
// Request
{ "type": "report", "payload": { "name": "nightly-usage" }, "priority": 7 }
```
```json
// Response 201
{ "success": true, "data": { "job": { "id": "j_…", "status": "PENDING", "idempotencyKey": null } } }
```

**Delayed** — add `"runAt": "2026-12-01T10:00:00Z"` → status `SCHEDULED` until due.

**Batch** (atomic transaction)
```json
// Request
{
  "type": "report",
  "payload": {},
  "batch": {
    "name": "weekly-digest",
    "jobs": [
      { "payload": { "userId": "1" }, "priority": 7 },
      { "payload": { "userId": "2" } }
    ]
  },
  "idempotencyKey": "digest-w48"
}
```
```json
// Response 201
{ "success": true, "data": {
    "job": { "id": "j_first…", "status": "PENDING" },
    "batch": { "id": "b_…", "name": "weekly-digest", "totalJobs": 2 }
} }
```

**With dependencies**
```json
// Request
{ "type": "report", "payload": {}, "dependsOn": ["<jobId-a>", "<jobId-b>"] }
```
The job stays unclaimable until every dependency is COMPLETED — enforced atomically inside the claim query.

**Other options**: `maxAttempts`, `timeoutMs`, `tags: string[]`, `metadata: object`, `idempotencyKey` (duplicate submissions return the original job instead of creating one).
Errors: `400 VALIDATION_ERROR` for bad fields (e.g. priority > 10), `400 BAD_REQUEST` if a `dependsOn` id doesn't exist.

### GET `/?status=FAILED,DEAD&type=email&tags=digest&from=…&to=…&sort=createdAt:desc&page=1&limit=20`
Query params: multi-value `status` (CSV of enum values), exact `type`, CSV `tags` (hasSome match), date range on `createdAt`, `sort` as `<field>:<asc|desc>` over `createdAt|priority|runAt`. Paginated response with slimmed rows.

### GET `/:jobId` — full detail
```json
// Response 200 (abridged)
{ "success": true, "data": {
    "id": "j_…", "type": "email", "status": "DEAD",
    "payload": { "to": "user@example.com" }, "attemptCount": 2, "maxAttempts": 2,
    "executions": [
      { "id": "e2", "attemptNumber": 2, "status": "FAILED", "durationMs": 350, "error": "Simulated email delivery failure", "logs": [ … ] },
      { "id": "e1", "attemptNumber": 1, "status": "FAILED", "durationMs": 340, "error": "…" }
    ],
    "dependsOn": [], "dependedBy": [],
    "dlqEntry": { "id": "d_…", "reason": "Max attempts exhausted", "aiSummary": null },
    "retryPolicy": null
} }
```

### DELETE `/:jobId` — role: MEMBER+ — cancel
Only `PENDING`/`SCHEDULED`/`RETRYING`; otherwise `400 BAD_REQUEST`. → `{ "data": { "id", "status": "CANCELLED" } }`

### POST `/:jobId/retry` — role: MEMBER+
Re-queues FAILED/DEAD/CANCELLED jobs: resets attempts to 0 and clears timestamps. Removes any DLQ entry.

### GET `/:jobId/executions` — attempt history (newest first)
### GET `/:jobId/executions/:execId/logs` — ordered logs of one attempt (≤500 lines)

---

## Scheduled Jobs (cron) — `/queues/:queueId/schedules`

### POST `/` — role: ADMIN+
```json
// Request
{
  "name": "Every minute heartbeat",
  "cronExpression": "* * * * *",
  "jobType": "report",
  "jobPayload": { "name": "heartbeat" },
  "jobPriority": 5,
  "timezone": "UTC"
}
```
Invalid cron/timezone → `400 BAD_REQUEST`.
```json
// Response 201
{ "success": true, "data": { "id": "s_…", "nextRunAt": "2026-08-23T14:16:00.000Z", "isActive": true, … } }
```

GET `/` — list with computed `nextRunAt` countdown · GET `/:scheduleId`
PATCH `/:scheduleId` (ADMIN+) — `{ "cronExpression?", "isActive?", "jobPayload?", "name?" }` (recomputes nextRunAt when cron changes)
DELETE `/:scheduleId` (ADMIN+)
POST `/:scheduleId/trigger` (MEMBER+) — fires immediately: creates the job now, records `lastJobId`.

Cron firing itself happens in the API's scheduler loop under a Redis Redlock — safe across multiple API instances.

---

## Workers

Worker-internal endpoints authenticate with header `x-worker-token: $WORKER_INTERNAL_TOKEN` (not JWT). Dashboard endpoints use JWT.

### POST `/workers/register` — auth: x-worker-token
```json
// Request
{ "hostname": "worker-pod-1", "pid": 123, "concurrency": 5, "queueId": null, "shardKey": null, "version": "1.0.0" }
```
```json
// Response 201
{ "success": true, "data": { "id": "w_…", "registeredAt": "…" } }
```

### POST `/workers/:workerId/heartbeat` — auth: x-worker-token
```json
// Request
{ "status": "ACTIVE", "jobsRunning": 2, "jobsDone": 41, "memoryMb": 120.5, "cpuPercent": null }
```
→ `{ "success": true, "data": { "id", "status", "lastHeartbeat" } }` (also appends a `worker_heartbeats` row)

### GET `/workers` — auth: Bearer
Fleet list: hostname, pid, status, concurrency, shardKey, queue, jobsRunning, lastHeartbeat. Stale workers (>60 s silent) report as `DEAD`.

### GET `/workers/:workerId` — auth: Bearer
Detail with recent heartbeat history (30) and last 20 jobs.

### POST `/workers/:workerId/drain` — role: ADMIN+
Sets status to `DRAINING` — finishes current work, claims nothing new.

---

## Dead Letter Queue — `/queues/:queueId/dlq`

### GET `/?isResolved=false&page=1&limit=20` — role: VIEWER+
```json
// Response 200
{ "success": true, "data": [
  { "id": "d_…", "jobId": "j_…", "reason": "Max attempts exhausted", "attempts": 2,
    "failedAt": "…", "lastError": "Simulated email delivery failure",
    "aiSummary": "The email provider returned a persistent 5xx…",
    "isResolved": false,
    "job": { "id": "j_…", "type": "email", "status": "DEAD", "attemptCount": 2, "maxAttempts": 2 } }
], "meta": { … } }
```

### GET `/:entryId` — role: VIEWER+ — entry + full job + all executions
### POST `/:entryId/retry` — role: MEMBER+
Resets the job (attempts → 0, status → PENDING) and deletes the DLQ entry in one transaction.
→ `{ "success": true, "data": { "id": "j_…", "status": "PENDING" } }`

### POST `/:entryId/resolve` — role: MEMBER+ — marks resolved (no requeue)
### DELETE `/:entryId` — role: ADMIN+ — permanent delete

---

## Events

### POST `/events` — role: MEMBER+ — fire an event
```json
// Request
{ "name": "user.signed_up", "payload": { "email": "newbie@example.com", "name": "Newbie" }, "source": "web-app" }
```
Matching active triggers interpolate their templates (`{{event.email}}` → value) and spawn jobs.
```json
// Response 201
{ "success": true, "data": {
    "event": { "id": "ev_…", "name": "user.signed_up", "processedAt": "…" },
    "triggeredJobIds": ["j_…"],
    "triggeredCount": 1
} }
```

### GET `/events?name=user.signed_up&from&to&page&limit` — role: VIEWER+ — history
### GET `/events/:eventId` — role: VIEWER+ — event + triggered jobs with statuses

### Event triggers
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/events/triggers` | ADMIN+ | `{ "queueId", "eventName", "jobType", "jobPayloadTmpl", "jobPriority?" }` |
| GET | `/events/triggers` | VIEWER+ | List with queue names |
| PATCH | `/events/triggers/:id` | ADMIN+ | `{ "isActive": boolean }` |
| DELETE | `/events/triggers/:id` | ADMIN+ | Remove trigger |

Template syntax — nested paths supported, whole-string placeholders preserve types:
```json
{ "to": "{{event.email}}", "subject": "Welcome, {{event.profile.name}}!" }
```

---

## Metrics — `/projects/:projectId/metrics`

### GET `/?granularity=hour|day&from&to` — role: VIEWER+
All figures computed live from job rows — never cached or mocked.
```json
// Response 200
{
  "success": true,
  "data": {
    "from": "…", "to": "…", "granularity": "hour",
    "timeline": [
      { "bucket": "2026-08-23T13:00:00.000Z", "completed": 31, "failed": 2 }
    ],
    "totals": {
      "pending": 3, "scheduled": 1, "running": 0, "completed": 49,
      "failed": 1, "dead": 1, "cancelled": 0,
      "failureRate": 0.039, "avgDurationMs": 583
    },
    "queueDepths": [ { "id": "q_…", "name": "Default", "isPaused": false, "depth": 4 } ],
    "workerHealth": [ { "status": "ACTIVE", "count": 1 } ]
  }
}
```

### GET `/metrics/workers` — role: VIEWER+ — worker fleet health snapshot
Each entry includes an `effectiveStatus` (stale-heartbeat workers report DEAD even before the reaper sweep runs).
