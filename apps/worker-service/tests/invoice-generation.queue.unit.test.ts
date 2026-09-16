import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { ServiceEnv } from "../src/config/env";
import { WORKER_INVOICE_JOB } from "../src/constants";
import { INTEGRATION_COUNTS, INTEGRATION_REDIS } from "./integration.constants";
// Statically imported even though `bullmq` is mocked: `vi.mock` is hoisted above every import in
// the file, so the subject sees the double regardless. A dynamic `await import(...)` in a
// `beforeEach` would work too and was the first shape here, but it needs a
// `typeof import(...)` annotation, which this repo's lint config forbids.
import {
  InvoiceGenerationQueue,
  buildQueueConnection
} from "../src/queues/invoice-generation.queue";

/**
 * Unit cases for the BullMQ topology (T-042, S8).
 *
 * `bullmq` is mocked, so these assert the **options this service passes** rather than BullMQ's
 * own behaviour. Three of those options are not preference — each has a measured failure behind
 * it, reproduced at Gate 3 against the installed `bullmq@6.3.6` rather than read from the
 * tarball:
 *
 * | Probe | Result |
 * |---|---|
 * | `new Worker(name, fn, { connection: <container client, maxRetriesPerRequest: 2> })` | **throws** `BullMQ: Your redis options maxRetriesPerRequest must be null.` |
 * | the same with an ioredis `keyPrefix` | **throws** `BullMQ: ioredis does not support ioredis prefixes, use the prefix option instead.` |
 * | `new Worker(name, fn, { connection: { host, port, db }, prefix })` | constructs |
 * | `new Queue(name, { connection: <container client, maxRetriesPerRequest: 2> })` | **constructs** -- no throw |
 *
 * That last row narrows the claim the plan made. The constraint is on a **blocking** connection,
 * which is the `Worker`; a `Queue` built on the container's client is accepted. The service
 * still gives both their own connection options, so that neither can close a client the rest of
 * the process is using, but the docblock must not say BullMQ rejects the container client in
 * general -- it does not.
 */

const queueConstructor = vi.fn();
const workerConstructor = vi.fn();
const upsertJobScheduler = vi.fn(() => Promise.resolve());
const queueClose = vi.fn(() => Promise.resolve());
const workerClose = vi.fn(() => Promise.resolve());
const workerOn = vi.fn();

vi.mock("bullmq", () => ({
  Queue: class {
    upsertJobScheduler = upsertJobScheduler;
    close = queueClose;
    constructor(...args: unknown[]) {
      queueConstructor(...args);
    }
  },
  Worker: class {
    close = workerClose;
    on = workerOn;
    constructor(...args: unknown[]) {
      workerConstructor(...args);
    }
  }
}));

const REDIS_URL = `redis://localhost:6379/${String(INTEGRATION_REDIS.LOGICAL_DB_INDEX)}`;
/** Fixture rejection reason for `Q9`; asserted through `describeError`'s `Error` branch. */
const FAILURE_MESSAGE = "billing-service rejected the invoice request: 503";

const env = { REDIS_URL } as unknown as ServiceEnv;
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
} as unknown as Logger;

