# Design Decisions

Seven major architectural trade-offs, each documented as **Decision → Options Considered → Choice → Rationale → Trade-offs**.

---

## 1. Job queue storage

**Decision:** PostgreSQL is the durable job store; workers claim jobs with a single `FOR UPDATE SKIP LOCKED` statement.

**Options Considered**
1. PostgreSQL as the job store with row-level locking (chosen)
2. Redis-backed queue framework (Bull / BullMQ)
3. Dedicated message broker (RabbitMQ / Kafka)
4. Application-level coordination (advisory locks in app code)

**Choice:** PostgreSQL + `FOR UPDATE SKIP LOCKED`.

**Rationale:** Jobs live in the same transactional store as everything else — claiming a job and writing related rows (executions, batch counters) share one ACID boundary with no dual-write problem or eventual-consistency window. A job is either claimed by exactly one worker or untouched: the guarantee comes from database row locking rather than application logic, which makes it testable (`claiming.test.ts` races 10 workers against 1 job). Job state is inspectable with plain SQL, which powers the entire dashboard for free.

**Trade-offs:** Raw queue throughput is lower than Redis-based queues (thousands vs hundreds of thousands of jobs/sec), and polling adds constant read load. Both are acceptable at this platform's scale; throughput can be raised with more workers before Postgres becomes the bottleneck.

---

## 2. Raw SQL boundary

**Decision:** Exactly one raw-SQL escape hatch — the atomic claim query. Everything else goes through Prisma's typed query builder.

**Options Considered**
1. Prisma everywhere, accept its inability to express `SKIP LOCKED`
2. Raw SQL only where required (chosen)
3. Raw SQL / query builder throughout for maximum control
4. Stored procedures for all hot paths

