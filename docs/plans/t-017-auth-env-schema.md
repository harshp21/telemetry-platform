# T-017 Plan: Auth Service Environment Schema

**Epic**: Epic 4 — Authentication Service  
**Task**: T-017 (Auth service env schema)  
**Dependency**: T-016 (.env.example files) ✅  
**Blocks**: T-018 (register), T-019 (login), T-020 (token refresh), T-022 (JWT plugin)  
**Status**: Ready for Implementation

---

## Business Objective & User Impact

**Problem**: Auth service needs validated environment configuration for security-sensitive parameters. Without structured schema validation, configuration errors (missing JWT secrets, invalid bcrypt rounds, malformed secrets) would only surface at runtime, creating security vulnerabilities and operational risk.

**User Impact**:
- **Developers**: Clear, documented auth config schema; fail-fast on invalid values during startup
- **DevOps**: Know exactly which auth-specific variables must be set before deployment; validation prevents misconfigurations
- **Security**: Enforce minimum secret length (32 chars), bcrypt rounds constraints (10-14), and explicit token TTL settings
- **Operations**: Service fails on startup with clear error message if env is missing/invalid, preventing silent failures

---

## Task Goal

Create and test `apps/auth-service/src/config/env.ts` with a comprehensive Zod environment schema that:
1. Extends base infrastructure variables (NODE_ENV, PORT, DATABASE_URL, REDIS_URL, OTEL_EXPORTER_OTLP_ENDPOINT, LOG_LEVEL)
2. Defines auth-specific security variables with proper validation rules:
   - JWT secrets: minimum 32 characters
   - Token TTLs: positive integers with sensible defaults and constraints
   - Bcrypt rounds: 10-14 range with 12 default
3. Exports typed `ServiceEnv` for use throughout auth service
4. Validates and freezes configuration on app startup via `parseEnv` helper
5. Enable T-018+ to reliably access `env.JWT_SECRET`, `env.BCRYPT_ROUNDS`, etc.

---

## Scope: Exact Boundaries

### ✅ In Scope
- **File**: `apps/auth-service/src/config/env.ts`
- **Base infrastructure variables**: `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL` (shared with other services)
- **Auth-specific variables**:
  - `JWT_SECRET`: HS256 signing key for access tokens (required, min 32 chars)
  - `JWT_REFRESH_SECRET`: HS256 signing key for refresh token validation (required, min 32 chars)
  - `JWT_ACCESS_TTL_SECONDS`: Access token lifetime (positive int, default 900s, max 900s per security policy)
  - `JWT_REFRESH_TTL_SECONDS`: Refresh token lifetime (positive int, default 604800s = 7 days)
  - `BCRYPT_ROUNDS`: Hashing cost factor (int 10-14, default 12)
- **Validation rules**: Min/max length, coercion, default values, enum constraints
- **Export**: TypeScript type `ServiceEnv` for use in other modules
- **Integration**: Use `parseEnv()` helper from `@telemetry/shared-config` to validate and freeze config

### ❌ Out of Scope
- Cookie configuration environment variables (`AUTH_REFRESH_COOKIE_NAME`, `AUTH_CSRF_COOKIE_NAME`, etc.) — these are optional and use hardcoded defaults in `AUTH_COOKIES` constants
- Database schema or migrations (handled by T-001-002)
- JWT token generation logic (handled by T-019-020)
- Redis integration (handled by container setup)
- Environment file creation (handled by T-016)

---

## Owning Files

- **Primary**: `apps/auth-service/src/config/env.ts` — new file (~30-35 lines)
- **Supporting**:
  - `apps/auth-service/src/constants.ts` — AUTH_TOKENS constants (already exists, defines defaults/limits)
  - `apps/auth-service/tests/env.schema.unit.test.ts` — validation tests (~60-80 lines)
  - `apps/auth-service/src/config/container.ts` — uses `ServiceEnv` type (no changes required)
  - `.env.example` — populated by T-016 (after this schema is defined)

---

## Local Hypothesis

