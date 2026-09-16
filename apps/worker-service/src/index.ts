import { initTracing } from "@telemetry/shared-tracing";
import { WORKER_SERVICE_STARTUP } from "./startup.constants";

type EnvLoadError = Error & { code?: string };

const loadLocalEnv = (): void => {
	if (typeof process.loadEnvFile === "function") {
		try {
			process.loadEnvFile();
		} catch (error) {
			if ((error as EnvLoadError).code !== "ENOENT") {
				throw error;
			}
		}
	}
};

initTracing(WORKER_SERVICE_STARTUP.SERVICE_NAME);

// The process-wide shutdown flag. `StreamConsumer` reads it through an injected
// `() => shuttingDown` predicate passed at the construction site below -- it does **not**
// import this binding, and a future module must not make it.
//
// An earlier revision of this comment told T-039 to import it from the consumer. Measured
// against a throwaway copy of `src/`: adding `import { shuttingDown } from "../index"` to the
// copy's `stream.consumer.ts` and then importing *only* the consumer module ran this file's
// top level -- `initTracing(...)` at :18 and `void start()` at the bottom -- which built the
// app, tried to bootstrap against the Redis the probe pointed at, and exited 1. The unpatched
// copy exited 0 having done nothing. So importing it would mean that any module, and any test
// file, that touches the consumer boots a worker.
//
// Two things that are *not* the reason, both measured rather than assumed: the import cycle
// itself threw in neither load order, and the live ESM binding did propagate a real SIGTERM to
// the consumer module (`false` before the flip, `true` after). The boot side effect alone is
// the reason.
export let shuttingDown = false;

