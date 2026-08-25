# T-018 Plan: Register — POST /v1/auth/register Endpoint

**Epic**: Epic 4 — Authentication Service  
**Task**: T-018 (Register endpoint)  
**Dependency**: T-017 (auth env schema) ✅ provides typed `env.BCRYPT_ROUNDS`  
**Blocks**: T-019 (login), T-020 (token refresh), T-022 (JWT plugin)  
**Status**: Ready for Implementation

---

## Business Objective & User Impact

**Problem**: New users cannot register for the platform. Without registration, the auth system is incomplete and blocks frontend adoption.

**User Impact**:
- **End users**: Can self-register with email/password/tenant name in one atomic operation
- **Developers**: Clear registration flow with validated input and consistent error responses
- **Platform**: Tenant-User relationship established at account creation; foundation for all downstream auth flows
- **Security**: Passwords hashed with configurable bcrypt rounds; email uniqueness enforced

---

## Task Goal

Implement `POST /v1/auth/register` that:
1. Accepts request: `{ firstName, lastName, email, password, tenantName }`
2. Validates input with Zod schema (firstName/lastName non-empty, email format, password ≥ 8 chars, tenant name non-empty)
3. Captures user identity (firstName, lastName) for support, audit, personalization
4. Prevents duplicate email registration (unique constraint + check before creation)
5. Creates Tenant and User atomically in Prisma transaction
6. Sets first registrant as tenant OWNER (not MEMBER)
7. Hashes password with bcrypt using `env.BCRYPT_ROUNDS` from T-017
8. Returns `201 { data: { userId, tenantId } }` on success
9. Returns `400` for validation failures, `409` for duplicate email

---

## Scope: Exact Boundaries

### ✅ In Scope
- **Endpoint**: `POST /v1/auth/register` with validation, Prisma transaction, bcrypt hashing
- **Request Validation**: Zod schema validating:
  - `firstName` — non-empty string (for support, audit, personalization)
  - `lastName` — non-empty string (for support, audit, personalization)
  - `email` — valid email format, unique across platform
  - `password` — minimum 8 characters
  - `tenantName` — non-empty string
- **Business Logic**: Email normalization (lowercase, trim), duplicate detection, atomic Tenant+User creation, first user = OWNER
- **Security**: Password hashing with env-configured bcrypt rounds; never return password hash
- **Error Handling**:
  - `400` — Zod validation failure (invalid email, password too short, missing fields, empty names)
  - `409 { code: 'EMAIL_ALREADY_EXISTS' }` — duplicate email
- **Tests**: Integration test for success path (201) + duplicate email + validation errors (firstName, lastName, password)
- **Code Pattern**: Controller → Service → Repository (established auth-service pattern)
- **User Role**: First registrant is set as `OWNER` of tenant (not MEMBER)

### ❌ Out of Scope
- Token generation (T-019 login handles this)
- JWT verification plugin (T-022)
- Email verification workflow (future)
- Account recovery (future)

---

## Owning Files & Implementation Structure

**Files to Create/Modify**:

| File | Action | Purpose | ~LOC |
|------|--------|---------|------|
| `apps/auth-service/src/controllers/auth.controller.ts` | Modify | Request handler, Zod schema (firstName, lastName, email, password, tenantName), response formatting | +45 |
| `apps/auth-service/src/services/auth.service.ts` | Modify | Business logic: password hashing, service orchestration | +30 |
| `apps/auth-service/src/repositories/user.repository.ts` | Modify | Atomic Prisma transaction: create Tenant→User (set user.role=OWNER), handle duplicates | +65 |
| `apps/auth-service/src/routes/index.ts` | Modify | Register POST /register route | +5 |
| `apps/auth-service/tests/auth.integration.test.ts` | Modify | Integration tests (success with firstName/lastName, duplicate, validation) | +120 |

**Total New Lines**: ~265 LOC (+30 from firstName/lastName fields)

**Existing Dependencies** (no changes):
- `apps/auth-service/src/config/env.ts` (T-017) → provides typed `env.BCRYPT_ROUNDS`
- `apps/auth-service/src/errors/index.ts` → `EmailAlreadyExistsError` class
- `prisma/schema.prisma` → Tenant & User models with email unique constraint
- `apps/auth-service/src/constants.ts` → `AUTH_VALIDATION.PASSWORD_MIN_LENGTH` (8), `AUTH_HTTP_STATUS` codes

