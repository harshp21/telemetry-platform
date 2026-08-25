# Task Implementer Workflow Guide

**Version**: 1.0  
**Effective from**: T-019 (Login) onwards  
**Approach**: Pseudo-TDD (Test-First Design)  
**Purpose**: Ensure systematic test coverage, edge case discovery, and safe refactoring

---

## Pseudo-TDD Implementation Pattern

The Task Implementer agent should follow this workflow for all scoped implementation tasks:

### Phase 1: Test Specification (Before Code)

1. **Review test scenarios from Task Planner**
   - Open the approved plan file (e.g., `docs/plans/t-019-login-endpoint.md`)
   - Extract all acceptance criteria (ACs)
   - Extract all test scenarios from "Validation Strategy" section

2. **Create test file with all scenarios**
   - Create test file: `apps/{service}/tests/{feature}.test.ts`
   - Write test structure for ALL scenarios (use `.todo` or `.skip` marks if needed)
   - Do NOT implement test bodies yet—just structure them
   
   Example:
   ```ts
   describe("POST /v1/auth/login", () => {
     it.todo("should login with valid email/password");
     it.todo("should return 401 for wrong password");
     it.todo("should return 401 for non-existent email");
     it.todo("should set refresh token cookie");
     // ... etc (all scenarios from plan)
   });
   ```

3. **Write test bodies with clear assertions**
   - Each test now has full implementation
   - Assertions directly mapped to acceptance criteria
   - Use descriptive test names that mirror AC language
   
   Example:
   ```ts
   it("should login with valid email/password and return 200 with accessToken", async () => {
     // Arrange: registered user
     await registerUser({ email: "user@test.com", password: "ValidPass123" });
     
     // Act: login
     const response = await app.inject({
       method: "POST",
       url: "/v1/auth/login",
       payload: { email: "user@test.com", password: "ValidPass123" }
     });
     
     // Assert: AC-2 verified
     expect(response.statusCode).toBe(200);
     expect(response.body.data).toHaveProperty("accessToken");
     expect(response.body.data).toHaveProperty("expiresIn");
   });
   ```

4. **Run tests - they WILL FAIL initially**
   ```bash
   pnpm test -- tests/{feature}.test.ts
   # Expected: All tests fail (code doesn't exist yet)
   ```

### Phase 2: Implementation to Pass Tests

5. **Implement code layer by layer**
   - DO NOT write code that isn't needed to pass a test
   - Implement controller first (request → response mapping)
   - Then service (business logic)
   - Then repository (persistence)
   
   Order matters:
   ```
   Controller (handler function) 
        ↓
   Service (business logic, error throwing)
        ↓
   Repository (database operations)
   ```

6. **Run tests after each significant change**
   ```bash
   pnpm test -- tests/{feature}.test.ts --grep "specific test"
   ```
   - STOP if tests fail
   - Fix code, rerun
   - Only proceed when green

7. **Implement ALL code needed for tests to pass**
   - No "I'll implement this later"
   - No TODO comments in production code
   - All paths tested must be implemented

### Phase 3: Refactoring (Only After Tests Pass)

8. **Code cleanup is now SAFE**
   - All tests are passing (safety net)
   - Refactor types, extract functions, improve readability
   - Rerun tests after each refactor
   - If test breaks = wrong refactor, revert

9. **Run full validation suite**
   ```bash
   cd apps/{service}
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

### Phase 4: Output & Handoff

10. **Produce implementation summary**
    - List all files modified
    - List all tests (by name)
    - Validation results (typecheck, lint, tests)
    - Any deviations from plan (with rationale)

11. **Handoff to Senior Pre-QA Review**
    - All tests pass
    - All validations pass
    - No uncommitted changes

---

## Key Principles

| Principle | Why | How |
|-----------|-----|-----|
| **Tests before code** | Forces clear spec; catch missing requirements early | Write test structure first, implement second |
| **One test at a time** | Easier debugging; linear progress | Focus on one failing test, make it pass, move next |
| **Red → Green → Refactor** | Ensures tests are meaningful (they must fail first) | Don't refactor until ALL tests pass |
| **No implementation without test** | Prevents dead code; guarantees coverage | Every public method must have a passing test |
| **Refactor only with green tests** | Tests protect against regressions | Never refactor before tests pass |

---

## Example: T-019 (Login) Implementation

### Step 1: Test Specification
```ts
// tests/auth.integration.test.ts
describe("POST /v1/auth/login", () => {
  it.todo("should login with valid credentials and return 200");
  it.todo("should return 401 for invalid password");
  it.todo("should return 401 for non-existent email");
  it.todo("should return refresh token cookie");
  it.todo("should return access token in response body");
  it.todo("should not expose password hash");
  it.todo("should reject password < 8 chars");
});
```

### Step 2: Test Bodies
```ts
it("should login with valid credentials and return 200", async () => {
  // Setup: register user first
  await registerTestUser({ email: "john@test.com", password: "SecurePass123" });
  
  // Login
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "john@test.com", password: "SecurePass123" }
  });
  
  // Assertions (AC-1, AC-3, AC-4)
  expect(response.statusCode).toBe(200);
  expect(response.body.data.accessToken).toBeDefined();
  expect(response.body.data.expiresIn).toBeGreaterThan(0);
  expect(response.cookies).toHaveProperty("refresh_token");
});

