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

	const shutdown = async (signal: string): Promise<void> => {
		shuttingDown = true;
		container.logger.info({ signal }, "Shutting down gracefully");
		try {
			// Before `app.close()`, and the order is measured, not stylistic. `app.close()`
			// fires the `onClose` hook at `app.ts:32-36`, which calls `quit()`; `quit()` waits
			// for an in-flight blocking read to return on its own -- 4 813 ms against a
			// BLOCK 5000 -- while the `disconnect()` `stop()` issues ended the same read in
			// 205 ms. Closing first would add up to `STREAM_BLOCK_MS` to every deploy.
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
	// entry reaches the processor's handler.
	streamConsumer = new StreamConsumer(
		container.redis,
		container.logger,
		container.env,
		() => shuttingDown,
		container.eventProcessor.buildHandler()
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

	const port = Number(process.env.PORT ?? WORKER_SERVICE_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: WORKER_SERVICE_STARTUP.HOST });
};

void start().catch((error) => {
	console.error(error);
	process.exit(1);
});
