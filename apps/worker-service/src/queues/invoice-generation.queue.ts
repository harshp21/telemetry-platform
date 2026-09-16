import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { Logger } from "pino";
import type { ServiceEnv } from "../config/env";
import { WORKER_INVOICE_JOB } from "../constants";
import type { InvoiceGenerationSummary } from "../jobs/invoice-generation.job";
import { describeError } from "../utils/describe-error";

export interface InvoiceGenerationQueueDeps {
  readonly env: ServiceEnv;
  readonly logger: Logger;
  /** The job body. Injected so the queue can be constructed and asserted without it. */
  readonly run: () => Promise<InvoiceGenerationSummary>;
}

/** Radix for the port and database index parsed out of `REDIS_URL`. */
const URL_NUMBER_RADIX = 10;
/** ioredis' own default when a URL names neither. */
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_DB = 0;
/** `new URL("redis://h:6379/14").pathname` is `"/14"`; the leading slash is not the index. */
const REDIS_DB_PATH_PREFIX = "/";
/** `new URL(...).protocol` for a TLS Redis URL. ioredis' own parse keys TLS off exactly this. */
const REDIS_TLS_PROTOCOL = "rediss:";

/**
 * Turns `REDIS_URL` into BullMQ connection **options**.
 *
 * Exported for `Q4`, which is the case that keeps the logical database from being silently
 * dropped: `REDIS_URL` in this package's tests selects database 14, and an options object that
 * omitted `db` would put every queue key on database 0 — where the developer's real
 * `telemetry:events` stream lives, and which `tests/setup.ts` exists to keep suites off.
 *
 * Options rather than a constructed `ioredis` instance, because the `Worker`'s connection is
 * **blocking** and BullMQ throws on a blocking connection built from a client whose
 * `maxRetriesPerRequest` is truthy. Measured against the installed `bullmq@6.3.6`, passing a
 * client built exactly as `container.ts` builds its own
 * (`maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: true`):
 * `BullMQ: Your redis options maxRetriesPerRequest must be null.` — thrown from the constructor,
 * so it is a startup crash rather than a warning. From options, BullMQ sets
 * `maxRetriesPerRequest: null` itself.
 *
 * **Scope of that, narrowed by measurement:** the same client passed to a `Queue` in the same
 * probe run constructed without throwing, because a `Queue`'s connection is not blocking. So the
 * rule is "a blocking connection must not carry a retry limit", not "BullMQ rejects the
 * container's client". Both are given their own options here anyway, so that closing the queue
 * cannot disconnect a client the stream consumer and the dead-letter service are still using.
 *
 * ## Why the scheme is mapped rather than ignored
 *
 * Re-implementing ioredis' URL parse means re-implementing the parts that matter, and TLS is one.
 * Measured at the Gate-3 rework on the pre-fix shape, both parses given
 * `rediss://user:pass@cache.internal:6380/3`: ioredis produced
 * `{host, port: 6380, db: 3, tls: true, username, password}`, while this function produced the
 * same fields **without** `tls` -- the protocol (`"rediss:"`) was read and discarded. One process
 * would then have used TLS for the stream connection (`container.ts`) and plaintext for the queue
 * against the same server, sending that password in clear. `Q7` asserts both directions.
 *
 * `tls: {}` rather than `tls: true`: ioredis 5.11.1's `StandaloneConnector` does
 * `if (options.tls) { Object.assign(connectionOptions, options.tls); }` — read from
 * `built/connectors/StandaloneConnector.js:33-34`, not run — so any truthy value selects TLS and
 * an object is what the spread is for. `true` happens to work because assigning a boolean adds
 * nothing.
 *
 * What is **not** established here: no TLS Redis was available, so nothing measured that a
 * handshake succeeds. `Q7` asserts the option is present for `rediss://` and absent for
 * `redis://`, which is what this function decides; whether the server accepts it is ioredis'.
 */
export const buildQueueConnection = (redisUrl: string): ConnectionOptions => {
  const parsed = new URL(redisUrl);
  const database = parsed.pathname.startsWith(REDIS_DB_PATH_PREFIX)
    ? parsed.pathname.slice(REDIS_DB_PATH_PREFIX.length)
    : parsed.pathname;

  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, URL_NUMBER_RADIX) : DEFAULT_REDIS_PORT,
    db: database ? Number.parseInt(database, URL_NUMBER_RADIX) : DEFAULT_REDIS_DB,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.protocol === REDIS_TLS_PROTOCOL ? { tls: {} } : {})
  };
};