it("should return 401 for invalid password", async () => {
  await registerTestUser({ email: "john@test.com", password: "SecurePass123" });
  
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "john@test.com", password: "WrongPassword" }
  });
  
  // Assertion (AC-2)
  expect(response.statusCode).toBe(401);
  expect(response.body.code).toBe("INVALID_CREDENTIALS");
});
// ... etc (all 7 tests)
```

### Step 3: Run Tests (All Fail)
```bash
$ pnpm test -- tests/auth.integration.test.ts --grep "login"
✗ should login with valid credentials and return 200
  Error: loginHandler is not defined
✗ should return 401 for invalid password
  Error: loginHandler is not defined
# ... all failing
```

### Step 4: Implement Code
```ts
// apps/auth-service/src/controllers/auth.controller.ts
export const loginHandler = async (
  request: FastifyRequest<{ Body: LoginRequestBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const parsed = loginRequestSchema.parse(request.body);
  const result = await authService.login(parsed);
  
  reply.setCookie("refresh_token", result.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "strict"
  });
  
  return reply.status(200).send({
    data: {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn
    }
  });
};
```

### Step 5: Run Tests (One Passes, Others Fail)
```bash
$ pnpm test -- tests/auth.integration.test.ts --grep "login"
✓ should login with valid credentials and return 200
✗ should return 401 for invalid password
  Error: Expected 401, got 200
# ... continue implementing service → repository
```

### Step 6: Continue Until All Tests Pass
```bash
$ pnpm test -- tests/auth.integration.test.ts --grep "login"
✓ should login with valid credentials and return 200
✓ should return 401 for invalid password
✓ should return 401 for non-existent email
✓ should return refresh token cookie
✓ should return access token in response body
✓ should not expose password hash
✓ should reject password < 8 chars

Tests: 7/7 passing ✅
```

### Step 7: Refactor (Safe because tests are green)
```ts
// Extract common validation
// Improve error messages
// Consolidate types
// ... all with tests protecting against regression
```

### Step 8: Final Validation
```bash
$ pnpm typecheck
0 errors ✅

$ pnpm lint
0 warnings ✅

$ pnpm test
All 7 login tests ✅
All other tests still passing ✅
```

---

## Benefits vs. T-018 Approach

| Aspect | T-018 (Implementation-First) | TDD (Test-First) |
|--------|-----|-----|
| **Test coverage** | 9/9 scenarios (QA found 0 gaps) | All scenarios by design (0 gaps guaranteed) |
| **Development speed** | Faster initial coding | ~15% slower (tests written first) |
| **Debugging** | Moderate (failed test → unclear which layer broke) | Easier (test failing = clear contract violated) |
| **Refactoring** | Risky (must manually verify no breakage) | Safe (tests protect against regression) |
| **Edge cases** | Found via code review | Found via test writing |
| **QA cycle** | Full coverage review needed | Quick approval (coverage already complete) |

---

## When NOT to Use Pseudo-TDD

- **Spike/POC tasks**: Discovery phase → implement → test later
- **Hotfixes**: Urgent fix, test after if time allows
- **Trivial tasks**: (e.g., adding a constant, renaming a field)

**For all Epic tasks**: Use pseudo-TDD.

---

## Checklist for Task Implementer Agent

- [ ] Plan file reviewed; test scenarios extracted
- [ ] Test file created with all scenarios (empty)
- [ ] Test bodies written with assertions (all failing initially)
- [ ] Controller implemented (tests start passing)
- [ ] Service implemented (more tests pass)
- [ ] Repository implemented (all tests pass)
- [ ] Refactoring done (tests still pass)
- [ ] typecheck passes (0 errors)
- [ ] lint passes (0 warnings)
- [ ] All test scenarios passing (X/X)
- [ ] Implementation summary produced
- [ ] Handoff to Senior Pre-QA Review

---

## Questions for Future Tasks

**Q: What if test needs refactoring after code is written?**  
A: Refactor test too—as long as all tests still pass, you're safe. Tests are code.

**Q: What if test is too strict and implementation has valid alternative?**  
A: Update test to match implementation, but document why in commit message. QA may review.

**Q: Can I use .skip to defer a test?**  
A: Only in TDD spike. For production tasks, all tests must pass before commit.

**Q: How many tests per task?**  
A: Minimum = all acceptance criteria covered. Additional edge cases are bonus (QA proposes).