---

## Implementation Steps (Ordered & Concrete)

### Step 1: Define Register Request Schema
- Add Zod schema in controller: `registerRequestSchema`
- Fields:
  - `firstName` — `.string().trim().min(1)` (required, non-empty)
  - `lastName` — `.string().trim().min(1)` (required, non-empty)
  - `email` — `.string().email()` (required, valid format)
  - `password` — `.string().min(8)` (required, ≥ 8 chars)
  - `tenantName` — `.string().trim().min(1)` (required, non-empty)
- Export `RegisterRequestBody` type from schema via `z.infer`
- Validation: TypeScript compilation

### Step 2: Implement registerHandler Controller
- Signature: `async (request: FastifyRequest, reply: FastifyReply) → FastifyReply`
- Parse request body with Zod schema (error auto-caught by error handler)
- Call `authService.register(parsed)` → get `{ userId, tenantId }`
- Return `reply.status(201).send({ data: { userId, tenantId } })`
- Note: firstName, lastName passed through to service for User creation
- Validation: Unit test with mocked service, test firstName/lastName validation

### Step 3: Implement register Service Method
- Add `register(input: RegisterInput) → Promise<{ userId, tenantId }>`
- Hash password: `bcryptjs.hash(password, env.BCRYPT_ROUNDS)`
- Call repository method
- Throw `EmailAlreadyExistsError` if duplicate
- Validation: Unit test with mocked repository

### Step 4: Implement createUserWithTenantIfEmailAvailable Repository Method
- Normalize email: `trim().toLowerCase()`
- Check for existing user by email (early exit if found)
- Execute Prisma transaction:
  - Create Tenant with name (plan=FREE, uses default timezone UTC if not provided)
  - Create User with firstName, lastName, email, passwordHash, tenantId, **role=OWNER** (first user owns tenant)
- Handle unique constraint race condition (P2002 error → return null)
- Return `{ userId, tenantId }` or null
- Validation: Integration test with real database, verify user.role = OWNER

### Step 5: Register Route
- Add POST `/register` route in `src/routes/index.ts`
- Bind to `registerHandler` controller function
- Prefix: `/v1/auth/register`
- Validation: Smoke test endpoint responds

### Step 6: Write Integration Tests
- Test: valid input (firstName, lastName, email, password, tenantName) → 201 with userId/tenantId
- Test: first user is set to OWNER role (verify user.role = OWNER)
- Test: duplicate email → 409 EMAIL_ALREADY_EXISTS (case-insensitive)
- Test: invalid email → 400 validation error
- Test: password too short (< 8 chars) → 400 validation error
- Test: empty firstName → 400 validation error
- Test: empty lastName → 400 validation error
- Test: missing required field → 400 validation error

---

## Validation Strategy

### Task-Scoped Validation (Immediate)

**1. TypeScript Compilation**
```bash
cd apps/auth-service
pnpm typecheck
```
- Verify no type errors in controller/service/repository
- Confirm RegisterInput, RegisterResult types inferred correctly

**2. Unit Tests** (Controller & Service)
```bash
cd apps/auth-service
pnpm test -- tests/auth.unit.test.ts --grep "register"
```
- Mocked repository tests for service
- Mocked service tests for controller
- Verify error handling (EmailAlreadyExistsError → 409)

**3. Integration Tests** (Full flow with database)
```bash
cd apps/auth-service
pnpm test -- tests/auth.integration.test.ts --grep "register"
```
- Real Prisma client, real test database
- Success path: 201 with userId/tenantId
- Duplicate email rejection: 409
- Validation error: 400

**4. Lint & Code Quality**
```bash
cd apps/auth-service
pnpm lint
```
- ESLint validation of new code

**5. Smoke Test** (if exists)
```bash
cd apps/auth-service
pnpm test -- tests/smoke.test.ts
```
- Endpoint startup and basic availability

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Bcrypt cost factor misconfiguration** | HIGH | Env var `BCRYPT_ROUNDS` from T-017 is typed and validated at startup; range 10-14 enforced by schema |
| **Email uniqueness race condition** | MEDIUM | Prisma transaction + unique constraint ensures atomicity; handle P2002 error as duplicate |
| **Password exposed in logs or response** | HIGH | Never include password hash in response; use generic error message for validation failures |
| **Email case sensitivity** | MEDIUM | Normalize email (lowercase + trim) before storage; Zod validates format |
| **Transaction rollback on failure** | MEDIUM | Prisma `$transaction` auto-rollsback if any operation fails; no orphaned Tenant without User |
| **Invalid Zod schema** | LOW | Copy pattern from existing auth services; unit test schema validation |

