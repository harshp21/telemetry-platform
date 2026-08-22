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

4. Tests
- Prefer app injection tests over placeholder smoke tests.
- Use `beforeEach`/`afterEach` app lifecycle per test file to avoid cross-test coupling.
- Cover success path plus at least one negative path for auth/validation.

5. Validation
- Run focused tests and typecheck for touched packages/services.
- Before merge, run lint, typecheck, test, and build from repo root.