**Hypothesis**: "If we define a complete Zod schema that extends base infrastructure variables with auth-specific security parameters and validate at startup via `parseEnv()`, then:
1. All downstream auth services (T-018+ controller/service layers) can access typed `env.JWT_SECRET`, `env.BCRYPT_ROUNDS`, etc. without null checks
2. Configuration errors surface at startup with clear validation messages
3. The schema accurately reflects all variables documented in `.env.example` and used in session cookie logic
4. Type safety is maintained across auth service components"

**Falsifiability**: Hypothesis is falsified if:
- Type `ServiceEnv` does not include all auth-specific vars used in controllers/services
- Runtime error occurs trying to read `env.JWT_SECRET` or other auth vars
- `.env.example` includes variables not validated by schema
- Schema tests fail to catch invalid JWT secret lengths or out-of-range bcrypt rounds

---

## Implementation Steps

### Step 1: Define Zod Schema Object
**Action**: Create schema with base + auth-specific variables  
**Details**:
- Import `z` from 'zod' and `parseEnv` from '@telemetry/shared-config'
- Define `EnvSchema` object with:
  - Base infrastructure (6 vars)
  - Auth-specific security (5 vars)
  - Proper validation rules
  - Apply `.default()` to variables with sensible defaults
  - Apply `.min()`, `.max()` to constrain bcrypt rounds and secret lengths
  - Use `z.coerce.number()` for numeric env vars
- Reference `AUTH_TOKENS` constants for max/default TTL values
- Pattern: Match structure used in `apps/usage-service/src/config/env.ts`

**Validation**: TypeScript compilation passes (no type errors)

---

### Step 2: Export ServiceEnv Type
**Action**: Add type export derived from Zod schema  
**Details**:
```typescript
export type ServiceEnv = z.infer<typeof EnvSchema>;
```
- Creates TypeScript type reflecting all validated variables
- Controllers/services will use this type for `env` parameter
- IDE autocomplete shows all available env properties

**Validation**: `ServiceEnv` type can be imported in other modules without errors

---

### Step 3: Initialize and Export Parsed Environment
**Action**: Create env instance by calling `parseEnv()` at module level  
**Details**:
```typescript
export const env = parseEnv(EnvSchema, process.env);
```
- Validates `process.env` against schema
- Throws error with clear field-level messages if validation fails
- Freezes config object (prevents accidental mutations)
- Pattern: Matches `usage-service/src/config/env.ts`

**Validation**: Importing this module succeeds only if process.env is valid; test with invalid env should throw

---

### Step 4: Write Schema Validation Tests
**Action**: Create unit tests in `apps/auth-service/tests/env.schema.unit.test.ts`  
**Details**:
- **Test: Base variables required**: Missing DATABASE_URL → parse fails
- **Test: JWT secret too short**: `JWT_SECRET=abc` (3 chars) → validation error
- **Test: JWT secret at minimum**: `JWT_SECRET=<32-char-string>` → parse succeeds
- **Test: Bcrypt rounds out of range**: BCRYPT_ROUNDS=9 or 15 → validation error
- **Test: Bcrypt rounds at boundaries**: 10, 12, 14 → all succeed
- **Test: Access TTL respects max**: JWT_ACCESS_TTL_SECONDS at or below MAX → succeeds; above MAX → fails
- **Test: Numeric coercion**: `PORT="3001"` (string) → coerced to number, passes
- **Test: Enum defaults**: NODE_ENV omitted → defaults to "development"

**Validation**: All tests pass; coverage includes all validation branches

---

### Step 5: Validate Against .env.example
**Action**: Cross-reference schema against T-016 `.env.example` file  
**Details**:
- Every variable in `.env.example` must appear in schema (or be explicitly optional)
- Every required variable in schema must be documented in `.env.example`
- Default values in schema match example values
- Sensitive variables (JWT_SECRET, JWT_REFRESH_SECRET) are clearly marked as "SENSITIVE"
- Cookie config vars (if in .env.example) must be documented as optional with defaults

**Validation**: Manual review: schema coverage = 100% of documented vars

---

### Step 6: Integration Test with Container
**Action**: Verify `env` object is properly typed and accessible in container setup  
**Details**:
- Confirm `apps/auth-service/src/config/container.ts` can import and use `ServiceEnv` type
- Verify `env` property on container has full type information
- Check that IDE autocomplete works for `container.env.JWT_SECRET`, etc.
- Pattern: Container already uses `ServiceEnv` type from env.ts