**Choice:** Raw SQL isolated to `db/queries/claimJobs.ts` (+ the worker's identical loop copy); Prisma for every other access.

**Rationale:** The claim query is the one place where correctness depends on locking semantics no ORM exposes. Keeping it as the sole raw statement gives it outsized scrutiny — it carries a block-length explanation of *why* each clause exists — while the other ~95% of data access stays type-checked, refactor-safe, and migration-friendly.

**Trade-offs:** Two idioms coexist; the worker duplicates the query text so the standalone process needs no API round-trip per poll (mitigated by tests pinning both copies' behavior). Column names inside `RETURNING *` are snake_case, handled by an explicit row interface.

---

## 3. Execution history model

**Decision:** One `job_executions` row per attempt, with `job_logs` hanging off executions — instead of retry counters on the job row.

**Options Considered**
1. Per-attempt `job_executions` table (chosen)
2. Retry count/error columns directly on `jobs`, overwritten each attempt
3. Append-only event-sourcing log replayed into current state
4. Structured logs only (no structured execution rows)

**Choice:** Separate execution rows keyed by `attempt_number`, plus a child `job_logs` stream per execution.

**Rationale:** Full history survives retries: duration, error message, stack, memory, worker assignment, and timestamped logs are preserved per attempt instead of being clobbered. The dashboard's attempt accordion and the DLQ's "what happened across tries" view fall out naturally. Failure analysis (human or AI) needs exactly this per-attempt granularity.

**Trade-offs:** More rows (attempts × jobs) and one extra insert per run; bounded by `maxAttempts` and covered by `(job_id)` / `(started_at)` indexes. Slightly more complex completion paths because two tables must be written consistently.

---

## 4. Dependency enforcement location

**Decision:** The "all dependencies COMPLETED" check lives *inside* the atomic claim query as a `NOT EXISTS` subquery — never as an application-side pre-check.

**Options Considered**
1. Check inside the claim statement (chosen)
2. Pre-check in worker code, then claim
3. Scheduler flips jobs to PENDING when deps complete, claim trusts status
4. Deferred/queued dependency resolution via events

**Choice:** Atomic evaluation under the row lock within the same statement that claims.

**Rationale:** Any pre-check has a time-of-check-time-of-use race: between "deps look complete" and "claim", a dependency could be re-queued or fail, letting an invalid job slip through — or conversely block valid work on stale reads. Evaluating eligibility while holding the lock means whatever passes the filter was true at the instant of claiming. It also removes an entire class of state-machine bookkeeping (no "BLOCKED" status to maintain).

**Trade-offs:** The claim query gets heavier (one correlated subquery per candidate row) — negligible with the small candidate sets `LIMIT` produces. Workers can't cheaply answer "why is my job not being picked up?" from app code alone, so a separate observational checker emits WebSocket updates when blocked jobs become eligible.

---

## 5. Cron mutual exclusion

**Decision:** The cron runner runs inside the API process; each due schedule is fired under a Redis Redlock (`lock:cron:<scheduleId>`), with a freshness re-check after acquiring the lock.

**Options Considered**
1. In-process loops + Redlock per schedule (chosen)
2. Dedicated scheduler deployment/replica
3. Database advisory locks
4. Leader-election via Postgres table leases
5. Accept duplicates and rely on idempotency keys

**Choice:** Embedded scheduler with distributed locks.

**Rationale:** No extra deployment unit to operate, yet multiple API instances stay safe: only the Redlock holder fires a given schedule, and the double-check-under-lock closes the gap where another instance fired during our acquisition retry window. Redis TTLs make crash-orphaned locks self-expire.

**Trade-offs:** Requires Redis to be reachable (it already is, for rate limiting). Redlock's timing assumptions are debated at scale — acceptable here since the worst case is a rare duplicate cron fire, and schedule advancement (`nextRunAt`) is written transactionally with job creation, making even that benign.

---

## 6. Queue sharding mechanism

**Decision:** Soft partitioning via a `shard_key` string on queues and workers; the worker resolves its eligible queue set before claiming.

**Options Considered**
1. String shard keys resolved at claim time (chosen)
2. Hash-partitioned queues by id
3. Separate databases/schemas per region
4. Native table partitioning

**Choice:** Worker declares `shardKey`; it may claim queues with a matching key plus unsharded queues; unsharded workers see unsharded queues only.

**Rationale:** Regional/data-residency routing ("us-east" workers shouldn't process "eu-west" jobs) becomes configuration, not schema surgery — rebalancing is a field update, no migration. Unsharded queues act as shared overflow capacity any pool can drain, keeping utilization high. Enforcement rides along in the existing claim query via the pre-resolved queue-id list, adding zero new SQL concepts.

**Trade-offs:** No automatic failover if a shard's whole pool dies (jobs wait — mitigated by pointing the queue's shardKey elsewhere). Sharding lives in app logic, so a bug there isn't caught by DB constraints; covered instead by dedicated tests (`resolveEligibleQueueIds` cases).

---

## 7. AI failure summaries

**Decision:** DLQ entries trigger an async OpenRouter completion (via plain `fetch`) after the entry exists; generation can never block or break the failure path.

**Options Considered**
1. Async post-DLQ generation, optional provider (chosen)
2. Synchronous summary before acknowledging failure
3. Local heuristic/template-based summaries (no LLM)
4. Skip AI entirely

**Choice:** `setImmediate`-spawned call to OpenRouter's OpenAI-compatible endpoint using a free-tier default model; result stored in `dead_letter_queue.ai_summary`.

**Rationale:** The critical invariant is that a permanently failed job lands in the DLQ reliably and quickly — operator-facing alerting depends on it. Deferring AI until after that commit means provider outages, missing API keys, rate limits, or slow responses degrade gracefully to "no summary" (the dashboard shows an explanatory hint) rather than delaying or losing DLQ entries. Using OpenRouter over plain HTTP avoids a vendor SDK dependency and lets operators pick any model — including free tiers — via env config.

**Trade-offs:** Summaries arrive late (seconds later) and may simply never appear without a key; there is no retry/backoff for failed generations (regenerate manually by re-running a job into the DLQ). Prompt quality depends on the chosen free model.
