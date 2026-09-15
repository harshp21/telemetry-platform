# Epic 7 — Worker Service

**Milestone**: v1-mvp (core consumer + processor), v1 (DLQ + BullMQ jobs)
**Depends on**: Epic 2, Epic 3, Epic 6 (stream must exist)
**Blocks**: Epic 8 (billing needs processed UsageLines)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q9 — Worker concurrency | **Decision: design for horizontal workers, run one locally.** Use consumer groups from day one. |
| Q10 — DLQ policy | **Decision: 3 retries, `telemetry:dead-letter`, no retry delay.** Attempts are spaced by the existing `XAUTOCLAIM` idle threshold rather than by a timer. The Prometheus counter is deferred to T-057 — see the T-041 section below. |

---

## Architecture decision: horizontal-ready from day one

```
Development          Production
Redis Stream         Redis Stream
     ↓                    ↓
 Worker × 1          Consumer Group
                      ┌────┼────┐
                      W1   W2   W3
```

Consumer group abstraction is cheap to implement now. `REDIS_CONSUMER_NAME` is set per-instance (e.g. `worker-1`, `worker-{hostname}`), enabling horizontal scaling without code changes.

---

## T-037 · Worker service env schema

**File**: `apps/worker-service/src/config/env.ts`

```ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3003),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  REDIS_STREAM_NAME: z.string().default("telemetry:events"),
  REDIS_CONSUMER_GROUP: z.string().default("worker-group"),
  REDIS_CONSUMER_NAME: z.string().default("worker-1"),
  STREAM_BLOCK_MS: z.coerce.number().int().positive().default(5_000),
  STREAM_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  MAX_RETRY_COUNT: z.coerce.number().int().min(1).max(10).default(3),
  DEAD_LETTER_STREAM: z.string().default("telemetry:dead-letter"),
});
```

---

## T-038 · Consumer group bootstrap

**File**: `apps/worker-service/src/events/stream.consumer.ts`

**Story**: Create the consumer group on startup. If the group already exists (`BUSYGROUP` error), ignore and continue — this is the expected case on restart.

```ts
async function ensureConsumerGroup(): Promise<void> {
  try {
    await redis.xgroup("CREATE", streamName, groupName, "$", "MKSTREAM");
  } catch (err) {
    // BUSYGROUP means the group already exists — safe to continue
    if (!(err instanceof Error) || !err.message.includes("BUSYGROUP")) throw err;
  }
}
```

**`MKSTREAM`**: Creates the stream key if it doesn't exist yet (worker may start before usage-service publishes its first event).

**`$`**: Only process messages published after group creation — not historical backlog.

---

## T-039 · Stream consumer loop

**File**: `apps/worker-service/src/events/stream.consumer.ts`

**Story**: Read batches from the stream, process each message, acknowledge on success. On failure, leave in PEL (Pending Entry List) for retry logic.

```ts
async function consume(): Promise<void> {
  while (!shuttingDown) {
    const results = await redis.xreadgroup(
      "GROUP", groupName, consumerName,
      "COUNT", batchSize,
      "BLOCK", blockMs,
      "STREAMS", streamName,
      ">"   // only undelivered messages
    );

    if (!results) continue;  // timeout — no new messages

    for (const [, messages] of results) {
      for (const [id, fields] of messages) {
        await processMessage(id, fields);
      }
    }
  }
}
```

**PEL claim recovery**: On startup (before main loop), check for messages stuck in PEL longer than `blockMs * 2` and re-claim them with `XAUTOCLAIM`. This handles crashed worker instances.

---

## T-040 · Event → UsageLine processor

**Files**: `apps/worker-service/src/services/event-processor.service.ts`, `repositories/event.repository.ts`, `repositories/usage-line.repository.ts`

**Story**: Deserialize the stream message, upsert the `Event` record (idempotent on `idempotencyKey`), create the corresponding `UsageLine`. Entire operation runs in a Prisma transaction. `XACK` only after the transaction commits.

**Logic**:
```ts
async function processMessage(id: string, fields: string[]): Promise<void> {
  const payload = parseStreamMessage(fields);

  await prisma.$transaction(async (tx) => {
    // upsert — safe to call again if worker crashes after DB write but before XACK
    const event = await tx.event.upsert({
      where: { idempotencyKey: payload.idempotencyKey },
      create: { ...eventData },
      update: {},  // no-op if already exists
    });

    await tx.usageLine.upsert({
      where: { eventId: event.id },
      create: { ...usageLineData },
      update: {},
    });
  });

  await redis.xack(streamName, groupName, id);
  logger.info({ messageId: id }, "Message processed");
}
```