/**
 * The BullMQ queue, worker and repeatable scheduler for the nightly invoice run (T-042, S8).
 *
 * BullMQ is the workspace's first queue dependency. Four topology decisions, each with the
 * failure it avoids:
 *
 * 1. **Connection options, not `container.redis`** — see `buildQueueConnection`.
 * 2. **BullMQ's `prefix`, not an ioredis `keyPrefix`.** The same constructor throws
 *    `BullMQ: ioredis does not support ioredis prefixes, use the prefix option instead.`
 *    Reproduced at Gate 3. Production keeps logical database 0, where `telemetry:events` lives,
 *    and `WORKER_INVOICE_JOB.QUEUE_PREFIX` is what separates the queue's keys from it — a second
 *    production logical database would be a convention no mechanism enforces (S-22's own closing
 *    caveat), whereas the prefix is passed on every call.
 * 3. **`tz` is set explicitly.** Omitted, `cron-parser` evaluates the pattern in the *process*
 *    local zone, which on this host is UTC+5:30 — so `"0 2 * * *"` would fire at 20:30 UTC and
 *    silently move the day boundary that the resolver's `text` parameters exist to protect. `Q1`
 *    asserts it, and it would look correct on CI either way.
 * 4. **Retries are configured, not assumed.** `docs/epics/epic-7-worker-service.md` says "BullMQ
 *    handles retries with exponential backoff"; that is an option, not a default, and without
 *    `attempts`/`backoff` a failed job is not retried at all. Reported as a divergence.
 *
 * ## What a retry can and cannot do
 *
 * The job only *rejects* when the enumeration failed, so a retry is a retry of "find out who to
 * bill" — the case where the job does not know whom it skipped. A per-tenant failure resolves
 * with a summary instead, deliberately (D5). A retry that did happen cannot double-invoice
 * *through this path*, because every attempt goes through billing's idempotent endpoint; that is
 * scoped to this path rather than stated generally, since it rests on another service's early
 * return and its unique constraint.
 */
export class InvoiceGenerationQueue {
  private readonly queue: Queue;
  private readonly worker: Worker;
  private readonly logger: Logger;

  constructor(deps: InvoiceGenerationQueueDeps) {
    this.logger = deps.logger;
    const connection = buildQueueConnection(deps.env.REDIS_URL);

    this.queue = new Queue(WORKER_INVOICE_JOB.QUEUE_NAME, {
      connection,
      prefix: WORKER_INVOICE_JOB.QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: WORKER_INVOICE_JOB.ATTEMPTS,
        backoff: {
          type: WORKER_INVOICE_JOB.BACKOFF_TYPE,
          delay: WORKER_INVOICE_JOB.BACKOFF_DELAY_MS
        },
        removeOnComplete: WORKER_INVOICE_JOB.REMOVE_ON_COMPLETE,
        removeOnFail: WORKER_INVOICE_JOB.REMOVE_ON_FAIL
      }
    });

    this.worker = new Worker(
      WORKER_INVOICE_JOB.QUEUE_NAME,
      async () => deps.run(),
      {
        connection,
        prefix: WORKER_INVOICE_JOB.QUEUE_PREFIX,
        concurrency: WORKER_INVOICE_JOB.CONCURRENCY
      }
    );

    // Without this, a job that exhausts its attempts is recorded in Redis and nowhere an
    // operator looks. There is no metric until T-057, so the log line is the only signal.
    // `Q9` registers the handler through the same path and invokes it, so deleting either the
    // registration or the log call goes red.
    this.worker.on(WORKER_INVOICE_JOB.EVENT_FAILED, (_job, error: unknown) => {
      this.logger.error({ error: describeError(error) }, WORKER_INVOICE_JOB.LOG.JOB_FAILED);
    });
  }

  /**
   * Installs or updates the repeatable schedule.
   *
   * `upsertJobScheduler` against a **stable** id, so a restart replaces the existing schedule
   * rather than adding a second one — a new id on every boot would mean a worker that has been
   * deployed five times runs the nightly job five times.
   */
  async registerSchedule(): Promise<void> {
    await this.queue.upsertJobScheduler(
      WORKER_INVOICE_JOB.SCHEDULER_ID,
      { pattern: WORKER_INVOICE_JOB.CRON_PATTERN, tz: WORKER_INVOICE_JOB.TIMEZONE },
      { name: WORKER_INVOICE_JOB.JOB_NAME }
    );
    this.logger.info(
      {
        pattern: WORKER_INVOICE_JOB.CRON_PATTERN,
        timezone: WORKER_INVOICE_JOB.TIMEZONE,
        queue: WORKER_INVOICE_JOB.QUEUE_NAME
      },
      WORKER_INVOICE_JOB.LOG.SCHEDULED
    );
  }

  /**
   * Stops producing and consuming work.
   *
   * Worker first, then Queue: the Worker holds the blocking connection and any in-flight job, so
   * closing the Queue first would take a client out from under it. `Q6` asserts the order.
   *
   * `worker.close()` waits for an in-flight job — which here is a nightly billing run that may
   * be mid-HTTP-call — and carries no timeout of its own. `src/index.ts` explains what that
   * costs at shutdown and why it is accepted rather than bounded.
   */
  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}