**Validation**: TypeScript `typecheck` passes; no type errors in container.ts

---

## Files to Create

| File | Lines | Purpose | Dependencies |
|------|-------|---------|--------------|
| `apps/auth-service/src/config/env.ts` | ~30-35 | Zod schema + type export + env instance | zod@^3.23.8, @telemetry/shared-config |
| `apps/auth-service/tests/env.schema.unit.test.ts` | ~60-80 | Schema validation tests | vitest, @telemetry/shared-config |

### env.ts Target Structure
```
- Imports: zod, parseEnv, AUTH_TOKENS
- EnvSchema object definition (11 fields)
- ServiceEnv type export
- env instance export
```

### Test File Target Structure
```
- buildBaseEnv() helper function (11 fields)
- describe("auth env schema", ...)
  - it("validates required fields", ...)
  - it("rejects JWT secrets < 32 chars", ...)
  - it("accepts bcrypt rounds 10-14", ...)
  - it("rejects bcrypt rounds outside range", ...)
  - it("respects JWT_ACCESS_TTL_SECONDS max", ...)
  - it("coerces numeric values", ...)
  - it("applies defaults", ...)
```

---

## Files to Modify

| File | Change | Reason |
|------|--------|--------|
| *None* | — | env.ts is new; constants already define AUTH_TOKENS; no existing schema to update |

---

## Validation Strategy

### Task-Scoped Validation (Immediate)

**1. TypeScript Compilation**
```bash
cd apps/auth-service
pnpm typecheck
```
- Verifies no type errors in env.ts
- Checks `ServiceEnv` type is properly inferred
- Confirms container.ts can use env without errors

**Fail criteria**: Type errors in env.ts or imports

---

**2. Unit Tests for Schema**
```bash
cd apps/auth-service
pnpm test -- tests/env.schema.unit.test.ts
```
- Validates all schema branches (required, optional, constrained values)
- Tests coercion, defaults, and range validation
- Confirms error messages are clear

**Fail criteria**: Any test fails; missing coverage for validation rules

---

**3. Manual Integration Check**
```bash
cd apps/auth-service
pnpm test -- tests/config/container.unit.test.ts
```
- Confirms container can access `env.JWT_SECRET`, etc.
- Verifies type annotations work in real container setup

**Fail criteria**: Import fails; type errors in container usage

---

**4. Environment Variable Coverage Audit**
- Read `.env.example` (created by T-016)
- Verify every documented variable is in EnvSchema or explicitly documented as optional
- Check defaults match example values

**Fail criteria**: Missing variables; mismatched defaults

---

### Pre-QA Gate

**5. Full Auth Service TypeCheck & Lint**
```bash
cd apps/auth-service
pnpm typecheck
pnpm lint
```
- Ensures no regressions to overall service structure
- Validates ESLint rules

**Fail criteria**: New errors introduced

---

### QA Validation

**6. Test Against Valid/Invalid .env Files**
- QA loads service with valid .env (all vars + correct values) → startup succeeds
- QA loads service with missing JWT_SECRET → startup fails with clear error
- QA loads service with JWT_SECRET=short → startup fails with validation message
- QA loads service with BCRYPT_ROUNDS=20 → startup fails with range error

**Fail criteria**: Service starts despite invalid env; error messages unclear

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **JWT secret entropy insufficient** | HIGH | Schema enforces minimum 32 characters, but doesn't verify actual randomness. **Mitigation**: Document in .env.example that secrets must use `openssl rand -hex 32` or equivalent; add startup warning if JWT_SECRET looks like placeholder. |
| **Bcrypt rounds performance vs. security** | MEDIUM | BCRYPT_ROUNDS=10 is faster but weaker; 14 is slower but stronger. Default of 12 is middle ground. **Mitigation**: Document performance impact in comments; allow override via env; measure in integration tests. |
| **JWT_ACCESS_TTL_SECONDS capped at 900s** | MEDIUM | May be too restrictive for some use cases. **Mitigation**: This is intentional per security policy (Q5 decision); if requirements change, update AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX. For now, accept constraint. |
| **Cookie config not in schema** | MEDIUM | `.env.example` documents optional cookie vars but EnvSchema doesn't validate them. **Mitigation**: Document that cookie vars are optional; update schema to include optional cookie vars for completeness (defer to follow-up if needed). |
| **Refresh token TTL not validated against access token TTL** | LOW | Relationship is maintained by values, not enforced at schema level. **Mitigation**: Document in comments; add validation test to ensure refresh > access; accept. |
| **Type inference lag in IDE** | LOW | TypeScript type inference may take a moment in large projects. **Mitigation**: This is a TypeScript limitation, not a code issue. Acceptable risk. |

