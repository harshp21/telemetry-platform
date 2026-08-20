# Epic 7 — Worker Service

**Milestone**: v1-mvp (core consumer + processor), v1 (DLQ + BullMQ jobs)
**Depends on**: Epic 2, Epic 3, Epic 6 (stream must exist)
**Blocks**: Epic 8 (billing needs processed UsageLines)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q9 — Worker concurrency | **Decision: design for horizontal workers, run one locally.** Use consumer groups from day one. |
| Q10 — DLQ policy | Max retries, retry delay, dead-letter destination |

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

**Q10 — DLQ policy** (fill in when decided):
- Max retry count: `MAX_RETRY_COUNT` env var (default 3)
- Dead-letter destination: `DEAD_LETTER_STREAM` (default `telemetry:dead-letter`)
- Alerting: Prometheus counter `telemetry_dead_letter_total` — wire Grafana alert when value > 0

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

---

## T-043 · Worker graceful shutdown

**File**: `apps/worker-service/src/index.ts`

**Story**: Worker has no HTTP server to drain — shutdown is purely about the stream consumer loop and BullMQ workers.

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