**`metricKey` derivation**: `${event.eventType}.${event.unit}` — e.g. `"api.request.requests"`. Adjust if Q1 decision specifies a different convention.

**Failure handling**: If the transaction throws, do NOT `XACK` — message stays in PEL and will be retried up to `MAX_RETRY_COUNT` times.

---

## T-041 · Retry tracking + dead-letter handler

**File**: `apps/worker-service/src/events/dead-letter.handler.ts`
**Milestone**: v1

**Story**: Track retry count per message. After `MAX_RETRY_COUNT` failures, move to the dead-letter stream. Increment a Prometheus counter. Clear from PEL so it doesn't block the consumer.

**Retry count storage**: Use Redis `HINCRBY retries:{streamName} {messageId} 1`. Fetch count before processing — if `>= MAX_RETRY_COUNT`, route to dead-letter directly.

**Dead-letter format**:
```ts
await redis.xadd(
  deadLetterStream,
  "*",
  "originalId", messageId,
  "streamName", streamName,
  "payload", JSON.stringify(originalPayload),
  "failureReason", lastError.message,
  "failedAt", new Date().toISOString(),
  "retryCount", String(retryCount)
);
await redis.xack(streamName, groupName, messageId);
await redis.hdel(`retries:${streamName}`, messageId);
```

**Q10 — DLQ policy** (**decided**, and implemented by T-041 —
`docs/plans/t-041-retry-tracking-dead-letter.md`):
- Max retry count: `MAX_RETRY_COUNT` env var, default **3**, bounded 1..10.
- Dead-letter destination: `DEAD_LETTER_STREAM`, default **`telemetry:dead-letter`**.
- Retry delay: **none**. No sleep, no scheduled re-add, no backoff ladder. What spaces the
  attempts is `STREAM_BLOCK_MS x RECOVERY_IDLE_MULTIPLIER` — the idle threshold `XAUTOCLAIM`
  already required — because T-041 also adds a reclaim cadence to the read loop.
- Alerting: `telemetry_dead_letter_total` is **deferred to T-057**. `prom-client` is in no
  `package.json` in this workspace. Until then the lever is `XLEN telemetry:dead-letter`.

**What T-041 shipped differs from the snippet above in five ways**, each deliberate and each
recorded in the plan's §4:

1. **The file is `src/services/dead-letter.service.ts`**, not `src/events/dead-letter.handler.ts`:
   `vitest.config.mjs` excludes `src/events/**` from coverage, and new failure-handling code
   belongs inside the thresholds this package sets for itself.
2. **It is a class with constructor-injected collaborators**, not a free function closing over
   module-scope `redis`/`streamName`/`groupName`/`originalPayload`/`lastError`/`retryCount`.
   None of those exist in this repository's shape, and `originalPayload` has no referent — the
   handler seam is `(id: string, fields: string[])`, so "the original payload" is the flat field
   list.
3. **No Prometheus counter** — see above.
4. **"Clear from PEL so it doesn't block the consumer" is false as stated.** A pending entry
   blocks nothing: `>` delivers only entries never handed to any consumer, measured on 7.0.15.
   What a stuck entry actually costs is a permanent PEL row and a recovery page on every start.
   The `XACK` is right; the reason given for it is not.
5. **The record carries `groupName` and the full field list.** The field list is decision C and
   rests on a measurement: a pending entry's payload can be evicted by `MAXLEN` while its id
   stays pending, so a record holding only `originalId` is unreplayable.

---

## T-042 · BullMQ: daily invoice generation job

**File**: `apps/worker-service/src/jobs/invoice-generation.job.ts`
**Milestone**: v1

**Story**: A scheduled BullMQ job runs at 02:00 UTC daily. It queries all tenants with unbilled `UsageLine` records from the previous calendar day and triggers billing-service via internal HTTP.

