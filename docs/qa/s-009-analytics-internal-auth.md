# QA Report — S-9 slice 1: analytics-service internal-auth guard and tenant context

**Gate 5 · Verdict: PASS**

Tree under test: HEAD `1220051`, change **uncommitted**, 19 working-tree entries (13 modified,
6 untracked — 4 source/test files plus the plan and review). Tree and `git status` were
byte-identical to their pre-QA baseline at the end of this run; see §9.

Nothing was committed, staged or branched. No tracked file was restored with `git checkout --`,
`git restore` or `git stash`; every mutation was reverted from a `cp` backup and verified with
`md5sum -c`.

---

## 1 · Findings

| # | Grade | Subject | Disposition |
|---|---|---|---|
| F-1 | **LOW** | A second, stronger `AU15` evasion class exists — not a length oracle | Recommend for `.claude/rules/known-gaps.md` (S-51's family). **Not a blocker.** |
| F-2 | **LOW, pre-existing** | The documented scoping command and `pnpm test` disagree on an ambient `INTERNAL_API_SECRET` | Pre-existing platform-wide; analytics conforms. Recommend for `known-gaps.md`. **Not a blocker.** |
| F-3 | **NIT** | A duplicated *valid* `X-Tenant-Id` is refused as `TENANT_CONTEXT_INVALID` | Correct by design; unreachable through the shipped gateway. Record only. |
| O-1 | observation | The `.env.example` line is a net **addition** at HEAD, not a value change | Narrows a review sentence; no action. |

The two text-only MEDIUMs carried forward from Gate 4 (S-58's file/value counts, S-57's
"any one of three" universal) were **re-derived and are correct as the caller stated them** —
six `.env.example` files, two distinct values (4 × `dev-local-internal-secret-at-least-32-chars`,
2 × `dev-local-secret-change-in-production`). They are not re-raised here.

---

### F-1 · LOW — `AU15`'s census is defeated by an evasion that is *worse* than the length oracle

**This answers review open item #3 in the affirmative.**

`apps/analytics-service/tests/internal-auth.middleware.unit.test.ts:253-261` (`AU15`) asserts
three things about the middleware's **source text**: it contains
`secretsMatch } from "@telemetry/shared-utils"`, it contains `secretsMatch(`, and it does **not**
contain `!== internalApiSecret`. The file's own docblock (`:69-80`) records one evasion — a
length oracle — and correctly says the assertions "catch the two spellings they name".

A second evasion satisfies all three assertions while removing the timing-safe comparison
entirely. Applied to `apps/analytics-service/src/middleware/internal-auth.middleware.ts:65`:

```ts
const shapeOk = typeof providedSecret === "string" && secretsMatch("", "");
if (typeof providedSecret !== "string" || !(providedSecret === internalApiSecret) || !shapeOk) {
```

**Measured on this tree:**

```
pnpm --filter @telemetry/analytics-service test       -> Test Files 7 passed (7)   Tests 56 passed (56)
pnpm --filter @telemetry/analytics-service typecheck  -> exit 0
pnpm --filter @telemetry/analytics-service lint       -> exit 0, no findings
```

`AU15` is green because the import line is untouched, `secretsMatch(` is present as a dead call,
and the live comparison is spelled `=== internalApiSecret` rather than `!== internalApiSecret`.

**Why it is worth recording rather than shrugging at.** The known length oracle leaks the
secret's *length*. This one reintroduces JavaScript's byte-at-a-time `===` short-circuit — the
exact comparison S-8 removed from billing and worker — so it leaks a byte-by-byte prefix oracle,
which is strictly the more useful primitive to an attacker. It is also the more likely accident:
`===` is what someone reaches for when refactoring, whereas a length pre-check is deliberate.

**Not a blocker, and the reason is the file's own honesty.** The docblock already declines to
claim the assertions prove timing-safety and says a green run "is not evidence that no oracle was
added". The shipped code is correct; what this finding establishes is that the enumerated-pattern
census is smaller than the space, which is S-51's standing subject. Mutation reverted;
`md5sum -c` OK.

**Recommended for `known-gaps.md`:** add this as a second measured evasion under S-51's
"the cast census counts spellings, not properties" family, with the exact snippet and the three
green results above. Do **not** close it by adding `=== internalApiSecret` to the forbidden list —
that is the widening treadmill S-51 tells the next reader not to walk.

---

### F-2 · LOW, pre-existing — the repo's own scoping command disagrees with `pnpm test`

`apps/analytics-service/tests/setup.ts:14` sets `process.env.INTERNAL_API_SECRET ??= "..."` and
its comment states: *"Turbo runs tests under strict env mode, so this file — not CI's job-level
variable — is what feeds `pnpm test`."*

**That claim is correct, and I verified it by execution.** `turbo.json`'s `test` task declares no
`env` key, so an exported value is filtered out:

```
INTERNAL_API_SECRET=short pnpm test --force --filter @telemetry/analytics-service
  -> @telemetry/analytics-service:test:  Test Files 7 passed (7)   Tests 56 passed (56)
```

But the command `CLAUDE.md` and `.claude/rules/testing.md` both tell developers to use for
scoping — `pnpm --filter <pkg> exec vitest run <file>` — **bypasses turbo**, so the ambient value
reaches the module-load parse:

```
INTERNAL_API_SECRET=short pnpm exec vitest run
  -> Test Files  4 failed | 3 passed (7)
  -> Error: Invalid environment configuration for INTERNAL_API_SECRET: String must contain at least 32 character(s)
```

The concrete path is not hypothetical: the repository's own root `.env` ships
`INTERNAL_API_SECRET=dev-local-secret` — **16 characters**, below the 32 minimum. A developer with
that exported gets, on the documented command:

```
pnpm exec vitest run tests/internal-auth.middleware.unit.test.ts
  with root .env value  -> Test Files 1 failed (1)   Tests  no tests
  clean shell           -> Test Files 1 passed (1)   Tests 14 passed (14)
```

The suite is robust to any *valid* secret — both `dev-local-internal-secret-at-least-32-chars` and
`test-internal-api-secret-change-in-production` give 56/56 on the direct path — so the fragility is
specific to an *invalid* ambient value.

**Explicitly not this change's defect**, and this was measured rather than assumed. Every service
whose env schema already required the variable behaves the same way, with the same exported
16-character value:

| Package | `pnpm exec vitest run` with `INTERNAL_API_SECRET=dev-local-secret` |
|---|---|
| billing-service | `Test Files 8 failed \| 12 passed (20)` |
| worker-service | `Test Files 4 failed \| 14 passed (18)` |
| usage-service | `Test Files 6 failed \| 13 passed (19)` |
| **analytics-service** | `Test Files 4 failed \| 3 passed (7)` |
| gateway | `Test Files 9 passed (9)` — immune; it parses lazily in `loadEnv()` rather than at module load |

Analytics is the fourth service to acquire the property, by faithfully mirroring the pattern
`CLAUDE.md` instruction 5 tells it to mirror. **Recommended for `known-gaps.md`** as a
platform-wide entry, not charged against this change. It is the S-23/S-39 shape — one value
resolved through two paths of different strictness — with the twist that one of the two paths is
the one the standards files recommend.

---

### F-3 · NIT — a duplicated *valid* `X-Tenant-Id` is refused

Measured over a real socket (not `app.inject`), which is where this differs from what the
docblocks record:

```
x-tenant-id: <uuid>  +  x-tenant-id: <the same uuid>   -> 401 TENANT_CONTEXT_INVALID
```

Node's parser joins the repeated lines into `"<uuid>, <uuid>"`, which is not a UUID. The
behaviour is correct and is the safe direction — the middleware docblock's `AU21` property ("no
value is preferred over the other") holds, and it now holds over a real socket in three forms
(valid-then-junk, junk-then-valid, valid-twice), not just the two `app.inject` forms recorded.

Worth one sentence somewhere only because it is a *legitimate* request being refused: a proxy or
service-mesh hop that duplicates rather than replaces the header would break a well-formed call.
**Not reachable through the shipped topology** — `proxy.plugin.ts:46` sets the header by object
spread, which replaces rather than appends — so there is nothing to fix today.

---

### O-1 · Observation — the `.env.example` edit is an addition, not a value change

Round 2 describes "the single executable change in the rework (one `.env.example` value)" and
verifies "nothing on the tree depended on the old value". Against HEAD the diff is:

```
$ git diff apps/analytics-service/.env.example | grep -E "^[+-]INTERNAL_API_SECRET"
+INTERNAL_API_SECRET=dev-local-internal-secret-at-least-32-chars
```

`git show HEAD:apps/analytics-service/.env.example` has **no** `INTERNAL_API_SECRET` line at all.
So the "old value" was an intermediate state inside the uncommitted rework, never committed. The
review's conclusion is right; the claim is simply stronger than it needs to be, because from
HEAD's perspective there was no old value to depend on. No action.

---

## 2 · What I exercised that the review gates could not — real processes over real sockets

Every seam measurement at Gates 3 and 4 went through `app.inject` or a composed in-process app.
The scope is inert, so an end-to-end run required a temporary probe route registered **inside**
the `app.register` callback in `src/app.ts`. It was added, driven, removed, and the removal
verified by `md5sum` against a copy taken beforehand (§9).

### 2.1 · The ladder, direct to a real analytics-service process

`tsx src/index.ts`, real `app.listen`, driven with `curl`. Compare against the five-row table in
`known-gaps.md` S-9, which was produced by `app.inject`.

| Request | Status | Body |
|---|---|---|
| `/health`, no credentials | `200` | `{"status":"ok","service":"analytics-service"}` |
| scoped route, no headers | `401` | `{"code":"UNAUTHORIZED"}` |
| scoped route, wrong secret | `401` | `{"code":"UNAUTHORIZED"}` |
| scoped route, secret only | `401` | `{"code":"TENANT_CONTEXT_MISSING","message":"X-Tenant-Id header is required"}` |
| scoped route, secret + blank tenant | `401` | `{"code":"TENANT_CONTEXT_MISSING",...}` |
| scoped route, secret + non-UUID tenant | `401` | `{"code":"TENANT_CONTEXT_INVALID","message":"X-Tenant-Id header must be a valid UUID"}` |
| scoped route, secret + valid tenant | `200` | `{"probe":true,"tenantId":"d4101ff1-…"}` |
| scoped route, wrong secret + valid tenant | `401` | `{"code":"UNAUTHORIZED"}` |
| **unmatched** route under the scope, valid creds | `404` | fastify's not-found body |
| **unmatched** route under the scope, no creds | `404` | fastify's not-found body |

**S-9's five-row table reproduces byte-for-byte over a real socket.** The two `404` rows are the
inert-scope property observed from the network for the first time: an unmatched path under the
scope's prefix answers `404` without the guard having answered `401`, which is the same conclusion
Gate 3 reached in-process.

Boundary cases, same process:

| Case | Result |
|---|---|
| missing vs wrong secret | both `401`, `content-length: 23`, byte-identical |
| secret prefix (31 of 42 bytes) | `401` |
| secret superstring (`<secret>X`) | `401` |
| duplicated `x-internal-secret`, correct **then** wrong | `401` |
| duplicated `x-internal-secret`, wrong **then** correct | `401` |
| upper-cased valid UUID tenant | `200`, echoed back **upper-cased** — validated, not normalised |

The two duplicate-secret rows matter: the middleware docblock records that the array arm "is not
reachable through `app.inject`" because fastify joins the values. Over a real socket Node joins
the repeated header lines instead, and the joined value fails `secretsMatch` — so `AU12`'s
property (neither value preferred) holds on the wire, by a different mechanism than in the test.

### 2.2 · AC5's ordering, proven on the wire

A doubly-invalid request discriminates the two hooks by which **code** comes back:

```
no secret + invalid tenant   -> 401 {"code":"UNAUTHORIZED"}
no secret + no tenant        -> 401 {"code":"UNAUTHORIZED"}
good secret + invalid tenant -> 401 {"code":"TENANT_CONTEXT_INVALID", ...}
```

The third row is what makes the first non-vacuous: the tenant hook demonstrably *can* produce
`TENANT_CONTEXT_INVALID`, and does not when the guard rejects first. So an unauthenticated caller
never causes tenant context to be derived — `.claude/rules/tenant-isolation.md` § *Forbidden* —
measured on the shipped `buildAnalyticsServiceApp()` over a socket.

### 2.3 · Two real processes behind the real gateway

Real `apps/gateway` process proxying `/v1/analytics` to the real analytics process, driven with a
real HS256 JWT carrying `sub` / `tenantId` / `role`.

| Case | Result |
|---|---|
| G1 gateway `/health` (public route) | `200 {"status":"ok","service":"gateway"}` |
| G2 proxied scoped route, **no JWT** | `401 {"code":"TOKEN_MISSING"}` |
| G3 proxied scoped route, **valid JWT** | `200 {"probe":true,"tenantId":"d4101ff1-…"}` |
| G4 client spoofs secret **and** tenant, no JWT | `401 {"code":"TOKEN_MISSING"}` |
| G5 valid JWT + client spoofs a **wrong** secret | `200`, tenant from the JWT |
| G6 valid JWT + client spoofs a **different** tenant | `200`, tenant **from the JWT**, not the spoofed header |
| G7 proxied unmatched route, valid JWT | `404` |

G3 is the first end-to-end demonstration that all four isolation layers compose for the analytics
prefix. G5 and G6 are the load-bearing ones: a client's own `x-internal-secret` and `x-tenant-id`
are stripped and re-injected from verified JWT state, so a spoofed wrong secret still yields `200`
and a spoofed foreign tenant yields the **JWT's** tenant. Layer 1 of
`.claude/rules/tenant-isolation.md` holds for this prefix, measured rather than inferred.

### 2.4 · S-58's consequence through two real processes — **review open item #2, now closed**

Round 2 could verify this only through `app.inject` against billing's guard factory. Driven here
as two real processes behind the real proxy: gateway configured from
`apps/worker-service/.env.example`'s / `apps/billing-service/.env.example`'s value
(`dev-local-secret-change-in-production`), analytics from its own
(`dev-local-internal-secret-at-least-32-chars`):

```
client -> gateway -> analytics :  401  {"code":"UNAUTHORIZED"}   (content-length 23)
```

The split is live on the wire, and it fails closed. This is the entry's claim reproduced at the
strength it describes.

### 2.5 · Startup as a real process — **review's `AU24`-through-`import` limit, now closed**

`AU24` drives `parseEnv` through an `import`. Here the real `tsx src/index.ts` entrypoint, with
the parse happening at module load inside the dynamic `await import("./app")`:

| `INTERNAL_API_SECRET` | exit | message |
|---|---|---|
| unset | `1` | `Invalid environment configuration for INTERNAL_API_SECRET: Required` |
| `""` | `1` | `… String must contain at least 32 character(s)` |
| 31 × `a` | `1` | `… String must contain at least 32 character(s)` |
| 32 spaces | `1` | `… String must contain at least 32 character(s)` (trim-then-min) |
| 8 chars padded to 24 | `1` | `… String must contain at least 32 character(s)` |
| 32 chars ending `£` (U+00A3) | `1` | `… must contain only printable ASCII characters (U+0020-U+007E)` |
| 32 chars with an embedded TAB | `1` | `… printable ASCII …` |
| 32 chars with an embedded LF | `1` | `… printable ASCII …` |
| 32 × `a` | listened | `Server listening at http://…:3905` |
| compose's 45-char CI value, `NODE_ENV=production` | listened | `Server listening …` |

**analytics-service genuinely crash-loops without a usable secret** and starts with one. The
trim-before-min ordering and the printable-ASCII rule are both observable at process level, not
only through the schema object.

### 2.6 · The `.env.example` value, run rather than grepped — **Test 4**

A real `.env` was generated from `apps/analytics-service/.env.example` with **only** `PORT`
(3005→3905) and the Redis logical database (0→12, per the hard constraint) changed;
`INTERNAL_API_SECRET` was taken **verbatim** (`diff` of that line: identical). The service was
started with **no** environment variables set at all, so every value came from the file through
`process.loadEnvFile()`. The gateway was configured from its own `.env.example` value.

```
/health                                                  -> 200 {"status":"ok","service":"analytics-service"}
direct to analytics, .env.example secret + tenant        -> 200 {"probe":true,"tenantId":"d4101ff1-…"}
client -> gateway -> analytics, both from .env.example   -> 200 {"probe":true,"tenantId":"d4101ff1-…"}
```

A local run built from the `.env.example` files works end to end. The generated `.env` was
deleted afterwards (it is `.gitignore`d at `.gitignore:6`).

### 2.7 · The `return`-less guard under other hook shapes — **review open item #4, half closed**

Two measurements. First, the real mutation on the shipped middleware — the `return` removed,
`async` kept — driven over a real socket:

```
no secret, no tenant   -> 401 {"code":"UNAUTHORIZED"}
no secret, with tenant -> 401 {"code":"UNAUTHORIZED"}
correct secret+tenant  -> 200
no fastify errors in the process log
```

So the docblock's "the `return` is a statement of intent rather than a behaviour change" holds on
the wire, not only under `app.inject`. Mutation reverted, `md5sum -c` OK.

Second, five hook shapes against fastify **5.10.0** / Node **v22.22.2**, each with a second
`onRequest` hook and a handler behind it, asserting on which hooks ran:

| Shape | Status | Hooks that ran |
|---|---|---|
| `async`, `return reply.status().send()` (shipped) | `401` | `["guard"]` |
| `async`, no `return` | `401` | `["guard"]` |
| callback `(req, reply, done)`, no `return`, **no** `done()` | `401` | `["guard"]` |
| callback `(req, reply, done)`, no `return`, **with** `done()` | `401` | `["guard"]` |
| callback `(req, reply, done)`, `return reply…` | `401` | `["guard"]` |

All five short-circuit and none reaches the second hook or the handler. **The "non-async hook
shape" half of open item #4 is closed at 5.10.0**, including the `done()`-after-`send()` shape
that would be the plausible accident. The "different fastify version" half remains open — it needs
an install, which is out of scope here.

---

## 3 · Acceptance criteria — AC1 to AC6

| AC | Criterion | Status | Proven by | Behaviour or text? |
|---|---|---|---|---|
| **AC1** | `INTERNAL_API_SECRET` **is** `internalApiSecretSchema`; seven fields in order; missing / short / all-whitespace / non-ASCII refused at module load | **Satisfied** | `AU1`–`AU6`, plus §2.5 — all four refusal classes re-measured as a **real process** | Behaviour. `AU1` is an object-identity assertion (`toBe`), which is stronger than a text census — a local re-declaration with identical spelling still reddens. |
| **AC2** | correct secret passes; absent / wrong / prefix / superstring / one-byte-variant / duplicated / non-string all `401` | **Satisfied** | `AU7`–`AU13b`, plus §2.1 over a real socket | Behaviour. `AU13`'s non-string arm is reachable only by calling the factory directly — the docblock says so, and §2.1 confirms the wire never delivers an array for this header. |
| **AC3** | missing and wrong answer byte-identically; the comparison routes through the shared helper; the status is a constant | **Satisfied, with a coverage caveat** | `AU14` (behaviour; re-measured on the wire, both `content-length: 23`); `AU15`, `AU16` | **`AU15` and `AU16` are source-text assertions**, not behavioural. They read the middleware file and match substrings. See F-1: `AU15`'s pattern set is defeatable. `AU16`'s is too (`reply.status(ANALYTICS_RESPONSES…)` is required and `reply.status(401)` forbidden, but a `const U = 401` indirection would pass) — not separately probed. **[Corrected at Gate 6 — see § Corrections at the end of this report.]** |
| **AC4** | valid `X-Tenant-Id` binds byte-identically; absent / blank → missing; non-UUID → invalid; duplicated → invalid with neither value preferred | **Satisfied** | `AU17`, `AU17b`, `AU18`/`AU19`, `AU20`, `AU21`, plus §2.1 — including the upper-case UUID round-tripping unchanged and three duplicate forms | Behaviour. |
| **AC5** | the guard runs **before** the tenant hook; a request with no secret never derives tenant context | **Satisfied** | `AU22` (behaviour, on a test-owned composed app); `AU22b`; plus §2.2 — proven on the **shipped** factory over a real socket | `AU22` is behavioural but composes its **own** app, because production's scope has no route. **`AU22b` is a source-text assertion** over `src/app.ts` — its locator does `indexOf` on two `addHook("onRequest", …)` strings and **throws** on a miss, so it is not vacuous, but it pins text rather than behaviour. §2.2 is the first behavioural proof of AC5 against production's own wiring. |
| **AC6** | `/health` is reachable with **no** secret | **Satisfied** | `AU23`, `AU23b` against the real `buildAnalyticsServiceApp()`; §2.1 row 1 over a real socket | Behaviour, and against the shipped factory rather than a composed app. |

### What is structurally unsatisfiable while the scope is inert

**No acceptance criterion is unsatisfiable**, but the *production reachability* of AC2–AC5 is.
The scope holds no routes, so `AU7`–`AU22` necessarily drive a **test-owned** app composed from
the real factories. The plan states this limit plainly in §7 and the narrowed S-9 entry states it
again. My temporary probe route closed that gap **for this QA run only** — it is not a standing
test, and nothing in the committed tree asserts that a future tenant-scoped route lands inside the
scope. That remains T-051's obligation and is unfalsifiable today.

The practical consequence: **every seam property in §2 was measured against a route that does not
ship.** The wiring is correct; whether T-051 uses it is the open question, and it is recorded in
four places plus the epic.

---

## 4 · Full gate, all 13 packages, `--force`

Run twice: once on the tree as received, and again on the restored tree after all mutations were
reverted. Identical results both times. Figures below are the **final** run.

| Task | Tasks | Cached | Exit |
|---|---|---|---|
| `pnpm build --force` | 13 successful, 13 total | **0 cached, 13 total** | 0 |
| `pnpm typecheck --force` | 13 successful, 13 total | **0 cached, 13 total** | 0 |
| `pnpm lint --force` | 13 successful, 13 total | **0 cached, 13 total** | 0 |
| `pnpm test --force` | 13 successful, 13 total | **0 cached, 13 total** | 0 |

`Cached: 0` on all four — these are real runs, not replays of the implementer's cache.

### Per-package tests — **1066 total, 0 failures**

| Package | Tests |
|---|---|
| `@telemetry/shared-types` | 8 passed |
| `@telemetry/shared-config` | 4 passed |
| `@telemetry/shared-logger` | 4 passed |
| `@telemetry/shared-tracing` | 2 passed |
| `@telemetry/shared-validation` | 30 passed |
| `@telemetry/shared-utils` | 26 passed |
| **`@telemetry/analytics-service`** | **56 passed** (7 files) |
| `@telemetry/gateway` | 50 passed |
| `@telemetry/usage-service` | 238 passed |
| `@telemetry/billing-service` | 231 passed |
| `@telemetry/auth-service` | 166 passed |
| `@telemetry/worker-service` | 251 passed |

The table has 12 rows against 13 packages. The thirteenth is **`@telemetry/web`**, whose `test`
script is `vitest run --passWithNoTests` and which contains **no test files**, so it emits no
`Tests N passed` line — it is listed among the 13 successful turbo tasks and contributes 0 to the
1066. Named rather than left as a gap in the arithmetic: all 13 `:test:` task prefixes appear in
the log and `@telemetry/web:test:` is one of them.

### Lint — 14 warnings, 0 errors, all pre-existing and proven so

```
@telemetry/auth-service:lint:  ✖ 10 problems (0 errors, 10 warnings)
@telemetry/usage-service:lint: ✖  4 problems (0 errors, 4 warnings)
```

Provenance, per `.claude/rules/review-standards.md`'s requirement to prove it rather than assert
it:

```
apps/auth-service/tests/auth.service.unit.test.ts        d68e719  2026-08-25
apps/usage-service/tests/ingestion.service.unit.test.ts  b0f6921  2026-08-31
```

Both files are committed, both predate this change, and **neither appears in the 19-entry working
set**. No warning is attributable to S-9.

`pnpm format:check` was **not** run — S-12 records that it cannot pass on any revision of this
repository.

---

## 5 · Regression risk across the other 12 packages

**The blast radius is consumption-only, and this was measured rather than reasoned about.**

```
git status --porcelain packages/            -> 0 entries
git status --porcelain apps/ | grep -v analytics-service  -> 0 entries
```

No shared package is modified and no other app is touched. Every symbol analytics newly imports
already exists at HEAD:

| Symbol | Package | `export` present at HEAD |
|---|---|---|
| `INTERNAL_AUTH_HEADERS` | `shared-types` | yes |
| `INTERNAL_AUTH_RESPONSES` | `shared-types` | yes |
| `TENANT_CONTEXT_HEADERS` | `shared-types` | yes |
| `internalApiSecretSchema` | `shared-validation` | yes |
| `tenantIdSchema` | `shared-validation` | yes |
| `secretsMatch` | `shared-utils` | yes |

So no shared export changed shape, and the only cross-package artifacts touched are
`docker/docker-compose.yml` (compose-only) and documentation. Combined with 13/13 green on all
four tasks with `Cached: 0`, **no breaking change is introduced in the other 12 packages.**

### CI

`.github/workflows/ci.yml` is **unmodified** and already carries
`INTERNAL_API_SECRET: ci-internal-api-secret-with-at-least-32-chars` at job level (`:48`),
inherited by every step. Nothing needed to change there, and the implementer's reasoning about
*why* — turbo's strict env mode means `tests/setup.ts`, not the job-level variable, is what feeds
`pnpm test` — is correct and was verified by execution (§F-2). Both mechanisms are in place, which
is the belt-and-braces outcome.

### Compose

`docker compose config` exits **0** and the YAML merge resolves as intended — the inline
`INTERNAL_API_SECRET` coexists with the `<<: *common-app-env` anchor without either clobbering the
other:

```
analytics-service -> INTERNAL_API_SECRET=ci-internal-api-secret-with-at-least-32-chars, PORT=3005,
                     DATABASE_URL=…@postgres:5432/telemetry
gateway           -> INTERNAL_API_SECRET=ci-internal-api-secret-with-at-least-32-chars,
                     ANALYTICS_SERVICE_URL=http://analytics-service:3005
```

All five blocks carry one identical value; gateway and analytics agree, which is what the proxied
call needs. Compose's value deliberately differs from every `.env.example` — S-58's separate-worlds
point, not a defect, and confirmed as such here.

---

## 6 · What I could **not** exercise, and why

1. **The analytics container itself.** The Docker daemon is not running in this environment —
   `Cannot connect to the Docker daemon at unix:///home/admin1/.docker/desktop/docker.sock`. A
   build was attempted and failed for that reason; `docker compose config` is client-side and did
   succeed. Separately, even with a daemon, `docker compose up` would conflict with the **native**
   PostgreSQL and Redis holding `:5432` and `:6379`, and the hard constraints forbid stopping
   them, so `depends_on: postgres: condition: service_healthy` could not be met. **Partially
   compensated:** compose's exact 45-character value was driven through the real analytics
   entrypoint under `NODE_ENV=production` and the service listened (§2.5). What remains unproven
   is the Dockerfile's own build and its `pnpm --filter … exec tsx src/index.ts` CMD.
2. **The `return`-less guard on a fastify version other than 5.10.0.** Would need an install. Five
   hook *shapes* were closed at 5.10.0 (§2.7); the version axis was not varied.
3. **An exhaustive search for `AU15` evasions.** F-1 found a second class beyond the length oracle.
   One more found is not a proof that the set is now complete — the opposite, on S-51's evidence
   that each gate has found a spelling the previous one had not.
4. **`AU16`'s evasion surface.** Reasoned about in §3 but not probed; F-1 consumed the budget.
5. **That T-051's route will land inside the guarded scope.** Structurally unfalsifiable while the
   scope is empty. This is the change's own declared limit and is documented in four places.
6. **The reviewer's nine mutation→case mappings, the twenty-plus inert-scope forms, the six hook
   phases and the four-placement table.** Deliberately not re-run — re-running them reprints the
   review rather than adding evidence. I verified the *conclusions* they support behaviourally,
   over a real socket, which is the independent path.

---

## 7 · Recommended for `.claude/rules/known-gaps.md`

Neither is a blocker; both are out of scope to fix here.

1. **F-1** — a second `AU15` evasion class, defeating the census with a live `===` beside a dead
   `secretsMatch("", "")`. File under S-51's family with the snippet and the three green results.
   It is materially worse than the recorded length oracle because it restores a byte-prefix
   oracle rather than a length one.
2. **F-2** — `pnpm test` (turbo, strict env, ambient value filtered) and
   `pnpm --filter <pkg> exec vitest run` (no turbo, ambient value honoured) disagree for an
   *invalid* `INTERNAL_API_SECRET`. Pre-existing across billing, worker and usage; analytics is
   the fourth. Sharpened by the repo's own root `.env` shipping a 16-character value, and by the
   divergent path being the one `CLAUDE.md` and `.claude/rules/testing.md` recommend for scoping.

F-3 and O-1 are recorded in this report only; neither warrants an id.

---

## 8 · Environment hygiene

**Database — identical at both ends, as required.**

| Table | Before | After |
|---|---|---|
| `Tenant` | **2** | **2** |
| `Event` | 0 | 0 |
| `UsageLine` | 0 | 0 |
| `Invoice` | 0 | 0 |
| `InvoiceLineItem` | 0 | 0 |
| `Meter` | 0 | 0 |
| `MetricRollup` | 0 | 0 |
| `RefreshToken` | 0 | 0 |
| `User` | 2 | 2 |

No row was seeded; the one tenant id used by the probes was **read**, not created. No migration
was rolled back and no role was dropped. No running service was pointed at
`DIRECT_DATABASE_URL` — every probe process used the `telemetry_app` runtime DSN.

**Redis.** All probe traffic was confined to **db 12**. Final: `db0=2`, `db12=0`, `db13=0`,
`db14=0`, `db15=0` — identical to the pre-QA baseline.

db 0 was observed at `3` mid-run and returned to `2` on its own. Inspected rather than assumed:
the extra key was `denylist:<hash>` with a live TTL, alongside the two pre-existing entries
(`denylist:…` and `telemetry:events`). That is exactly the S-22 mechanism — auth-service's suite
writing self-expiring denylist keys to db 0 during `pnpm test` — and not a probe of mine. Nothing
was written to or flushed from db 0.

---

## 9 · Restoration ledger

Three source files were mutated and one file created. Every revert was from a `cp` backup taken
**before** the mutation and verified with `md5sum -c`. **No `git checkout --`, `git restore` or
`git stash` was used on any tracked file.**

| File | Mutation | Restored | `md5sum -c` |
|---|---|---|---|
| `apps/analytics-service/src/app.ts` | temporary probe route inside the `app.register` scope | from `app.ts.pristine` | **OK** (`88623c86…`) |
| `apps/analytics-service/src/middleware/internal-auth.middleware.ts` | (a) `return` removed; (b) F-1's `===` evasion | from `iam.pristine`, after each | **OK** (`4ec7621a…`) |
| `apps/analytics-service/src/constants.ts` | none — backed up as a precaution | n/a | **OK** (`ede24a6c…`) |
| `apps/analytics-service/.env` | created from `.env.example` for §2.6 | deleted | absent; `.gitignore:6` |

Two throwaway scripts (`qa-mintjwt.mjs`, `qa-hookshape-probe.mjs`) were written into package
directories to resolve workspace dependencies and were deleted immediately; a repo-wide grep for
`QA-PROBE`, `qa-probe`, `qa-mintjwt` and `qa-hookshape` across `apps`, `packages`, `docker`,
`docs` and `.github` returns **0** matches.

**Whole-tree verification.** An `md5sum` manifest of every `.ts`, `.yml`, `.mjs`, `.json` and
`.env.example` under `apps/analytics-service`, `apps/gateway` and `docker` (78 files) was taken
before and after:

```
diff tree.before.md5 tree.after.md5   -> no differences
diff status.before.txt status.after.txt -> no differences   (19 entries, unchanged)
```

All spawned processes were terminated; `pgrep -af "tsx src/index.ts"` returns no service process.

---

## 10 · Release-readiness call

# PASS

**The change is release-ready from QA's standpoint**, subject to the two text-only MEDIUM
corrections already queued for Gate 6 (S-58's counts, S-57's universal), which I re-derived and
confirm are correctly stated by the orchestrator.

The reasoning, stated at the strength the evidence supports:

- **Everything the change claims to do, it does, and now it does so as a real process.** The
  guard, the tenant hook, their ordering, the `/health` exemption and the env schema's four
  refusal classes were all driven over real sockets and through a real gateway proxy — the axis
  neither review round could reach. S-9's five-row table reproduces byte-for-byte, and the
  four-layer isolation chain composes end to end for the analytics prefix, including the two
  spoofing cases (G5, G6) that prove the gateway's strip-and-reinject rather than assuming it.
- **The gate is genuinely green**: 13/13 on all four tasks with `Cached: 0`, 1066 tests, analytics
  56/56, 14 warnings all proven pre-existing with commits behind them. Re-run on the restored tree
  with identical results.
- **Regression risk across the other 12 packages is minimal and measured**, not asserted: zero
  changes under `packages/`, zero changes to any other app, and every newly consumed symbol
  already exported at HEAD.
- **Two review open items are closed** (S-58 through two real processes; the `return`-less guard
  across five hook shapes at 5.10.0) and **one is answered in the affirmative** (a further `AU15`
  evasion exists, and it is worse than the one on record).
- **The two findings are both LOW and neither is a defect in shipped behaviour.** F-1 is a limit
  of a test the change's own docblock already declines to overclaim for. F-2 is pre-existing
  platform-wide and analytics acquired it by correctly mirroring three peer services.

**The honest caveat, restated because it is the thing a reader should carry away.** The guarded
scope holds **no routes**. Every seam property in this report — including all of §2 — was measured
against a probe route that does not ship and that I removed. The wiring is correct and the
security seam works; what no test on this tree can establish is that T-051 registers its route
*inside* that scope. A route registered outside it would be unauthenticated and untenanted, and
on this tree nothing would notice. That obligation is recorded in S-9, in `tenant-isolation.md`,
in the plan, in `src/app.ts`'s own comment and in the epic — which is as much as this change can
do about it.

**FAIL was not warranted**: no acceptance criterion is unmet, no defect was found in shipped
behaviour, no regression was introduced, and both findings are coverage observations with a
recommended home in `known-gaps.md` rather than in the diff.

---

## Corrections

Appended after this report was filed. **Nothing above is rewritten**: the original claims are left
byte-identical and each correction names what replaced it, because editing a gate's record in
place hides that it once said something false — the same reason `.claude/rules/known-gaps.md`
never deletes a superseded claim without recording it.

### C-1 · §3's `AU16` aside is wrong on the naive form — source: Gate 6 (LOW-8), re-measured at the Gate-6 rework

§3's AC3 row says of `AU16`: *"a `const U = 401` indirection would pass"*, hedged as
**"not separately probed"**. That hedge was load-bearing and the prediction it hedged is **false**.
Measured, each mutation applied to `apps/analytics-service/src/middleware/internal-auth.middleware.ts`
and reverted with `md5sum -c`:

| Form | Body | Result |
|---|---|---|
| **A — naive**, exactly as §3 describes | `const U = 401;` then `reply.status(U)` | **Caught.** `Tests 1 failed \| 13 passed (14)` — `AU16` red |
| **B — decoy**, S-59's trick applied to `AU16` | the same, plus `void ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED;` | **Passes.** `Tests 56 passed (56)` |

The reason is that `AU16` makes **two** assertions, not one: the forbidden substring
`reply.status(401)` **and** the required substring `ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED`.
The naive indirection removes the last reference to the constant, so the *positive* assertion
fails. Only a decoy that keeps the substring alive while routing the real value around it gets
through — which is the same shape as S-59's `AU15` evasion, where `secretsMatch("", "")` satisfies
the positive assertion while `===` makes the decision.

**So the conclusion §3 drew survives and its reasoning does not.** `AU16`'s pattern set *is*
defeatable, which is what the row was warning about, and the caveat on AC3 stands unchanged. What
is wrong is the specific form named: the cheap mistake is caught and only the deliberate one is
not. That distinction matters to whoever acts on this — hardening `AU16` against `const U = 401`
would be defending against the form that already fails.

Recorded here rather than folded into S-59 because S-59 is scoped to `AU15`; the shared shape is
noted in that entry and in `AU15`'s docblock, and neither claims to cover `AU16`.