/** Returns the single recorded constructor call's arguments, or throws. */
const onlyCall = (mock: ReturnType<typeof vi.fn>, what: string): unknown[] => {
  if (mock.mock.calls.length !== INTEGRATION_COUNTS.SINGLE) {
    throw new Error(`expected exactly one ${what}, saw ${String(mock.mock.calls.length)}`);
  }

  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`the recorded ${what} carried no arguments`);
  }

  return call;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("InvoiceGenerationQueue", () => {
  it("Q1 - registers the scheduler with the constant cron pattern and an explicit UTC timezone", async () => {
    const queue = new InvoiceGenerationQueue({ env, logger, run: vi.fn() });

    await queue.registerSchedule();

    const [schedulerId, repeat, template] = onlyCall(
      upsertJobScheduler,
      "upsertJobScheduler call"
    ) as [string, { pattern: string; tz?: string }, { name: string }];
    expect(schedulerId).toBe(WORKER_INVOICE_JOB.SCHEDULER_ID);
    expect(repeat.pattern).toBe(WORKER_INVOICE_JOB.CRON_PATTERN);
    // **`tz` is the assertion that matters.** Omitted, `cron-parser` evaluates the pattern in the
    // *process* local zone; on this host that is UTC+5:30, so `"0 2 * * *"` fires at 20:30 UTC
    // and silently shifts the day boundary the whole task is built around. On CI, which runs
    // UTC, dropping it would look correct -- which is why this is asserted rather than trusted.
    expect(repeat.tz).toBe(WORKER_INVOICE_JOB.TIMEZONE);
    expect(template.name).toBe(WORKER_INVOICE_JOB.JOB_NAME);
  });

  it("Q2 - builds the Worker from connection options, never from a shared ioredis instance", () => {
    new InvoiceGenerationQueue({ env, logger, run: vi.fn() });

    const [, , options] = onlyCall(workerConstructor, "Worker construction") as [
      string,
      unknown,
      { connection: unknown; prefix: string; concurrency: number }
    ];
    // Passing an ioredis *instance* whose `maxRetriesPerRequest` is truthy makes BullMQ throw at
    // construction -- a startup crash, not a warning -- and `container.redis` is built with
    // `maxRetriesPerRequest: 2`. Passing options lets BullMQ set `maxRetriesPerRequest: null`
    // itself on the branch that expects to.
    expect(options.connection).toEqual(buildQueueConnection(REDIS_URL));
    // The negative: whatever this is, it must not be something with ioredis' instance surface.
    expect(options.connection).not.toHaveProperty("duplicate");
    expect(options.concurrency).toBe(WORKER_INVOICE_JOB.CONCURRENCY);
  });

  it("Q3 - namespaces through BullMQ's own prefix, not an ioredis keyPrefix", () => {
    new InvoiceGenerationQueue({ env, logger, run: vi.fn() });

    const [, queueOptions] = onlyCall(queueConstructor, "Queue construction") as [
      string,
      { connection: Record<string, unknown>; prefix: string }
    ];
    const [, , workerOptions] = onlyCall(workerConstructor, "Worker construction") as [
      string,
      unknown,
      { connection: Record<string, unknown>; prefix: string }
    ];

    // Not BullMQ's `'bull'` default: production keeps logical database 0, where the real
    // `telemetry:events` stream lives, and the prefix is what separates the queue's keys from it.
    expect(queueOptions.prefix).toBe(WORKER_INVOICE_JOB.QUEUE_PREFIX);
    expect(workerOptions.prefix).toBe(WORKER_INVOICE_JOB.QUEUE_PREFIX);
    // An ioredis `keyPrefix` is the *wrong* way to do the same thing and BullMQ throws on it
    // (`BullMQ: ioredis does not support ioredis prefixes, use the prefix option instead.`), so
    // it must not appear on either connection.
    expect(queueOptions.connection).not.toHaveProperty("keyPrefix");
    expect(workerOptions.connection).not.toHaveProperty("keyPrefix");
  });

  it("Q4 - carries the logical database from REDIS_URL into the connection options", () => {
    // Without this the queue silently lands on database 0 whatever `REDIS_URL` says -- which in
    // tests is the developer's real `telemetry:events` database, the thing
    // `tests/setup.ts` exists to keep suites off.
    expect(buildQueueConnection(REDIS_URL)).toMatchObject({
      host: "localhost",
      port: 6379,
      db: INTEGRATION_REDIS.LOGICAL_DB_INDEX
    });
    // A URL with no path selects database 0, which is what ioredis does and what production uses.
    expect(buildQueueConnection("redis://localhost:6379")).toMatchObject({ db: 0 });
    // Credentials are carried through rather than dropped.
    expect(buildQueueConnection("redis://user:pass@cache.internal:6380/3")).toMatchObject({
      host: "cache.internal",
      port: 6380,
      db: 3,
      username: "user",
      password: "pass"
    });
  });

  it("Q5 - the Worker's processor runs the injected job function", async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        periodStart: "2026-03-10T00:00:00.000Z",
        periodEnd: "2026-03-11T00:00:00.000Z",
        tenants: INTEGRATION_COUNTS.NONE,
        succeeded: INTEGRATION_COUNTS.NONE,
        failed: INTEGRATION_COUNTS.NONE
      })
    );
    new InvoiceGenerationQueue({ env, logger, run });

    const [, processor] = onlyCall(workerConstructor, "Worker construction") as [
      string,
      () => Promise<unknown>,
      unknown
    ];
    await processor();

    // Otherwise the queue is wired to nothing: the scheduler would fire on time, BullMQ would
    // report every job complete, and no invoice would ever be requested. That is the silent
    // failure this whole task is shaped around, one layer up.
    expect(run).toHaveBeenCalledTimes(INTEGRATION_COUNTS.SINGLE);
  });

  it("Q7 - carries rediss:// TLS into the connection options, where plain redis:// gets none", () => {
    // `container.ts` hands the whole `REDIS_URL` to ioredis, which honours the scheme; this
    // function re-implements that parse and so has to honour it too. Measured at Gate 3 on the
    // shipped hand-parse before the fix: `rediss://user:pass@cache.internal:6380/3` produced
    // `{host, port, db, username, password}` with the protocol dropped, while ioredis' own parse
    // of the same URL produced `tls: true`. One process would then have used TLS for the stream
    // connection and plaintext for the queue -- including the password above -- against the same
    // server, and nothing in the suite would have noticed.
    //
    // Scope of the claim, stated as measured: this asserts that a `tls` option is **present** for
    // `rediss://` and **absent** for `redis://`. It does not assert that a TLS handshake succeeds;
    // no TLS Redis was available at Gate 3, so that is untested here.
    const secure = buildQueueConnection("rediss://user:pass@cache.internal:6380/3");
    expect(secure).toMatchObject({
      host: "cache.internal",
      port: 6380,
      db: 3,
      username: "user",
      password: "pass"
    });
    expect(secure).toHaveProperty("tls");

    // The negative half: an unencrypted URL must not acquire a `tls` option, or every local and
    // CI connection would attempt a handshake against a server that speaks none.
    expect(buildQueueConnection(REDIS_URL)).not.toHaveProperty("tls");
  });

  it("Q8 - gives the Queue the retry and retention options from the constants", () => {
    new InvoiceGenerationQueue({ env, logger, run: vi.fn() });

    const [, queueOptions] = onlyCall(queueConstructor, "Queue construction") as [
      string,
      { defaultJobOptions: Record<string, unknown> }
    ];

    // `docs/epics/epic-7-worker-service.md:238` says "BullMQ handles retries with exponential
    // backoff". That is an option, not a default: without `attempts` a failed nightly run is not
    // retried at all, and the whole option set was previously assertable only by reading the
    // source -- deleting it shipped green. Recorded as epic divergence 5 in S-42.
    expect(queueOptions.defaultJobOptions).toEqual({
      attempts: WORKER_INVOICE_JOB.ATTEMPTS,
      backoff: {
        type: WORKER_INVOICE_JOB.BACKOFF_TYPE,
        delay: WORKER_INVOICE_JOB.BACKOFF_DELAY_MS
      },
      removeOnComplete: WORKER_INVOICE_JOB.REMOVE_ON_COMPLETE,
      removeOnFail: WORKER_INVOICE_JOB.REMOVE_ON_FAIL
    });
  });

  it("Q9 - logs the constant message when BullMQ reports a job failed", () => {
    new InvoiceGenerationQueue({ env, logger, run: vi.fn() });

    // Locating the handler **throws** rather than passing vacuously if it was never registered --
    // which is the regression this case exists for. Until it was written, `workerOn` was captured
    // and never asserted, and `invoice-generation.queue.ts`'s handler body was the file's only
    // uncovered line.
    const registration = workerOn.mock.calls.find(
      ([event]) => event === WORKER_INVOICE_JOB.EVENT_FAILED
    );
    if (!registration) {
      throw new Error(
        `no "${WORKER_INVOICE_JOB.EVENT_FAILED}" listener was registered on the BullMQ Worker`
      );
    }
    const [, handler] = registration as [string, (job: unknown, error: unknown) => void];

    handler(undefined, new Error(FAILURE_MESSAGE));

    // Until T-057 adds metrics this line is the only signal an operator has that a nightly run
    // exhausted its attempts; the job itself is scheduled, so nobody is watching a return value.
    expect(logger.error).toHaveBeenCalledWith(
      { error: FAILURE_MESSAGE },
      WORKER_INVOICE_JOB.LOG.JOB_FAILED
    );
  });

  it("Q6 - close() shuts the Worker down before the Queue", async () => {
    const order: string[] = [];
    workerClose.mockImplementation(() => {
      order.push("worker");

      return Promise.resolve();
    });
    queueClose.mockImplementation(() => {
      order.push("queue");

      return Promise.resolve();
    });
    const queue = new InvoiceGenerationQueue({ env, logger, run: vi.fn() });

    await queue.close();

    // The Worker holds the blocking connection and any in-flight job; closing the Queue first
    // would take the client out from under it.
    expect(order).toEqual(["worker", "queue"]);
  });
});
