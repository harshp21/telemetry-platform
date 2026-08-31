# Rule — Constants (required review gate)

No magic strings. No magic numbers. This is enforced at the Senior Reviewer gate, not left to
taste.

## Must live in `constants.ts` or a service-local constants module
- Route paths and API version prefixes
- Header names
- HTTP status codes
- Error codes and error messages
- Service names, listen hosts, default ports
- Workflow / event / stream names
- Retry counts, timeouts, batch limits, TTLs

## Applies to
Controllers, routes, middleware, entrypoints — **and tests**. A literal `403` or a repeated
`page: 1, pageSize: 20` in a test file is a finding when the constant is already importable.

## Also
- Keep runtime startup values under a per-service runtime object
  (e.g. `SERVICE_RUNTIME.DEFAULT_PORT`, `SERVICE_RUNTIME.HOST`).
- Keep `index.ts` startup constants in a side-effect-free `startup.constants.ts` so tracing
  can initialize before the heavy module graph loads.
- Prefer a shared package constant when the same value appears in more than one service —
  before adding a third copy of a literal, promote it.
- DRY: a definition duplicated between `constants.ts`, a validator, and a repository is a
  finding.
