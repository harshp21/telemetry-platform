# Reviewer Checklist

Use this checklist for service-level changes in this repository.

1. Constants
- Extract repeated route paths, header names, response codes, and service names into `constants.ts`.
- Prefer shared package constants when the same value appears across services.

2. App structure
- Keep `index.ts` as a thin startup entrypoint.
- Put route registration and service wiring in `app.ts`.
- Keep tracing initialization logically first in startup flow; avoid importing modules with heavy/shared side effects before `initTracing(...)`.
- If `index.ts` needs constants, prefer constants modules that do not import service infra dependencies.

3. Security
- Internal endpoints must require `X-Internal-Secret`.
- Services with internal-only routes must fail fast if `INTERNAL_API_SECRET` is missing.
- Tenant-sensitive request paths must validate tenant context against headers/auth context.
- Compare secrets in constant time (`crypto.timingSafeEqual` over SHA-256 digests), never with
  `===` or `!==` — string comparison short-circuits and leaks how many leading bytes matched.
- Tenant ids are UUIDs (`Tenant.id` is `String @default(uuid())`). Validate the header, do not
  merely check it is non-empty.

Current compliance (keep this table honest; the open items are in `.claude/rules/known-gaps.md`):

| Service | `X-Internal-Secret` guard | Fails fast on missing secret | Timing-safe |
|---|---|---|---|
| gateway | n/a — it is the caller; injects the header on every proxied request | yes (env schema, shared fragment) | n/a |
| usage-service | yes, `onRequest`, `/health` exempt | yes (env schema, shared fragment) | yes (shared `secretsMatch`) |
| billing-service | yes, `onRequest` on both the internal and the tenant-facing scope; `/health` outside both | yes (env schema, shared fragment) | yes (shared `secretsMatch`) |
| worker-service | yes, `onRequest` on the internal scope; `/health` outside it | yes (env schema, shared fragment) | yes (shared `secretsMatch`) |
| analytics-service | no — `/health` only today (S-9) | no (S-9) | n/a |
| auth-service | n/a — deliberately public (`/v1/auth/register\|login\|refresh`) | n/a | n/a |

4. Tests
- Prefer app injection tests over placeholder smoke tests.
- Use `beforeEach`/`afterEach` app lifecycle per test file to avoid cross-test coupling.
- Cover success path plus at least one negative path for auth/validation.

5. Validation
- Run focused tests and typecheck for touched packages/services.
- Before merge, run lint, typecheck, test, and build from repo root.
