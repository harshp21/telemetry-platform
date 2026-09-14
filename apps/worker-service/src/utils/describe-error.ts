/**
 * `error.message` for an `Error`, `String(error)` otherwise.
 *
 * Promoted here at T-041 rather than copied a third time. It existed as a module-private
 * `const` in `src/events/stream.consumer.ts`, which now imports it, and `DeadLetterService`
 * needs the same conversion for the dead-letter record's `failureReason`.
 * `.claude/rules/constants.md` asks for promotion before the third copy.
 *
 * One occurrence is deliberately left behind: `src/services/event-processor.service.ts` writes
 * the same ternary inline inside a log object. T-041's plan lists that file as deliberately
 * unmodified, so folding it in here would be scope the plan excluded; it is reported at Gate 3
 * as the remaining copy rather than changed silently.
 *
 * A non-`Error` rejection is real rather than defensive: ioredis was observed rejecting with a
 * plain object (`{ errno: -104 }`), which `String(...)` renders `[object Object]` -- uninformative,
 * but it is a log line rather than a crash, and `U18`/`U23` pin the conversion.
 */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