```ts
// cron: "0 2 * * *"
async function invoiceGenerationJob(job: Job): Promise<void> {
  const yesterday = getPreviousDayRange();  // UTC midnight boundaries
  const tenants = await getTenantsWithUnbilledUsage(yesterday);

  for (const tenantId of tenants) {
    await fetch(`${billingServiceUrl}/v1/internal/billing/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": env.INTERNAL_API_SECRET,
      },
      body: JSON.stringify({ tenantId, ...yesterday }),
    });
  }
}
```

**Error handling**: BullMQ handles retries with exponential backoff. Log each tenant result separately — one failure should not block other tenants.

> ### Obligation inherited from T-043 — `bullWorker.close()`
>
> **T-042 must re-open `apps/worker-service/src/index.ts`'s shutdown handler and add
> `await bullWorker.close()`**, ordered **before** `streamConsumer.stop()` so the scheduler stops
> producing work before the consumer drains what it already has.
>
> T-043's snippet below contains that line and T-043 deliberately did not implement it: there is
> no BullMQ dependency in the workspace yet, so the line as written would `await undefined.close()`.
> Verified at T-043 — `grep -rn "bullmq" --include=package.json .` and
> `grep -rn "bullWorker\|bullmq" apps packages --include=*.ts` both return nothing. The line was
> **reassigned, not dropped**.
>
> Recorded here rather than only in `docs/plans/`, because `CLAUDE.md` forbids reading
> `docs/plans/` as a record of anything. Also recorded in `.claude/rules/known-gaps.md` **S-35**;
> S-15 is why it is in both rather than either.

---

## T-043 · Worker graceful shutdown

**File**: `apps/worker-service/src/index.ts`

**Story**: Worker has no HTTP server to drain — shutdown is purely about the stream consumer loop and BullMQ workers.

> **The snippet below is wrong in five ways and `bullWorker` does not exist.** What shipped is
> tabulated after the acceptance criteria; read that before writing anything against this code.
> Filed as **S-35**.

```ts
let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "Worker shutting down");
  shuttingDown = true;           // consumer loop exits after current batch
  await bullWorker.close();      // drain BullMQ in-flight jobs
  await prisma.$disconnect();
  redis.disconnect();
  logger.info("Worker shutdown complete");
  process.exit(0);
};
```

**Acceptance**:
- Current message batch completes before shutdown
- No messages are lost — if processing is mid-transaction, the transaction rolls back and the message remains in PEL for another worker to claim

> ### What T-043 actually shipped — the snippet above is wrong in five ways
>
> The snippet carries a pointer to this block, because a reader who stops at the code never gets
> here. Filed as **S-35** in `.claude/rules/known-gaps.md`,
> alongside S-29 (this file's T-040 section) and S-32 (its T-041 section) — three sibling entries
> for one file, which is itself the finding.
>
> | Snippet | Shipped |
> |---|---|
> | logs, then sets the shutdown flag | sets the flag, **then** logs |
> | `"Worker shutting down"` | `"Shutting down gracefully"` |
> | `"Worker shutdown complete"` | `"Shutdown complete"` |
> | `await bullWorker.close()` | **not implemented** — no BullMQ dependency exists; reassigned to T-042, see the block under that task |
> | no `try`/`catch`, no `exit(1)` | both present |
>
> It also omits the two calls that do the work — `streamConsumer.stop()` and `app.close()` — and
> its **File:** line names only `src/index.ts`, while T-043 landed almost entirely in
> `src/events/stream.consumer.ts`.
>
> **Where the acceptance criteria are actually satisfied**, since neither is where the snippet
> implies:
>
> - *Current message batch completes* — already true before T-043, and now pinned by `U83`. The
>   shutdown predicate is the `do`/`while` condition in `runLoop`, read once per **read
>   iteration** after `dispatch` has walked the whole batch, so a predicate that flips mid-batch
>   cannot truncate it.
> - *No messages are lost* — `stream.consumer.ts` acknowledges nothing (T-039 decision D2-A), so a
>   rolled-back transaction leaves the entry in the PEL by construction. Pinned by `I18` and, for
>   the half T-043 put at risk, by `I29`.
>
> **What T-043 added that the snippet does not mention at all**: a bounded drain of in-flight
> handler work inside `StreamConsumer.stop()`, and an `XGROUP DELCONSUMER` guarded on this
> consumer's own pending count being zero. That guard is not optional tidiness —
> `XGROUP DELCONSUMER` on a consumer holding pending entries **destroys them permanently**
> (measured on Redis 7.0.15; see `WORKER_SHUTDOWN.SUBCOMMAND_DELCONSUMER`'s docblock). The
> instance-unique `REDIS_CONSUMER_NAME` default is the other half of that guard and **not** a
> naming preference; see **S-34** for the registry-growth trade it accepts.