const start = async (): Promise<void> => {
	loadLocalEnv();
	const { buildWorkerServiceApp } = await import("./app");
	// Dynamically imported alongside `./app`, not statically at the top of this file:
	// `stream.consumer.ts` pulls in `./constants`, which pulls in `@telemetry/shared-types`.
	// Only `startup.constants.ts` may load before `initTracing(...)`.
	const { StreamConsumer } = await import("./events/stream.consumer");
	// T-042, dynamically imported for the same reason: `./queues/invoice-generation.queue` pulls
	// in `./constants`, and only `startup.constants.ts` may load before `initTracing(...)`.
	// It is constructed here rather than in `createContainer()` because a BullMQ `Worker` begins
	// consuming the moment it is constructed, so building one inside the container would have
	// every unit test that touches the container open a blocking read against a real Redis.
	const { InvoiceGenerationQueue } = await import("./queues/invoice-generation.queue");
	const { runInvoiceGenerationJob } = await import("./jobs/invoice-generation.job");
	const app = buildWorkerServiceApp();
	const container = app.container;
	// Renamed from `isShuttingDown`, which meant something different from both the exported
	// `shuttingDown` above and the `isShuttingDown` predicate the consumer now takes. This one
	// is only the signal-handler re-entrancy guard.
	let signalHandled = false;
	// Declared before `shutdown` closes over it, and assigned after the bootstrap below.
	// `let ... | undefined` rather than the `const` at the construction site, because a signal
	// arriving during the bootstrap round trip runs `shutdown` before that line -- reading a
	// `const` from its temporal dead zone would throw a `ReferenceError` out of the shutdown
	// path. The `?.` is the same guard for the same window.
	let streamConsumer: InstanceType<typeof StreamConsumer> | undefined;
	// Same `let ... | undefined` shape and the same reason: a signal arriving before the
	// construction below runs `shutdown` first, and reading a `const` from its temporal dead zone
	// would throw a `ReferenceError` out of the shutdown path.
	let invoiceQueue: InstanceType<typeof InvoiceGenerationQueue> | undefined;

	const shutdown = async (signal: string): Promise<void> => {
		shuttingDown = true;
		container.logger.info({ signal }, "Shutting down gracefully");
		try {
			// T-042, and **before** `streamConsumer.stop()`: the scheduler must stop producing
			// work before the consumer drains what it already holds. This is the obligation S-35
			// recorded against T-042 -- `docs/epics/epic-7-worker-service.md`'s T-043 snippet
			// calls `await bullWorker.close()` here, and T-043 deliberately did not implement it
			// because no BullMQ dependency existed to close. `U87` asserts the order by
			// invocation order; moving this line below `stop()` turns that case red and leaves
			// the rest of the file green.
			//
			// **This is the third unbounded wait, not a fourth thing inside the drain's budget.**
			// `close()` waits for an in-flight job, which here is a nightly billing run that may
			// be mid-HTTP-call, and BullMQ's `close()` carries no timeout of its own. Because it
			// happens *before* `stop()`, the drain's own `DRAIN_TIMEOUT_MS` budget is unchanged;
			// what grows is total shutdown time. Left unbounded deliberately, and the bound that
			// exists is the one that matters: every HTTP call the job makes carries
			// `AbortSignal.timeout(WORKER_BILLING_CLIENT.TIMEOUT_MS)`, so the wait is at most one
			// in-flight tenant's timeout plus the remaining tenants' -- not indefinite. Adding a
			// race here would mean returning while a job still holds a BullMQ lock, and BullMQ
			// would then redeliver that job to the next instance; since the job is idempotent
			// through billing's endpoint that is survivable, but it trades a bounded wait for
			// duplicate work and was not chosen.
			//
			// **The worst case, with a number, because "unbounded" was accepted without one.**
			// `TIMEOUT_MS` (10 000) x the tenants still to be called, sequentially. Measured with
			// a real `SIGTERM` against a real process whose billing calls hang against a stub
			// that accepts and never replies, on Redis db 14 (T-042 Gate 5, re-measured at the
			// Gate-3 rework): SIGTERM to exit was **9 116 ms at one tenant** and **19 106 /
			// 19 079 ms at two**, against **36-39 ms idle**, with the job never truncated, every
			// per-tenant outcome logged, the summary emitted and exit code 0. Roughly 10 s per
			// remaining tenant, which is the formula rather than a curve fitted to two points:
			// the per-tenant timeouts are serial and each failure line lands 10.00 s after the
			// previous one.
			//
			// So a deployment's termination grace period must exceed
			// `TIMEOUT_MS x tenants_with_unbilled_usage` or the run is `SIGKILL`ed part way. At
			// Kubernetes' default 30 s that is three tenants -- arithmetic from the formula above,
			// not a run anybody made at three. The decision stays "unbounded" --
			// the alternative loses the in-flight job's lock -- but it is now a decision with its
			// worst case written down rather than an open end. Revisit when a nightly run's
			// tenant count approaches the grace period, not before.
			await invoiceQueue?.close();
			// Before `app.close()`, and the order is measured, not stylistic. `app.close()`
			// fires the `onClose` hook at `app.ts:32-36`, which calls `quit()`; `quit()` waits
			// for an in-flight blocking read to return on its own, while the `disconnect()`
			// `stop()` issues ends the same read at once. Re-derived at T-043 on ioredis 5.11.1
			// / Redis 7.0.15, against a BLOCK 5000 interrupted 200 ms in: `disconnect()` rejected
			// the read after **204 ms** with `Connection is closed.`, and `quit()` waited
			// **4 883 ms** after it was issued (5 084 ms total) before the read returned
			// normally. The tree's earlier figures were ~205 ms and 4 813 ms; both hold.
			// Closing first would add up to `STREAM_BLOCK_MS` to every deploy.
			//
			// **Since T-043 this line also drains**, so it is no longer the ~205 ms step the
			// paragraph above describes. `stop()` sets the shutdown flag, disconnects the read
			// connection, then awaits the loop -- which means awaiting whatever the message
			// handler has in hand -- bounded by `WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS`, and only then
			// deregisters this consumer from the group. The ordering rationale is unchanged:
			// `quit()` first would add the block interval *on top of* the drain.
			//
			// **Bounded by `DRAIN_TIMEOUT_MS` plus two unbounded round trips, not by
			// `DRAIN_TIMEOUT_MS` alone** -- and since T-042 there is a **third** unbounded wait,
			// `invoiceQueue.close()`, which happens *before* this line and is described at its
			// own call site. The count in this sentence was two when it was written and the diff
			// that added the third had to correct it; do not copy it forward without re-reading
			// the handler. The drain is bounded; the `XINFO CONSUMERS` and
			// `XGROUP DELCONSUMER` that follow it carry no timeout of their own. What bounds those
			// is the container client's `maxRetriesPerRequest: 2` (`src/config/container.ts`),
			// which covers the *unreachable* server — measured against a port nothing listens on,
			// rejections at 153 ms then 603 ms — and no `commandTimeout` is set, so a
			// reachable-but-slow server is not bounded at all. An earlier revision of this comment
			// said "shutdown duration is bounded by that constant"; that was false and is corrected
			// here (Gate-4 LOW-4). Adding a `commandTimeout` is a container change and was not made
			// in this task.
			//
			// A drain that times out logs at WARN and **skips** the deregistration, deliberately:
			// `XGROUP DELCONSUMER` destroys any entries the named consumer still holds, so a
			// consumer that cannot account for its work must not be deregistered. Nothing is lost
			// either way -- the handler acknowledges only after it has committed, so abandoned
			// entries stay in the pending list and are reclaimed by the next worker's
			// `XAUTOCLAIM` pass.
			//
			// This file's `void streamConsumer.run()` is deliberately **unchanged** by that.
			// S-26's fix direction reads as an instruction to drop the `void`; doing so was
			// measured at the Gate-6 review as a wide failure of
			// `tests/index.graceful-shutdown.unit.test.ts`, because `run()` does not return while
			// the loop is running and `listen` is then never reached. Holding the loop promise
			// inside `StreamConsumer` instead puts the drain behind a call this line already
			// awaits. (S-26 cites that failure as `Tests 10 failed | 2 passed (12)`; that file held
			// **14** cases at `fc66bd3` and has gained cases in every task since, so the
			// parenthesised total is stale and is deliberately not restated here -- a current
			// count would be stale again at the next task. The shape of the failure is the
			// durable part; the total is not.)
			await streamConsumer?.stop();
			await app.close();
			await container.prisma.$disconnect();
			container.redis.disconnect();
			container.logger.info("Shutdown complete");
			process.exit(0);
		} catch (error) {
			container.logger.error({ error, signal }, "Error during shutdown");
			process.exit(1);
		}
	};

	process.on("SIGTERM", () => {
		if (!signalHandled) {
			signalHandled = true;
			void shutdown("SIGTERM");
		}
	});
	process.on("SIGINT", () => {
		if (!signalHandled) {
			signalHandled = true;
			void shutdown("SIGINT");
		}
	});

	// T-038. Bootstrap the consumer group *before* binding the listener: a worker answering
	// `/health` while its group does not exist reports healthy and consumes nothing. Placed
	// after the signal handlers so a SIGTERM arriving during the Redis round-trip is still
	// handled. `tests/index.graceful-shutdown.unit.test.ts` asserts the ordering by
	// invocation order, not by two independent call checks.
	//
	// Fail-closed (D3): anything other than an already-exists reply propagates out of
	// `start()` into the `.catch` below, which exits non-zero. This is a startup behaviour
	// change -- a worker can no longer start without a reachable Redis. Against a port
	// nothing listens on, the container's client options rejected in ~160 ms with
	// `MaxRetriesPerRequestError`, so the failure is fast rather than a hang.
	//
	// T-040 supplies the fifth argument, `handler`. Without it the consumer falls back to
	// `buildDefaultMessageHandler`, which logs an entry and acknowledges nothing -- correct
	// while no processor existed, and now the difference between a worker that stores usage and
	// one that silently re-reads the same backlog forever. `src/events/**` is outside this
	// package's coverage thresholds (S-25), so no percentage would notice its absence; `U46` in
	// `tests/index.graceful-shutdown.unit.test.ts` is what does, by asserting that a reclaimed
	// entry reaches the handler the container supplied.
	//
	// T-041 changes *which* handler that is: `container.messageHandler`, the processor's handler
	// with the retry policy wrapped around it, composed in `src/config/container.ts`. Reverting
	// this line to `container.eventProcessor.buildHandler()` leaves the whole
	// `DeadLetterService` suite green and the feature wired to nothing, which is why `U69`
	// exists and why it asserts the raw processor handler was **not** the one called.
	streamConsumer = new StreamConsumer(
		container.redis,
		container.logger,
		container.env,
		() => shuttingDown,
		container.messageHandler
	);
	await streamConsumer.ensureConsumerGroup();

	// T-039. Started, not awaited: `run()` only returns when the service is shutting down, so
	// awaiting it here would mean the listener never binds. `void` is how this repo satisfies
	// `no-floating-promises`, matching `void start()` at the bottom of this file.
	//
	// Discarding the promise is safe only because `run()` handles its own failures: its body is
	// a single call inside a `try`/`catch` that logs `Stream consumer loop failed` and resolves.
	// The mutation that establishes it: delete that `catch` and `U32` (a `duplicate()` that
	// throws) and `U33` (a shutdown predicate that throws) both fail with `promise rejected ...
	// instead of resolving`.
	//
	// An earlier revision of this comment said `run()` "resolves rather than rejects -- every
	// read failure is handled inside the loop -- so there is no rejection for the discarded
	// promise to swallow". The first clause was false and the review reproduced it twice:
	// `duplicate()` and the injected predicate were both called outside any `try`, and either
	// throwing rejected this promise -- an unhandled rejection, which Node >= 15 exits the
	// process on. The read-failure clause was the true part. Do not read the corrected version
	// as "nothing here can ever reject": if a future edit moves work out of `run()`'s `try`,
	// this call site swallows it again, and the honest fix would then be a `.catch(...)` here.
	//
	// Startup order is therefore: signal handlers -> group bootstrap -> recovery started ->
	// listen -> first read. `/health` never answers before the group exists or before the loop
	// has begun, which is the property `U7` guards for the bootstrap half and `U25` for the
	// loop half. The first *read* lands after `listen`, because `void run()` runs synchronously
	// only as far as the first `XAUTOCLAIM` and then suspends on that round trip -- which `U25`
	// now asserts rather than glosses.
	//
	// An earlier revision said "by one microtask turn". Measured at the Gate-4 Round-2 review:
	// three turns, not one -- `recoverPendingEntries` resuming, `await this.dispatch(claim)`,
	// and `await this.recoverPendingEntries(...)` returning. And that count is against a mock
	// whose `xautoclaim` resolves immediately; in production the first turn waits on a real
	// network round trip, so any microtask count understates the gap rather than bounding it.
	// The direction -- read after listen -- was right and is what `U25` asserts.
	void streamConsumer.run();

	// T-042. Registered *before* `app.listen`, on the same argument the group bootstrap above
	// makes: a worker answering `/health` while its scheduler does not exist reports healthy and
	// invoices nobody. Fail-closed -- an unreachable Redis propagates out of `start()` into the
	// `.catch` below, which exits non-zero.
	//
	// The job's collaborators come from the container; only the queue itself is built here, and
	// only because constructing a BullMQ `Worker` starts it. `U88` asserts the ordering and
	// `U87` the shutdown half.
	invoiceQueue = new InvoiceGenerationQueue({
		env: container.env,
		logger: container.logger,
		run: () =>
			runInvoiceGenerationJob({
				enumeration: container.billingEnumerationRepository,
				billingClient: container.billingClient,
				logger: container.logger
			})
	});
	await invoiceQueue.registerSchedule();

	const port = Number(process.env.PORT ?? WORKER_SERVICE_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: WORKER_SERVICE_STARTUP.HOST });
};

void start().catch((error) => {
	console.error(error);
	process.exit(1);
});