---

## Pending Tasks

| Task | State | Blocker | Notes |
|------|-------|---------|-------|
| **T-018: Register** | pending | T-017 (this task) | Depends on `env.BCRYPT_ROUNDS` type and `env.JWT_*` secrets availability |
| **T-019: Login** | pending | T-017 | Depends on `env.JWT_SECRET`, `env.JWT_ACCESS_TTL_SECONDS` for token generation |
| **T-020: Token Refresh** | pending | T-017 | Depends on `env.JWT_REFRESH_TTL_SECONDS` and token service usage |
| **T-022: JWT Verification Plugin** | pending | T-017 | Depends on `env.JWT_SECRET` for token verification |
| **T-024: Integration Tests** | pending | T-017 | Integration tests load full env and exercise auth endpoints |

---

## Acceptance Criteria

Must all be satisfied before marking task complete:

- ✅ **AC-1: Schema Complete** — EnvSchema includes all 6 base + 5 auth vars with correct types, validation rules, and defaults
- ✅ **AC-2: Type Export** — `ServiceEnv` type is exported and accurately reflects Zod schema
- ✅ **AC-3: Env Instance** — `env` singleton is exported; validates and freezes config on import
- ✅ **AC-4: Tests Pass** — Unit tests in `env.schema.unit.test.ts` achieve >90% branch coverage
- ✅ **AC-5: TypeScript Clean** — `pnpm typecheck` passes in auth-service; no type errors
- ✅ **AC-6: Pattern Consistency** — Structure matches `apps/usage-service/src/config/env.ts` pattern
- ✅ **AC-7: .env.example Alignment** — All vars in .env.example are documented in schema or marked optional
- ✅ **AC-8: Container Integration** — Container can import and use `ServiceEnv` type without errors
- ✅ **AC-9: No Regressions** — Existing tests and linting still pass after implementation

---

## Stage Tracker

**Current stage**: Task Planning (pending)  
**Previous stage**: None  
**Next stage**: Implementation  
**Blocker reason**: Awaiting approval  
**Pending tasks snapshot**:
- T-017 (this task): pending → awaiting approval
- T-018 (register): pending (blocked on T-017)
- T-019 (login): pending (blocked on T-017)  
- T-020 (refresh): pending (blocked on T-017)

**Evidence**: This plan document

---

## Summary

**T-017** establishes the auth service's configuration contract via a Zod schema that validates all security-sensitive environment variables at startup. The ~30-line schema enforces minimum secret lengths, numerical constraints on bcrypt rounds and token TTLs, and provides typed access to configuration throughout the auth service.

**Implementation is straightforward**: define schema object, export type, parse config, write tests. **Validation is task-scoped**: typecheck, unit tests, integration check. **No regressions expected**: pattern is proven in usage-service.

**Critical path**: This task unblocks T-018–T-022 which implement the actual auth endpoints. Delay here delays all downstream auth work.

---

**Plan file**: `docs/plans/t-017-auth-env-schema.md`  
**Estimated LOC**: 30-35 (env.ts) + 60-80 (tests) = ~95-115 total  
**Key dependencies**: zod@^3.23.8, @telemetry/shared-config parseEnv(), AUTH_TOKENS constants  
**Validation commands**:
- `cd apps/auth-service && pnpm typecheck`
- `cd apps/auth-service && pnpm test -- tests/env.schema.unit.test.ts`
- Manual review: .env.example vs. schema coverage

**Blocker reason**: None (ready for implementation upon approval)