---

## Acceptance Criteria

Must all be satisfied:

- ✅ **AC-1: Endpoint responds to POST /v1/auth/register** — Fastify routes correctly
- ✅ **AC-2: Valid input returns 201** — All fields (firstName, lastName, email, password, tenantName) provided and valid → 201 with userId/tenantId
- ✅ **AC-3: First user is OWNER** — User created with role = OWNER (not MEMBER)
- ✅ **AC-4: Duplicate email returns 409** — Second registration with same email returns 409 EMAIL_ALREADY_EXISTS (case-insensitive)
- ✅ **AC-5: Invalid email returns 400** — Zod validation catches invalid email format → 400
- ✅ **AC-6: Short password returns 400** — Password < 8 chars rejected → 400
- ✅ **AC-7: Empty firstName returns 400** — Zod validation catches empty/whitespace-only firstName → 400
- ✅ **AC-8: Empty lastName returns 400** — Zod validation catches empty/whitespace-only lastName → 400
- ✅ **AC-9: Missing field returns 400** — Missing any required field → 400
- ✅ **AC-10: Password is hashed** — Password hash stored, never exposed in response or logs
- ✅ **AC-11: Atomic creation** — Both Tenant and User created together in transaction (no orphans)
- ✅ **AC-12: Email normalized** — Email stored lowercase; duplicate detection case-insensitive
- ✅ **AC-13: Types exported** — `RegisterRequestBody`, `RegisterResult` types exported for route binding
- ✅ **AC-14: Tests pass** — Integration tests 8/8 passing (success, owner role, duplicate, validation x5)
- ✅ **AC-15: No type errors** — `pnpm typecheck` passes; 0 errors
- ✅ **AC-16: Lint passes** — `pnpm lint` passes; 0 warnings

---

## Pending Tasks (Blocked on This)

| Task | Dependency | Notes |
|------|-----------|-------|
| **T-019: Login** | T-018 (register creates users) | Login validates registered email/password, generates tokens |
| **T-020: Token Refresh** | T-019 (login creates session) | Refresh uses refresh token created during login |
| **T-022: JWT Plugin** | T-017 (env schema), T-019 (token exists) | Plugin verifies JWT signatures |
| **T-023: Route Registration** | T-018 (endpoint exists) | Middleware to bind all routes in router |

---

## Stage Tracker

**Current stage**: Planning (pending)  
**Previous stage**: None  
**Next stage**: Implementation  
**Blocker reason**: Awaiting approval  
**Pending tasks**: T-018 implementation

---

## Summary

**T-018** implements the foundational user registration endpoint that enables all downstream authentication flows. The endpoint is straightforward (5 controller actions, 3 service methods, 1 repository method), uses established auth-service patterns, and is fully blocked on T-017 (which is complete).

**Implementation is low-risk**: Zod validation is well-tested, Prisma transactions are proven, bcrypt integration is standard. All security concerns (password hashing, email uniqueness, no enumeration) are addressed by design.

**Test coverage**: Integration tests validate all happy path + error scenarios. No database seeding required.

**Estimated effort**: ~4-6 hours end-to-end (implementation, review, QA, CI validation).

---

**Plan file path**: `docs/plans/t-018-register-endpoint.md`  
**Estimated LOC**: ~265 (5 files, mostly logic in repository layer + firstName/lastName fields)  
**Key dependencies**: T-017 env schema, Prisma, bcryptjs, Zod  
**Request Body**: `{ firstName, lastName, email, password, tenantName }` — all required, no timezone
**First User Role**: Automatically set to OWNER of tenant (not MEMBER)
**Validation commands**:
- `cd apps/auth-service && pnpm typecheck`
- `cd apps/auth-service && pnpm test -- tests/auth.integration.test.ts --grep "register"`
- `cd apps/auth-service && pnpm lint`

**Blocker reason**: None (ready for implementation upon approval)
