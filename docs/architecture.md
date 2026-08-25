# Architecture

JobScheduler is a distributed job scheduling platform where a React dashboard talks to an Express API that persists all state in PostgreSQL and coordinates through Redis. Standalone worker processes poll the API's queue tables using a single atomic `FOR UPDATE SKIP LOCKED` statement — guaranteeing that no job is ever claimed by two workers — while background scheduler loops inside the API handle cron firing, delayed-job promotion, dead-worker recovery, and dependency notifications. Workers register themselves, heartbeat every 10 seconds so the reaper can detect crashes and requeue orphaned work, and stream execution logs back into the database; the dashboard subscribes over Socket.io to live job, worker, queue, and DLQ events so operators see state changes the moment they happen.

## System diagram

```mermaid
flowchart TB
    subgraph CLIENT["Client Layer"]
        DASH["React Dashboard<br/>(Vite + Tailwind + Recharts)"]
    end

    subgraph API["API Server :4000 (Express)"]
        direction TB
        REST["REST routes /api/v1<br/>auth · orgs · projects · queues · jobs<br/>schedules · workers · dlq · events · metrics"]
        MW["Middleware chain<br/>helmet → cors → JSON → JWT auth → RBAC → Zod validate → Redis rate limit"]
        SCHEDULER["Scheduler Service (in-process loops)<br/>• cron runner (60s)<br/>• delayed/retry promoter (15s)<br/>• dead reaper (30s)<br/>• dependency checker (10s)"]
        WS["Socket.io Server<br/>rooms: queue:&lt;id&gt;, workers"]
    end

    subgraph WORKERS["Worker Service — 2 instances (scalable to N)"]
        W1["Worker 1<br/>bounded concurrency=5"]
        W2["Worker 2<br/>bounded concurrency=5"]
    end

    PG[("PostgreSQL 16<br/>jobs · executions · logs · workers<br/>schedules · DLQ · events")]
    REDIS[("Redis 7<br/>Redlock locks · rate-limit buckets")]

    DASH -- "HTTP REST + WebSocket" --> MW
    MW --> REST
    REST -- "Prisma queries / transactions" --> PG
    REST -- "token bucket check" --> REDIS
    SCHEDULER -- "cron fire guarded by Redlock" --> REDIS
    SCHEDULER -- "promote / reap / advance nextRunAt" --> PG
    WS -- "emits job:update, worker:pulse,<br/>queue:stats, dlq:alert" --> DASH

    W1 -- "poll + claim: FOR UPDATE SKIP LOCKED" --> PG
    W2 -- "poll + claim: FOR UPDATE SKIP LOCKED" --> PG
    W1 -- "register + heartbeat every 10s<br/>(x-worker-token)" --> REST
    W2 -- "register + heartbeat every 10s<br/>(x-worker-token)" --> REST
    W1 -.- "execution logs + status writes" --> PG
    W2 -.- "execution logs + status writes" --> PG
    SCHEDULER -. "cron:<scheduleId> lock" .- REDIS
```

## Component responsibilities

### React Dashboard
Single-page admin surface: dashboard overview, queue management with pause/resume, job explorer with filters and bulk actions, job detail with per-attempt log accordion, worker fleet monitor, cron schedules with manual trigger, DLQ with AI failure summaries, and Recharts metrics. Subscribes to Socket.io rooms for real-time updates — no full-page refreshes.

### API Server (Express)
Serves the versioned REST surface (`/api/v1`) behind helmet/cors, JWT authentication, server-side RBAC (OWNER > ADMIN > MEMBER > VIEWER), Zod request validation, and a Redis-backed 100 req/min sliding-window rate limit. All responses use a standard success/error envelope. Hosts the Socket.io gateway and the four scheduler loops.

### Scheduler Service (in-process)
Four idempotent loops inside the API process:
- **Cron runner** — fires due `scheduled_jobs`, creating jobs and advancing `nextRunAt`; each schedule is guarded by a Redis Redlock (`cron:<scheduleId>`) so multiple API instances never double-fire.
- **Delayed/retry promoter** — flips `SCHEDULED → PENDING` and `RETRYING → PENDING` once `run_at` has passed.
- **Dead reaper** — marks workers silent beyond 60 s as `DEAD` and requeues their in-flight jobs as `PENDING`.
- **Dependency checker** — observational; emits WebSocket updates when dependency-blocked jobs become eligible (enforcement itself lives in the claim query).

### Worker Service (× N instances)
Standalone processes with a bounded-concurrency loop: resolve eligible queues (respecting shard keys), atomically claim via `FOR UPDATE SKIP LOCKED`, execute registered handlers with per-job timeouts, write one `job_executions` row plus structured `job_logs` per attempt, apply retry policies on failure or move exhausted jobs to the DLQ transactionally, heartbeat every 10 s, and drain gracefully on SIGTERM.

### PostgreSQL
The single source of truth: users/orgs/projects, queues, jobs and their full lifecycle state, per-attempt executions and logs, batch progress, worker registry and heartbeats, cron schedules, DLQ entries, event triggers/history. Correctness of concurrent claiming rests on its row-level locking, not on application coordination.

### Redis
Two jobs: **distributed locking** (Redlock around cron firing) and **API rate limiting** (sliding-window token buckets keyed per user). Both work correctly across multiple API instances because all state lives in Redis.
