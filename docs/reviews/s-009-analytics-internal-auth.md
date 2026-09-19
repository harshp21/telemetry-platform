# Senior Review — S-9 slice 1 · analytics-service internal-auth guard and tenant context

## Round 1

**Gate 4 (pre-QA).** Read-only. HEAD `1220051`; the whole change is uncommitted in the working
tree. Every file mutated during this review was backed up by copy to the scratchpad and restored,
with `md5sum -c` confirming all five restorations. `git status --porcelain` at the end of the
review is byte-identical to the start (12 modified, 5 untracked).

`.claude/rules/*` were `cat`-ed from disk before being cited (S-24): `tenant-isolation.md`
md5 `2415270c1517cef9059391099be8399d` (160 lines), `known-gaps.md` md5
`4b0b9a3c02844d2e22d301bf0848430a` (3 907 lines, 48 `## S-` headings). On this occasion the
injected copies matched disk.

---

## Findings

### MEDIUM-1 · A false universal in a docblock beside the security guard — refuted by execution

`apps/analytics-service/tests/internal-auth.middleware.unit.test.ts:63-64`

> Scope, so it is not over-read: these are text checks on two files. They notice the specific
> regressions they name and would not notice a leaky comparison written some third way. They are
> also brittle in the harmless direction … **A false positive is possible; a false negative is
> not, which is the right way round.**

The first two sentences are true and are the correct statement. The last sentence is a universal
and it is **false**. Measured — mutation **M-A3**, applied to
`src/middleware/internal-auth.middleware.ts:65` and reverted:

```ts
if (
  typeof providedSecret !== "string" ||
  internalApiSecret.length !== providedSecret.length ||   // <- length oracle
  !secretsMatch(providedSecret, internalApiSecret)
) {
```

Result: `pnpm --filter @telemetry/analytics-service exec vitest run` → **`Tests 56 passed (56)`**,
`pnpm --filter @telemetry/analytics-service typecheck` clean, **`AU15` green**. That edit
reintroduces a genuine timing side channel — an unauthenticated caller learns the configured
secret's exact length from response latency — and no test on the tree notices. It is a false
negative, and it is the *class of defect AU15 exists for*.

Note the near-miss that makes this easy to get wrong: written the other way round
(`providedSecret.length !== internalApiSecret.length`, mutation **M-A2**) AU15 *does* redden —
but only by accident, because the substring `!== internalApiSecret` happens to appear. One
operand order catches it; the other does not.

`.claude/rules/review-standards.md` § *Claims the Change Makes*: "A false claim beside
security-relevant code is at least MEDIUM; the next person to edit it will believe it."

**Fix (`file:line` + concrete change):** at
`apps/analytics-service/tests/internal-auth.middleware.unit.test.ts:63-64`, delete the sentence
"A false positive is possible; a false negative is not, which is the right way round." and
replace it with the measured form, e.g.:

> A false positive is possible — a reflow reddens these while behaviour is unchanged. A false
> negative is possible too, and is the more important direction: measured at Gate 4, a
> length-comparison oracle written `internalApiSecret.length !== providedSecret.length ||
> !secretsMatch(...)` keeps both assertions green at 56/56 with typecheck clean. These catch the
> two spellings they name and nothing else.

**Disposition:** must fix before QA. Text-only; no behavioural change, no re-run of the gate
needed beyond the package suite.

---

### MEDIUM-2 · The constants gate: analytics becomes the **third** copy of four tenant-context literals, with no promotion and no durable record

`apps/analytics-service/src/constants.ts:44-47`

`.claude/rules/constants.md` (a **required** review gate): *"Prefer a shared package constant when
the same value appears in more than one service — before adding a third copy of a literal, promote
it."*

Measured census (`grep -rn '"TENANT_CONTEXT_MISSING"' apps/*/src packages/*/src --include=*.ts`,
`dist/` filtered, and the same for the other three strings) — **three sites each, all executable,
after this change**:

| Literal | usage | billing | analytics (new) |
|---|---|---|---|
| `"TENANT_CONTEXT_MISSING"` | `constants.ts:27` | `constants.ts:83` | `constants.ts:44` |
| `"X-Tenant-Id header is required"` | `:28` | `:84` | `:45` |
| `"TENANT_CONTEXT_INVALID"` | `:29` | `:85` | `:46` |
| `"X-Tenant-Id header must be a valid UUID"` | `:30` | `:86` | `:47` |

`packages/shared-types/src/index.ts` already exports `TENANT_CONTEXT_HEADERS` (`:103`) and
`INTERNAL_AUTH_RESPONSES`, and **this same file derives both of those correctly** —
`ANALYTICS_HEADERS` (`:21-24`) takes both header names from shared-types, and
`CODE_UNAUTHORIZED` (`:33`) takes its value from `INTERNAL_AUTH_RESPONSES`. So the rule was
applied to two of three vocabularies in one file and not the third. The constants block's own
comment at `:39-42` even records the duplication ("matching usage-service's and
billing-service's codes, messages and `401` status verbatim") without promoting it or filing it.

This is how S-19 reached seven copies and S-39 three: each addition was locally reasonable.
S-39's precedent is the one to follow — it promoted the header name *because* billing would have
been the third copy, and it recorded the two it could not rewire in `known-gaps.md`. This change
did neither for the tenant-context vocabulary.

**Fix — one of two, and it is a decision (see § Decisions below):**
(a) add `TENANT_CONTEXT_RESPONSES = { CODE_MISSING, MESSAGE_MISSING, CODE_INVALID, MESSAGE_INVALID }`
to `packages/shared-types/src/index.ts` beside `TENANT_CONTEXT_HEADERS`, and point
`apps/analytics-service/src/constants.ts:44-47`, `apps/billing-service/src/constants.ts:83-86`
and `apps/usage-service/src/constants.ts:27-30` at it; or
(b) keep the third copy and add a `known-gaps.md` entry recording it, in **this** change.

**Disposition:** must be resolved one way or the other before QA. A source comment is not a
durable record — `CLAUDE.md` says the same about `docs/plans/`.

---

### LOW-1 · `known-gaps.md` S-9 lists four properties and says "each of those three"; the untested fourth reddens nothing

`.claude/rules/known-gaps.md`, S-9, bullet 2 (the `src/middleware/internal-auth.middleware.ts`
bullet):

> … the same `secretsMatch` …, a non-string header rejected rather than normalised, a returned
> `reply`, and `ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED` rather than a literal. **Each of
> those three** reddens exactly one named case when reverted (`AU15`, `AU13`, `AU16`
> respectively, one failure each).

Four properties are listed; three ids follow. **The three mappings that are named are each
exactly right** — re-derived by three separate mutations, each reverted:

| Mutation | Result |
|---|---|
| `!secretsMatch(...)` → `internalApiSecret !== providedSecret` | `Tests 1 failed \| 13 passed (14)` — **AU15** only |
| `const providedSecret = Array.isArray(raw) ? raw[0] : raw` | `Tests 1 failed \| 55 passed (56)` — **AU13** only |
| `.status(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED)` → `.status(401)` | `Tests 1 failed \| 55 passed (56)` — **AU16** only |

The fourth listed property — the returned `reply` — is caught by **nothing**. Measured
(mutation M-J): replacing `return reply.status(...).send(...)` with an un-returned
`reply.status(...).send(...); return;` leaves analytics **56/56 green**. The middleware's own
docblock at `:37-39` says so honestly ("a statement of intent rather than a behaviour change"),
so the entry is looser than the code it describes. A reader who maps "those three" onto the first
three listed items gets a false claim, in a file `CLAUDE.md` designates authoritative.

**Fix:** in `.claude/rules/known-gaps.md` S-9, change "Each of those three reddens exactly one
named case when reverted (`AU15`, `AU13`, `AU16` respectively, one failure each)" to: "The first,
second and fourth of those four each redden exactly one named case when reverted (`AU15`, `AU13`,
`AU16` respectively, one failure each). The returned `reply` is caught by nothing — dropping the
`return` leaves analytics 56/56 green, which the middleware's own docblock states."

**Disposition:** fix before QA. One sentence.

---

### LOW-2 · The new `.env.example` comment claims the value matches every other service; it matches none of them

`apps/analytics-service/.env.example:20-23`

```
# Shared with the gateway, which attaches it to every proxied /v1/analytics request. Required,
# no default: analytics-service does not start without it. Must match every other service's
# value, be at least 32 characters after trimming, and contain only printable ASCII.
INTERNAL_API_SECRET=ci-internal-api-secret-with-at-least-32-chars
```

Measured (`grep -rn "INTERNAL_API_SECRET" apps/*/.env.example docker/docker-compose.yml`):

| File | Value | Length |
|---|---|---|
| `apps/gateway/.env.example:18` — **the producer** | `dev-local-internal-secret-at-least-32-chars` | 43 |
| `apps/usage-service/.env.example:18` | `dev-local-internal-secret-at-least-32-chars` | 43 |
| `apps/billing-service/.env.example:35` | `dev-local-secret-change-in-production` | 37 |
| `apps/worker-service/.env.example:58` | `dev-local-secret-change-in-production` | 37 |
| **`apps/analytics-service/.env.example:23` (new)** | `ci-internal-api-secret-with-at-least-32-chars` | 45 |

So the added comment's "Must match every other service's value" is false against its own file, and
the new file introduces a **third** spelling into `.env.example` — and the one it picked is the
*CI/compose* value, which none of the other four use in `.env.example`. A developer who copies the
`.env.example` files verbatim gets a gateway sending `dev-local-internal-secret-at-least-32-chars`
to an analytics expecting `ci-internal-api-secret-with-at-least-32-chars`.

Not live today: the guarded scope holds no routes, so nothing is proxied through the guard, and
the pre-existing gateway↔billing/worker split already has the same defect. The `docker-compose.yml`
side is **correct** — all five blocks (`:93,112,135,164,190`) carry the identical
`ci-internal-api-secret-with-at-least-32-chars`, verified.

**Fix:** set `apps/analytics-service/.env.example:23` to
`INTERNAL_API_SECRET=dev-local-internal-secret-at-least-32-chars`, matching
`apps/gateway/.env.example:18` (the service that *sends* the header). Recommend also recording
the pre-existing three-way `.env.example` split as a `known-gaps.md` entry — it is out of scope to
fix here (it touches billing's and worker's files) and it will silently break the first developer
who runs the full stack from `.env.example`.

**Disposition:** fix the analytics line before QA; the platform-wide split is a separate entry.

---

### LOW-3 · The plan's §4.8 correction quotes figures from an unnamed intermediate tree, and §4.8 itself still carries the wrong claim

`docs/plans/s-009-analytics-internal-auth.md:542-544` (§10):

> §4.8's "all 30 existing tests fail at import" was measured at **3 of 5 files collecting zero
> tests, 26 of 37 cases never running**; the other two files import neither `src/app.ts` nor
> `src/config/env.ts`.

The correction is right in substance — §4.8's claim *is* false. But `37` is not the case count of
any tree the plan names: the pre-change tree is 30 cases (§4.8's own number) and the shipped tree
is 56. The figures reconcile exactly to an **intermediate** tree — after `env.schema.unit.test.ts`
was extended to 19 cases but before the two middleware test files existed: 19 + 7 + 1 + 6 + 4 = 37,
with `env.schema`(19) + `smoke`(1) + `config/container`(6) = 26 uncollected across 3 of 5 files.

Re-measured on the **shipped** tree (mutation M-G: delete
`apps/analytics-service/tests/setup.ts:17`, then `vitest run`, then restore):

```
❯ tests/env.schema.unit.test.ts             (0 test)
❯ tests/smoke.test.ts                       (0 test)
❯ tests/internal-auth.middleware.unit.test.ts (0 test)
❯ tests/config/container.unit.test.ts       (0 test)
 Test Files  4 failed | 3 passed (7)
      Tests  16 passed (16)
```

i.e. **4 of 7 files collect zero and 40 of 56 cases never run**. This is the S-33 shape — a
measured count already stale inside the change that records it.

Second half: §4.8's table at `:329` still reads "**all 30 existing tests fail at import**" with no
forward pointer to §10. A reader landing on §4.8 never reaches the correction — S-32's residual.

**Fix:** at `docs/plans/s-009-analytics-internal-auth.md:542-544`, name the tree ("measured after
S1–S3, with `env.schema.unit.test.ts` at 19 cases and the two middleware suites not yet written")
and add the shipped-tree figures (4 of 7 files, 40 of 56 cases). At `:329`, replace "all 30
existing tests fail at import" with "every suite importing `src/app.ts` or `src/config/env.ts`
fails to collect — see §10" .

**Disposition:** fix before QA. Plan text only.

---

### LOW-4 · epic-9's T-051 **Files** line reproduces exactly the trap S-9 exists to prevent — and its right home is S-9, not S-53

`docs/epics/epic-9-analytics-service.md` § *T-051*:

> **Files**: `controllers/analytics.controller.ts`, `services/analytics.service.ts`,
> `repositories/rollup.repository.ts`

`src/app.ts` is absent, and nothing in the section says the route must be registered **inside** the
existing `app.register` callback. Measured why that matters — probes **C1** and **D1** below: a
route registered in a *sibling* scope under the same prefix, or on the root instance at the same
path, answers `200` with the guard's hooks never running. An implementer following that Files line
literally ships an unauthenticated, untenanted `/v1/analytics/metrics`, and — as S-9 already says —
nothing on this tree would notice.

**On the implementer's proposed disposition:** folding this into **S-53 is wrong**. S-53's title
and body are scoped to the rollup SQL (`AT TIME ZONE` on the column, snake_case identifiers, the
`$2`/`$3` bound-parameter half), and it *already* records both of the SQL-snippet defects the
implementer flagged — I re-read it; nothing new needs filing there. A **new id is also wrong**:
S-9 already carries the discharge instruction ("T-051 must register its route **inside** that
callback") and is the entry this change is narrowing. The right home is **S-9's existing
"Discharged by T-051" paragraph**, extended with one sentence naming the epic's Files line as the
thing that will mislead, plus a one-line forward reference in the epic itself — the shape S-32's
fix direction recommends and that S-45 already applied to epic-8's T-048.

**Fix:**
1. `docs/epics/epic-9-analytics-service.md` § *T-051*, **Files** line: append
   `src/app.ts` (register the route **inside** the existing `app.register` scope — see
   `.claude/rules/known-gaps.md` S-9; a route registered outside it is unauthenticated and
   untenanted).
2. `.claude/rules/known-gaps.md` S-9, "Discharged by T-051" paragraph: add that
   `docs/epics/epic-9-analytics-service.md` § *T-051*'s Files line names three files and not
   `src/app.ts`, so the epic on its own leads to the unguarded registration.

**Disposition:** recommend fixing in this change, because this change is the one that creates the
trap. Acceptable to defer item 1 to T-051's Gate 1 if item 2 lands now.

---

### LOW-5 · The hand-off report's lint attribution cites a commit that never touched the file

Reported: 10 × `no-misused-promises` in `apps/auth-service/tests/auth.service.unit.test.ts`
trace to `1b872b3`. Measured:

```
$ git log --oneline --all -- apps/auth-service/tests/auth.service.unit.test.ts
d68e719 test(services): expand coverage for singleton, container, and shutdown flows
748cdd4 test(auth): add comprehensive unit tests for register endpoint (T-018 refinement)
$ git log --oneline -1 1b872b3
1b872b3 fix(security): move auth-service onto a restricted DB role (S-7)
```

`1b872b3` exists but appears nowhere in that file's history. The correct citation is `d68e719`
(2026-08-25). The usage-service attribution (`b0f6921`, 2026-08-31) **is** correct. The conclusion —
both sets pre-existing — is unaffected and independently confirmed below.

**Fix:** none in the tree; correct the citation in the hand-off / commit message if it is repeated
there. Recorded because fabricated finding-id and commit citations are a standing failure mode
(S-33).

---

### NIT-1 · AU23b's stated justification does not hold, though the case is worth keeping

`apps/analytics-service/tests/internal-auth.middleware.unit.test.ts:385-388`:

> Without this, a `/health` that had silently moved inside the scope would still satisfy AU23 for
> a caller that happened to authenticate.

AU23 sends **no** headers, so under that mutation AU23 fails too. Measured (mutation M-C, `/health`
moved inside the guarded scope): `Tests 3 failed | 53 passed (56)` — **AU23, AU23b and the smoke
test all red**. AU23b earns its place on a different property (byte-identical body with and without
credentials), which is real; the sentence justifying it is not.

**Fix:** reword to the property it actually pins — "the other half of the exemption: sending a
valid secret and tenant must not *change* the answer, which AU23 alone cannot see."

### NIT-2 · The two new security middleware files sit outside analytics' coverage thresholds

`apps/analytics-service/vitest.config.mjs:22` lists `"src/middleware/**"` in `coverage.exclude`.
**Not counted against this change**: the file is unmodified (`git status --porcelain` empty,
`git log -1` → `97a4603`, 2026-08-25), the same glob is present in all five services with a vitest
config, and `pnpm test` is `vitest run` with no `--coverage`, so the thresholds enforce nothing
either way. Recorded as another instance inside S-25 § 1's open scope, not as a new gap.

---

## What I verified, and how

### 1 · The inert-scope universal — re-derived, **not** read from the transcript. It holds.

The claim (asserted in `src/app.ts:43-52`, the guard docblock `:14-20`, the test docstring `:14-21`,
S-9 and `.claude/rules/tenant-isolation.md`) is that at fastify 5.10.0 an `app.register` scope
carrying `onRequest` hooks and **no routes** never runs those hooks. The implementer varied three
dimensions. I varied **sixteen more**, on `fastify 5.10.0` / `node v22.22.2` (versions read from
`node_modules/.pnpm/fastify@5.10.0/.../package.json` and `node -v`), instrumenting **six** hook
phases (`onRequest`, `preHandler`, `onError`, `onSend`, `onResponse`, `onTimeout`) rather than one:

```
A1 shipped: GET /health                                    -> 200  hooks=[]
A2 shipped: HEAD /health                                   -> 200  hooks=[]
A3 shipped: GET /v1/analytics/usage (404)                  -> 404  hooks=[]
A4 shipped: POST /health (method mismatch)                 -> 404  hooks=[]
A5 shipped: OPTIONS /health                                -> 404  hooks=[]
A6 shipped: GET / (root)                                   -> 404  hooks=[]
B1 prefixed empty scope: GET /v1/analytics  (prefix root)  -> 404  hooks=[]
B2 prefixed empty scope: GET /v1/analytics/ (trailing /)   -> 404  hooks=[]
B3 prefixed empty scope: GET /v1/analytics/x               -> 404  hooks=[]
B4 prefixed empty scope: HEAD /v1/analytics/x              -> 404  hooks=[]
C1 sibling scope same prefix: GET /v1/analytics/usage      -> 200  hooks=[]
C2 sibling scope same prefix: GET /v1/analytics/nope       -> 404  hooks=[]
D1 root route same path: GET /v1/analytics/usage           -> 200  hooks=[]
E1 unprefixed empty scope: GET /boom (500, onError phase)  -> 500  hooks=[]
G1 shipped: GET /%zz (bad url, 400)                        -> 400  hooks=[]
G2 shipped: POST unknown content-type body                 -> 404  hooks=[]
```

Controls, in the same process, proving the instrumentation is live:

```
F1 CONTROL route inside scope: GET /v1/analytics/usage -> 200 hooks=[S:onRequest,S:preHandler,S:onSend,S:onResponse]
F3 CONTROL: HEAD /v1/analytics/usage                   -> 200 hooks=[S:onRequest,S:preHandler,S:onSend,S:onResponse]
F2 CONTROL: GET /health (sibling on root)              -> 200 hooks=[]
F4 CONTROL: POST /v1/analytics/usage (mismatch)        -> 404 hooks=[]
F5 CONTROL: GET /v1/analytics/other (404 sibling)      -> 404 hooks=[]
```

**No form ran the hooks. The universal is not refuted — it is now established over nineteen forms
and six phases rather than three forms and one.** Two of my additions (C1, D1) are the
security-relevant ones and they sharpen rather than weaken the claim: a route under the *same
prefix* in a *different* scope, and a route on the root instance at the same path, both answer
`200` completely unguarded. That is LOW-4's substance.

Then against the **shipped** factory (`tsx`, real `buildAnalyticsServiceApp()`, real env):

```
GET  /health              -> 200 {"status":"ok","service":"analytics-service"}
HEAD /health              -> 200
GET  /v1/analytics/usage  -> 404   (with and without a wrong x-internal-secret)
GET  /v1/analytics        -> 404
POST /health              -> 404
printRoutes: └── / └── health (GET, HEAD)      <- one route on the whole instance
```

### 2 · The S-9 seam table — reproduced exactly

S-9's five-row table was re-derived by registering one probe route inside the *production* scope
(mutated, then restored, md5 verified) and injecting against the real factory:

```
no headers               /health             -> 200 {"status":"ok","service":"analytics-service"}
no headers               /v1/analytics/probe -> 401 {"code":"UNAUTHORIZED"}
secret only              /v1/analytics/probe -> 401 {"code":"TENANT_CONTEXT_MISSING","message":"X-Tenant-Id header is required"}
secret + tenant          /v1/analytics/probe -> 200 {"tenantId":"1111...1111"}
wrong secret + tenant    /v1/analytics/probe -> 401 {"code":"UNAUTHORIZED"}
secret + bad tenant      /v1/analytics/probe -> 401 {"code":"TENANT_CONTEXT_INVALID","message":"X-Tenant-Id header must be a valid UUID"}
health + bad tenant      /health             -> 200 {"status":"ok","service":"analytics-service"}
```

All five of S-9's rows match byte-for-byte. The sixth and seventh are mine and confirm the tenant
hook's two codes are distinct on the wire and that `/health` is unaffected by a malformed tenant
header.

### 3 · `.claude/rules/tenant-isolation.md` — every count re-derived independently

Not by re-running the implementer's greps. By opening each of the four services' `app.ts` and
middleware:

| Claim | Verified how | Result |
|---|---|---|
| **four** guards | `ls apps/*/src/middleware/internal-auth.middleware.ts` | analytics, billing, usage, worker — 4 |
| all four **`onRequest`** | read each registration: usage `middleware/internal-auth.middleware.ts` `registerUsageInternalAuthMiddleware` → `app.addHook("onRequest", …)`; billing `app.ts:80`,`:120`; worker `app.ts:74`; analytics `app.ts:71` | 4/4 `onRequest`, no `preHandler` |
| all four **`secretsMatch`** | `grep -nE "secretsMatch\|!==\|===" ` per file | 4/4 import and call `secretsMatch`; **zero** `!==`/`===` comparisons of the secret in any of the four |
| `/health` exempt: **allowlist in usage** | `apps/usage-service/src/middleware/public-routes.ts:12-17` (`USAGE_SERVICE_PUBLIC_ROUTES`, `isPublicRoute`), consulted first in the guard body | confirmed — usage's hooks are global |
| `/health` exempt: **structural in the other three** | billing `/health` at `app.ts:50`, scopes at `:58`/`:119`; worker `/health` at `:48`, scope at `:56`; analytics `/health` at `:35`, scope at `:70` | confirmed — all three register `/health` on the root instance, before and outside the scope |
| **five** env schemas, all `internalApiSecretSchema` | `grep -rn "INTERNAL_API_SECRET:" apps/*/src/config/env.ts` | 5 lines: gateway `:29`, usage `:28`, worker `:57`, billing `:38`, analytics `:44` — every one `internalApiSecretSchema`, **no local chain anywhere** |

**What the edit removed.** `git diff .claude/rules/tenant-isolation.md` deletes exactly two
statements — "analytics-service still has no layer-2 guard at all" and "no `INTERNAL_API_SECRET`",
plus the three→four count changes. Both deleted statements are now false and were correctly
removed. **Nothing true and load-bearing was deleted.** The replacement adds a qualifier
(analytics' guard protects zero routes) which I independently measured in § 1.

### 4 · `.claude/rules/known-gaps.md`

- `git diff -U0` shows **one** hunk, `@@ -39,11 +39,68 @@` — the S-9 section only. No other
  entry's text moved.
- `## S-` heading count **48 before and 48 after**. `diff` of the heading lists shows exactly one
  changed line: S-9's title. No renumbering, S-8 absent both sides, id preserved.
- **`BU78` citation checked, not assumed** (S-33 is explicit that fabricated finding-id citations
  are a recorded failure mode): `apps/billing-service/tests/billing-invoices.route.test.ts:86` —
  *"BU78 - rejects a request with no X-Internal-Secret with 401 and never reaches the service"*,
  and `:93` is `expect(listInvoices).not.toHaveBeenCalled()`. It **is** the shape S-9 cites, and
  the discharge instruction is specific enough to follow. (The one thing the epic does not tell a
  T-051 implementer is where to register — LOW-4.)
- S-9's S-19 sub-claim verified: `grep -c "TimeZone" apps/analytics-service/src/repositories/base.repository.ts`
  → **0**, and `grep -rn "extends TenantScopedRepository" apps/analytics-service/src` returns
  exactly one line, `base.repository.ts:29`, which is the docstring example. Correct.
- S-9's env-identity claim verified by mutation — see § 5, M-F.

### 5 · Mutation testing — every claimed redness re-run

Each mutation applied to `src/`, package suite run, then restored from a scratchpad copy;
`md5sum -c` confirmed all five files byte-identical afterwards.

| # | Mutation | Claimed | Measured |
|---|---|---|---|
| M-A | `!secretsMatch(...)` → `internalApiSecret !== providedSecret` | AU15, 1 failure | **AU15 only**, `1 failed \| 13 passed (14)` ✓ |
| M-A3 | length-oracle pre-check keeping `secretsMatch` | (not claimed) | **56/56 green, typecheck clean** — MEDIUM-1 |
| M-B1 | swap the two `addHook` lines in `src/app.ts` | AU22b | **AU22b only**, `1 failed \| 55 passed (56)` ✓ |
| M-B2 | guard → `preHandler` in `src/app.ts` | AU22b | **AU22b only**, `1 failed \| 55 passed (56)` ✓ |
| M-C | `/health` moved inside the guarded scope | AU23 | **AU23 + AU23b + smoke**, `3 failed \| 53 passed (56)` ✓ (see NIT-1) |
| M-D | `.status(401)` literal | AU16, 1 failure | **AU16 only**, `1 failed \| 55 passed (56)` ✓ |
| M-E | `Array.isArray(raw) ? raw[0] : raw` | AU13, 1 failure | **AU13 only**, `1 failed \| 55 passed (56)` ✓ |
| M-F | local chain with the fragment's **exact** spelling | the identity case, nothing else | **`declares INTERNAL_API_SECRET as internalApiSecretSchema itself` only**, `1 failed \| 55 passed (56)` ✓ |
| M-G | delete `tests/setup.ts:17` | §10's 3-of-5 / 26-of-37 | **4 of 7 files, 40 of 56 cases** on the shipped tree — LOW-3 |
| M-H | guard rejects unconditionally | (control) | AU7, **AU13b**, AU15, AU22 red — **AU13b earns its place** |
| M-I | `tenantIdSchema.safeParse(header.toLowerCase())` | (control) | **AU17b only** red — **AU17b earns its place** |
| M-J | drop the `return` before `reply` | listed in S-9 | **56/56 green — nothing catches it** — LOW-1 |

### 6 · The deviation cases, judged

- **`AU22b`** (`internal-auth.middleware.unit.test.ts:343-355`) — **earns its place.** Its locator
  genuinely throws on a miss (`:348-352`, an explicit `throw new Error(...)` naming which of the
  two lookups failed and telling the reader not to delete the assertion), which
  `.claude/rules/testing.md` requires. It is red under **both** claimed mutations (M-B1, M-B2),
  one failure each. Its scope limits are stated in the case's own comment at `:338-342` — it does
  not check the two hooks are in the same scope and would not survive a helper-based rewrite —
  and those limits are accurate. It is a source-text assertion and says so.
- **`AU24`** (`env.schema.unit.test.ts:581-597`) — **earns its place.** The failing half asserts
  `rejects.toThrow(/INTERNAL_API_SECRET/)`, so a for-any-reason throw (a broken import, a
  different missing field) does **not** satisfy it. The control half asserts the loaded value
  equals `VALID_INTERNAL_API_SECRET` — a suite-owned 45-char string deliberately **different**
  from `tests/setup.ts`'s value, so it cannot pass by matching the ambient environment. Both
  halves are non-vacuous. It closes a real gap: the four `safeParse` cases do not touch
  `parseEnv` at all.
- **`AU13b`, `AU17b`** — both measurably earn their place (M-H, M-I). Neither is in the plan's §7
  table and neither is listed in §10's deviation count; net improvements, so no finding beyond
  noting the count.
- **`AU23b`** — worth keeping for the property it pins, but its justifying comment is wrong
  (NIT-1).
- `AU15` is a **source-text assertion and nothing more**, stated plainly here as the brief asks:
  it proves the file *spells* `secretsMatch` and does not spell one reverted operand order. It is
  **not** evidence of constant-time behaviour. The suite's disclaimer at `:120-125` says exactly
  that and is adequate; the disclaimer at `:60-64` is not (MEDIUM-1).

### 7 · Compile-time gate — `--force`, 13/13, actual output

```
pnpm lint --force       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   21.853s
pnpm typecheck --force  Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   16.526s
pnpm build --force      Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   21.719s
pnpm test --force       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
pnpm test:smoke         6 suites, 6 passed (gateway 2 tests, the other five 1 each)
```

`Cached: 0 cached` on all four — the gate was re-run, not reprinted.

Per-package test totals (13 packages; `@telemetry/web` is `vitest run --passWithNoTests` and
reports none, which is why twelve lines appear):

| Package | Files | Tests |
|---|---|---|
| analytics-service | 7 | **56** |
| auth-service | 15 | 166 |
| billing-service | 20 | 231 |
| gateway | 9 | 50 |
| usage-service | 19 | 238 |
| worker-service | 18 | 251 |
| shared-config | 1 | 4 |
| shared-logger | 1 | 4 |
| shared-tracing | 1 | 2 |
| shared-types | 1 | 8 |
| shared-utils | 1 | 26 |
| shared-validation | 1 | 30 |
| web | — | 0 (`--passWithNoTests`) |
| **Total** | | **1066** |

The reported 1040 → 1066 and 30 → 56 both reconcile: +26 in both, all in analytics.

**Lint: 0 errors, exactly 14 warnings, both sets pre-existing and proved:**

| Warnings | File | `git log -1` | In this diff? |
|---|---|---|---|
| 10 × `no-misused-promises` (`:61,86,117,144,179,204,231,262,297,323`) | `apps/auth-service/tests/auth.service.unit.test.ts` | `d68e719` 2026-08-25 (**not** `1b872b3` — LOW-5) | no |
| 4 × `no-unsafe-assignment` (`:339,340,543,544`) | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `b0f6921` 2026-08-31 | no |

`git status --porcelain` on both files is empty. **No analytics-service file appears in any lint,
typecheck or build output.** No new warning was introduced, and none of the 14 was waved through
as pre-existing without a commit behind it.

### 8 · D3's consequence — checked, it is true on this tree

`buildAnalyticsServiceApp` is declared at `src/app.ts:16` as `(): FastifyInstance & {...}` — **no
parameters**, so there is no `options.internalApiSecret` override and no fallback. Every one of the
**five** `buildInternalAuthMiddleware(...)` call sites passes `env.INTERNAL_API_SECRET`:
`src/app.ts:71`, and `tests/internal-auth.middleware.unit.test.ts:85,181,215,266`. `env` is
`parseEnv(EnvSchema, process.env)` at module load (`src/config/env.ts:30`), and
`INTERNAL_API_SECRET` is `internalApiSecretSchema` with no default, so a missing/short/blank/
non-ASCII secret throws before `app.ts` can be imported — verified end-to-end by AU24 rather than
inferred. Note billing's guard *does* accept an unvalidated override (its docblock says the smoke
suite uses it); analytics deliberately does not. That is a strict improvement and D3 is the right
call.

The four-artifact plumbing also checks out: `tests/setup.ts:17`, `.env.example:23`,
`docker/docker-compose.yml:135` and `.github/workflows/ci.yml:48`. `turbo.json` declares
`"env": ["INTERNAL_API_SECRET"]` on the **`dev`** task only, not on `test`, which is exactly why
`tests/setup.ts` — not CI's job-level variable — is what feeds `pnpm test`. The plan says this and
it is correct.

### 9 · Clean-code gate, per file

| File | Verdict |
|---|---|
| `src/middleware/internal-auth.middleware.ts` | Clean. Zero literals in executable lines — header name, status and code all from `ANALYTICS_HEADERS`/`ANALYTICS_RESPONSES` |
| `src/middleware/tenant-context.middleware.ts` | Clean. Only `""` in `header.trim() === ""`, byte-identical to billing's `:65` |
| `src/constants.ts` | Header names correctly **derived** from `@telemetry/shared-types` (`INTERNAL_AUTH_HEADERS`, `TENANT_CONTEXT_HEADERS`); `CODE_UNAUTHORIZED` derived from `INTERNAL_AUTH_RESPONSES`. **No fourth `x-tenant-id` literal was created** — census still three (`gateway/src/constants.ts:14`, `usage-service/src/constants.ts:16`, `shared-types/src/index.ts:104`), as S-39 records. Tenant-context vocabulary is MEDIUM-2 |
| `src/errors/index.ts` | Clean. Both error classes take all three arguments from constants |
| `src/types/index.ts` | Clean. `tenantId?: TenantId` — optional and branded, correctly justified |
| `tests/internal-auth.middleware.unit.test.ts` | Clean. Every status from `ANALYTICS_RESPONSES.*`; fixtures are named module constants. The only literal `401` is inside AU16's forbidden-string assertion, where it must be |
| `tests/tenant-context.middleware.unit.test.ts` | Clean. Same |
| `tests/env.schema.unit.test.ts` | Clean. Boundary from `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH`, never `32`; `PRINTABLE_ASCII_RANGE_END = 0x7e` named |

### 10 · Tenant isolation, injection, correctness, type safety

- **Tenant isolation.** No query is added. The tenant id comes from a gateway-injected header,
  is validated as a UUID by `tenantIdSchema` before binding, and is never normalised — `AU17b`
  pins that and is red under M-I. The guard is registered **ahead of** the tenant hook in the same
  scope and at the same phase, which is the ordering `tenant-isolation.md` § *Forbidden* requires;
  I verified the phase claim independently (`onRequest` beats `preHandler` regardless of
  registration order) and the code's conditional framing of it is correct. No repository consumes
  `request.tenantId` yet.
- **Injection.** No SQL, raw or otherwise, is added. Nothing reaches Prisma.
- **Correctness.** Duplicate-header handling checked in both directions: `app.inject` joins an
  array to `"<A>,<B>"` and Node joins repeated lines to `"<A>, <B>"`; both are strings, both fail
  `tenantIdSchema`, and `AU21` asserts **neither value appears in the response body** — the
  load-bearing negative, not just the `401`. `AU14` asserts byte-identical bodies for missing vs
  wrong secret, using full equality rather than `toMatchObject`, which is the right choice for
  "indistinguishable".
- **Type safety.** No new `any`. `as never` appears twice in AU13/AU13b to call the guard directly
  with a deliberately ill-typed request — appropriate and confined to the test. The one
  `as unknown as` in `src/app.ts:75` is the pre-existing container cast, unchanged.
- **Production readiness.** Error contract is consistent with billing/worker (`{code}` from the
  guard, `{code,message}` from the `AppError` subclasses through `registerGlobalErrorHandler`) —
  observed on the wire in § 2, not read off the source. `registerGlobalErrorHandler` is registered
  on the root at `:21`, before the scope, and reaches inside it.

### 11 · Database and Redis hygiene

Read before and after, through `DIRECT_DATABASE_URL` credentials (read-only queries; nothing
seeded, no role or migration touched):

```
before  Tenant 2 | User 2 | Event 0 | UsageLine 0 | Invoice 0 | InvoiceLineItem 0 | Meter 0 | RefreshToken 0
after   Tenant 2 | User 2 | Event 0 | UsageLine 0 | Invoice 0 | InvoiceLineItem 0 | Meter 0 | MetricRollup 0 | RefreshToken 0
```

Redis db 0: `DBSIZE` **1 → 3**. **Disclosed, and it is S-22, not this change.** At the start of the
review db 0 held only `telemetry:events` (`TTL -1`, stream) — the `denylist:` key the implementer
saw had already self-expired, which is itself the confirmation that S-22's keys expire. My
mandated `pnpm test --force` ran auth-service's integration suite, which writes `denylist:<jti>`
keys to db 0 (`apps/auth-service/tests/auth.integration.test.ts:34` hard-codes
`redis://localhost:6379`). Both new keys carry TTLs (831 s and 862 s at time of reading) and will
self-expire. `telemetry:events` is untouched (`XLEN 2`). I issued no write to db 0 myself and no
`FLUSHDB` anywhere.

---

## What I could **not** verify, and why

1. **That T-051's future route will be inside the guarded scope.** Nothing behavioural can, while
   the scope is empty — this is the change's own honest limit and it is stated in four places. The
   nearest guards are `AU22b` (text) and `AU23`/`AU23b` (the one falsifiable production property).
   S-9 is the durable record and it says so.
2. **Constant-time behaviour of `secretsMatch`.** Not measurable in a vitest process on a shared
   runner; it rests on `crypto.timingSafeEqual`'s contract. `AU15` is a source-text check only, and
   MEDIUM-1 is about a sentence that overstates what it reaches.
3. **The plan's §10 intermediate-tree figures (26 of 37)** could not be *reproduced*, because that
   tree was never committed and reproducing it would mean removing two untracked files. I
   reconstructed the arithmetic exactly (19+7+1+6+4 = 37; 19+1+6 = 26) and measured the shipped
   tree instead — LOW-3.
4. **The `.env.example` divergence's real-world effect.** Not driven end-to-end: doing so means
   starting a real gateway and a real analytics-service, and analytics has no route behind the
   guard to proxy to. LOW-2 rests on reading five files and comparing five strings, which I state
   as such.
5. **`relationJoins` / other-Node / built-`dist` behaviour of the inert scope.** Every probe ran
   under `tsx` on Node v22.22.2 with fastify 5.10.0. The claim is version-scoped in the source and
   in S-9, correctly.
6. **Whether a *sixth* evasion of `AU15` exists.** I found one (M-A3). The enumerated-pattern
   limitation is S-51's standing subject; I did not attempt an exhaustive search.

---

## Decisions for the user

Both are shaped as choices because both change the diff.

### Decision A — MEDIUM-2: what to do about the third copy of the tenant-context vocabulary

Four literals (`TENANT_CONTEXT_MISSING`, `TENANT_CONTEXT_INVALID` and their two messages) now
exist in three services' `constants.ts`, and `.claude/rules/constants.md` asks for promotion
before the third copy.

| Option | What changes | Cost |
|---|---|---|
| **A1 — promote now** | Add `TENANT_CONTEXT_RESPONSES` to `packages/shared-types/src/index.ts`; repoint analytics `:44-47`, billing `:83-86`, usage `:27-30` | ~4 files edited, 2 other services in the diff, full `--force` gate re-run. **Changes the diff.** |
| **A2 — record and defer** (recommended) | Leave the three copies; add a `known-gaps.md` entry naming the three sites and the promotion target, in this change | ~15 lines in one file. **Changes the diff, minimally.** |
| **A3 — do nothing** | Ship as is | No cost now; the rule is silently breached and the next service makes it four with nothing recorded. |

**Recommendation: A2.** It is the precedent S-39 set for exactly this situation — promote what the
current task owns (the headers and `CODE_UNAUTHORIZED`, which this change *did* do correctly),
record what belongs to other services. A1 puts usage-service's and billing-service's constants in
an analytics commit, which is the one-task-per-commit objection this repo has now recorded at S-8,
S-19, S-22, S-23, S-39 and S-40. A3 is the only option that leaves a required gate unsatisfied.

### Decision B — LOW-4: where the epic-9 T-051 `Files` omission is recorded

| Option | What changes |
|---|---|
| **B1 — edit S-9 now + edit the epic now** (recommended) | Two sentences: one in `known-gaps.md` S-9's discharge paragraph, one appended to the epic's T-051 **Files** line. **Changes the diff.** |
| **B2 — edit S-9 now, leave the epic to T-051's Gate 1** | One sentence in `known-gaps.md`. **Changes the diff.** |
| **B3 — new id, or fold into S-53** (the implementer's proposal) | A new entry, or an edit to S-53. |

**Recommendation: B1.** S-53 is the wrong home — I re-read it, it is scoped to the rollup SQL and
already covers both SQL-snippet defects the implementer flagged, so nothing new needs filing
there. A new id is also wrong: S-9 already carries the T-051 discharge instruction, and splitting
it means the T-051 implementer must find two entries. B2 is acceptable; B3 is not, and this is a
substantive disagreement with the hand-off rather than a preference.

---

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| The guard protects zero routes, so almost nothing about it is falsifiable in production | **Accepted, and correctly documented in five places.** D1=A was the user's call. `AU23`/`AU23b` are the only production-behavioural guards and both are red under the mutation they name |
| `AU15`/`AU16`/`AU22b` are source-text censuses over enumerated spellings | **Accepted, S-51's standing shape.** One evasion measured (MEDIUM-1); the docblock must stop claiming there are none |
| **S-54** (no maximum secret length) inherited, not fixed | **Deferral is right.** The ceiling belongs on the shared fragment, is a five-service change, and picking the number wrong turns a working deploy into a refusal to start. S-54 records it and S-9 names the inheritance. Nothing to do here |
| **S-19** (no `TimeZone` pin, zero subclasses in analytics) inherited, not fixed | **Deferral is right.** This change creates no repository; I verified 0 `TimeZone` occurrences and exactly one docstring-only `extends` hit. T-051 inherits it and S-9 says so |
| epic-9 T-051's `$queryRaw` snippet (snake_case + `AT TIME ZONE` on the column) | **Already S-53's, re-read and confirmed — no new filing needed.** The implementer's proposal to file it was redundant |
| Redis db 0 grew by two self-expiring `denylist:` keys during the mandated gate | **S-22, disclosed above.** Not this change; not actionable here |
| `src/middleware/**` outside coverage thresholds | **Pre-existing, uniform across five services, thresholds unenforced.** Inside S-25 § 1's scope |

---

## Verdict

# CHANGES REQUESTED

The security substance is sound. The wiring is correct, the ordering is correct, the phase
argument is correctly stated as a conditional rather than a universal, `/health` is structurally
exempt and provably so, the secret derives from the one shared fragment, no fourth `x-tenant-id`
literal was created, the full gate is genuinely green at 13/13 with `--force` and `0 cached`, and
the load-bearing universal — the inert scope — **survived sixteen further forms and six hook
phases that the implementer had not tried**, which is the strongest thing I can say about it.

Two required-gate items block QA, and neither needs a behavioural change:

- **MEDIUM-1** — a false universal in a docblock beside the guard, refuted by execution
  (`tests/internal-auth.middleware.unit.test.ts:63-64`).
- **MEDIUM-2** — the constants gate: a third copy of four literals, neither promoted nor recorded
  (`src/constants.ts:44-47`) — resolve via Decision A.

Plus LOW-1 through LOW-4, each a text correction in a file this change already edits, and each
naming a claim that is currently wrong in `.claude/rules/`, the plan, an `.env.example` comment,
or the epic. Under this repo's own standard a wrong claim in `.claude/rules/` is HIGH by default;
LOW-1 is graded LOW only because the three mappings it names are each exactly right and the defect
is the count, which I re-derived by three separate mutations.

Re-review after the fixes should be quick: none of them touches executable code except the
`.env.example` value, so a scoped `pnpm --filter @telemetry/analytics-service test` plus a re-read
of the six edited passages is sufficient.

---

## Round 2

**Gate 4 re-review, same tree.** Read-only. Round 1's text above is untouched — it is that
round's record, and correcting it in place would hide that the change once claimed something
false.

Nine mutations this round, each applied to one file, run, and restored from a scratchpad copy;
`md5sum -c` verified clean on all eight distinct files afterwards. `git status --porcelain` at
the end is identical to the start. Nothing committed, staged or branched; no
`git checkout --`/`restore`/`stash`.

Two user rulings observed: **S-58 stays recorded, not fixed** — I did not grade the unfixed
three-way split, only the entry's accuracy; and **the constants duplication was recorded, not
promoted** — I checked that billing's and usage's constants stayed untouched.

**`.claude/rules/known-gaps.md` read from disk**, md5 `543fbc3a3ab8f0d0937775b6997abbd9`,
4 079 lines, **50** `## S-` headings.

---

## Round 1 findings — all eight resolved, each re-verified by execution

| # | Status | Evidence |
|---|---|---|
| MEDIUM-1 | **Resolved** | Both operand orders re-derived; new text at measured strength (below) |
| MEDIUM-2 | **Resolved** per user ruling | Recorded as **S-57**; `git status --porcelain apps/billing-service apps/usage-service packages/` is **empty** — the two other services' constants were genuinely not touched |
| LOW-1 | **Resolved**, and its near-universal survived a directed attempt to refute it (below) | S-9 now reads "Four properties, three of them guarded", mapping first/second/fourth → `AU15`/`AU13`/`AU16` |
| LOW-2 | **Resolved** | Value now `dev-local-internal-secret-at-least-32-chars`, matching gateway. See MEDIUM-3 for the comment's count |
| LOW-3 | **Resolved** | Both trees labelled; shipped figures match my Round-1 measurement exactly, file lists included |
| LOW-4 | **Resolved** | Four-placement table re-derived against the real middleware (below) |
| LOW-5 | **Resolved** | Plan now cites `d68e719`, not `1b872b3` |
| NIT-1 | **Resolved** | Replacement mutation reddens `AU23b` alone (below) |
| NIT-2 | Correctly not actioned | Pre-existing, uniform, thresholds unenforced |

---

## New findings

### MEDIUM-3 · S-58's title carries two wrong counts, and one of them was created by this rework

`.claude/rules/known-gaps.md:4020` —

> ## S-58 · The **five** `.env.example` files carry **three** different `INTERNAL_API_SECRET`
> values …

Both numerals are wrong on the tree that ships.

**"five" → six.** The repository-root `.env.example` also declares the variable and is absent
from the entry's table:

```
$ grep -rn "^INTERNAL_API_SECRET=" .env.example apps/*/.env.example
.env.example:18:INTERNAL_API_SECRET=dev-local-internal-secret-at-least-32-chars   <- omitted
apps/analytics-service/.env.example:33:INTERNAL_API_SECRET=dev-local-internal-secret-at-least-32-chars
apps/billing-service/.env.example:35:INTERNAL_API_SECRET=dev-local-secret-change-in-production
apps/gateway/.env.example:18:INTERNAL_API_SECRET=dev-local-internal-secret-at-least-32-chars
apps/usage-service/.env.example:18:INTERNAL_API_SECRET=dev-local-internal-secret-at-least-32-chars
apps/worker-service/.env.example:58:INTERNAL_API_SECRET=dev-local-secret-change-in-production
```

The root file is untouched by this change (`git status --porcelain .env.example` empty;
`git log -1` → `1b872b3`, 2026-09-04). The omission **matters to the fix direction**: that
direction says *"pick one value for all five `.env.example` files"*, so someone executing it
literally leaves the root file — the one a developer is most likely to copy first — on the old
value.

**"three" → two.**

```
$ grep -rh "^INTERNAL_API_SECRET=" .env.example apps/*/.env.example | sed 's/^[^=]*=//' | sort | uniq -c
      4 dev-local-internal-secret-at-least-32-chars      (root, gateway, usage, analytics)
      2 dev-local-secret-change-in-production            (billing, worker)
```

Three spellings existed only on Round 1's tree, and **this rework removed the third** by moving
analytics onto gateway's value. The entry's own body says so — *"S-9 briefly made it a third
spelling before moving analytics onto gateway's"* — so the body knows the third is gone while the
title still asserts it. That is S-33's shape precisely: a count falsified by the commit that
records it.

**The same wrong count is in two further places**, one of them beside security-relevant
configuration:

- `apps/analytics-service/.env.example:30-31` — *"The .env.example files hold three spellings
  across five services"*. Wrong on both numerals. `.claude/rules/review-standards.md`: a false
  claim beside security-relevant code is at least MEDIUM.
- `docs/plans/s-009-analytics-internal-auth.md:567` — *"**S-58** for the pre-existing three-way
  split"*.

**Everything else in S-58 is correct and I re-derived it.** The lengths (43 / 37), the
line numbers, the "every one is a legal secret so every service starts", and the measured
consequence. That last one I drove through billing's *real* `buildInternalAuthMiddleware`, adding
a reverse control the entry does not have:

```
sender=gateway(.env.example)  guard holds billing/worker value -> 401 {"code":"UNAUTHORIZED"}
sender=gateway(.env.example)  guard holds gateway value        -> 200 {"ok":true}
sender=billing(.env.example)  guard holds billing/worker value -> 200 {"ok":true}   <- my control
```

The control is what makes the `401` a mismatch rather than a broken probe. The entry's scope note
(measured through `app.inject`, not two running processes behind a real proxy) is honest and is
the same limit my probe has.

**Compose is correct and uniform**, re-derived: `grep -c "INTERNAL_API_SECRET:"
docker/docker-compose.yml` → **5**, and `| awk '{print $NF}' | sort -u` → exactly one value,
`ci-internal-api-secret-with-at-least-32-chars`. The entry is right to say it must not be
"aligned" to the `.env.example` set.

**Fix (three one-line edits):**
1. `.claude/rules/known-gaps.md:4020` — retitle to "The **six** `.env.example` files carry
   **two** different `INTERNAL_API_SECRET` values …", add the root `.env.example:18` row to the
   table (value `dev-local-internal-secret-at-least-32-chars`, 43), and change the fix
   direction's "all five" to "all six".
2. `apps/analytics-service/.env.example:30-31` — "hold **two** spellings across **six** files".
3. `docs/plans/s-009-analytics-internal-auth.md:567` — "the pre-existing split" (drop
   "three-way").

**Disposition:** must fix before commit. Not a QA blocker — see § Verdict.

---

### MEDIUM-4 · S-57 states a universal its own evidence refutes, two paragraphs later

`.claude/rules/known-gaps.md`, S-57, *Failure mode* paragraph:

> … a one-character edit to **any one** of the three declarations would ship green through all 13
> packages.

Measured, one declaration at a time, each reverted and `md5sum -c` verified — the edit in every
case was `"TENANT_CONTEXT_MISSING"` → `"TENANT_CONTEXT_MISSINQ"`:

| Declaration edited | Result |
|---|---|
| `apps/analytics-service/src/constants.ts:44` | `Tests 56 passed (56)` — green ✓ |
| `apps/billing-service/src/constants.ts:83` | `Tests 231 passed (231)` — green ✓ |
| **`apps/usage-service/src/constants.ts:27`** | **`Tests 3 failed \| 13 passed (16)`** — three cases red in `apps/usage-service/tests/middleware.tenant-context.unit.test.ts` |

So the universal holds for two of three and is false for the third. **The refuting evidence is
already written in the same entry**, two paragraphs above: the *"fourth occurrence that is not a
fourth declaration"* paragraph documents the three bare literals at
`apps/usage-service/tests/middleware.tenant-context.unit.test.ts:53`, `:70`, `:86`. Those literals
are asserted against a response the middleware builds from the constant, so editing the constant
and not the literals is exactly what reddens them:

```ts
// apps/usage-service/tests/middleware.tenant-context.unit.test.ts:50-55
expect(response.statusCode).toBe(401);
const json = response.json();
expect(json).toMatchObject({
  code: "TENANT_CONTEXT_MISSING",     // <- bare literal vs the constant the middleware emits
```

The entry treats them purely as a constants-gate violation and does not notice they are also an
accidental partial guard. That is worth saying in the entry, because it changes the fix direction:
the proposed change ("replace the three bare literals in usage-service's tenant-context test with
the constant") would **remove** the one arm of drift protection that currently exists, unless the
promotion lands at the same time.

**Fix:** in `.claude/rules/known-gaps.md`, S-57's *Failure mode* paragraph, replace *"a
one-character edit to any one of the three declarations would ship green through all 13
packages"* with:

> a one-character edit to **analytics'** or **billing's** declaration ships green through all 13
> packages — measured, `56/56` and `231/231` — while the same edit to **usage-service's** reddens
> three cases in `apps/usage-service/tests/middleware.tenant-context.unit.test.ts`, because that
> file asserts the bare literal against a constant-built response. Two of the three declarations
> are unguarded; the third is guarded by accident, by the very literals this entry records as a
> constants-gate violation. Note the consequence for the fix direction below: replacing those
> literals with the constant removes that accidental guard, so it must land **with** the
> promotion, not before it.

**Disposition:** must fix before commit. Not a QA blocker.

---

## Convergence — this is the same class as Round 1, and I am not opening a third round on it

**Stated explicitly, as asked.** MEDIUM-3 and MEDIUM-4 are the **same class** as Round 1's
MEDIUM-1: a count or a universal in an authoritative file, stated more strongly than it was
measured. Three instances across two rounds, all in `.claude/rules/` or a comment citing it, none
of them affecting shipped behaviour.

**What would break the tie.** These are not three lapses of judgement — the author caught and
corrected MEDIUM-1 thoroughly, and wrote both new entries with the refuting evidence *in them*.
They are one missing mechanical check, and `.claude/rules/known-gaps.md` S-33 already names it:
a CI step that extracts backticked commands from `.claude/rules/` and source comments, re-runs
them, and compares the result against the adjacent numeral. Applied here it would have caught
**MEDIUM-1** (the docblock quotes its own mutation) and **both halves of MEDIUM-3** (S-58's table
carries its own `grep`), and it would have missed **MEDIUM-4** (a universal with no command).
That is 2.5 of 3.

**So the tie-break is: fix the three text spots, do not re-open this class at Gate 6, and record
the recurrence as evidence in S-33 rather than as a fourth finding.** Concretely, S-33's
*Fix direction* should gain a row: *"S-9 Gate 4, twice in two rounds: a `.env.example` spelling
count falsified by the same diff, and an `AU15` scope claim refuted by a one-line mutation. Both
command-backed; both reachable by the checker."* If a fourth instance of this class appears in a
later task without the checker having been built, that is the point to stop writing entries and
build it.

---

## Verification detail

### 1 · MEDIUM-1's replacement text — both operand orders re-derived, and the new sentence judged

Re-run on the shipped tree, each mutation reverted:

| Mutation | Measured |
|---|---|
| `internalApiSecret.length !== providedSecret.length \|\|` ahead of `secretsMatch` | **`Test Files 7 passed (7)`, `Tests 56 passed (56)`**, `typecheck exit=0`, lint 0 findings, **AU15 green** |
| `providedSecret.length !== internalApiSecret.length \|\|` (other order) | **`Tests 1 failed \| 55 passed (56)`**, failing on `→ expected '…' not to contain '!== internalApiSecret'` |

Both match the implementer's report exactly, including *which assertion* fires in the second
case — which is the whole point: the redness is a substring coincidence, not a guard.

**Judged as I judged the old sentence.** The replacement at
`apps/analytics-service/tests/internal-auth.middleware.unit.test.ts:64-80` is at measured
strength, names both mutations with their figures, labels the near-miss as "a source-text
coincidence, not a guard", and closes with "a green run of this file is not evidence that no
oracle was added". **It has not over-corrected into a different false claim** — I checked the
obvious way it could have, by testing whether AU15 is weaker than the new text implies. It is
not: the new text under-claims slightly, in the safe direction (NIT-3).

### NIT-3 · The new closing sentence under-describes AU15's second assertion

"they catch the two spellings they name" is accurate per case if read as *the positive string and
the negative string*. But AU15's positive assertion, `expect(source).toContain("secretsMatch(")`,
is a **call-presence** check rather than a spelling check: it fires on *any* edit that removes the
call, whatever replaces it. Measured — `internalApiSecret !== providedSecret` (reversed operands,
no forbidden substring) still reddens AU15, on that assertion:

```
× AU15 …  → expected 'import type { FastifyReply, FastifyRe…' to contain 'secretsMatch('
  Tests 1 failed | 13 passed (14)
```

So AU15 reaches slightly further than the docblock claims. This is an under-claim, which
`review-standards.md` prefers to an over-claim, so it is a NIT and not a finding. **Optional fix:**
append "— plus any edit that deletes the `secretsMatch(` call outright, whatever replaces it,
which the positive assertion catches."

### 2 · S-57's census — re-derived independently, and it is exactly right

Every particular checked by my own greps, not by re-running the implementer's:

- **Three `src/` declarations per literal**, at the stated line numbers — usage `:27-30`, billing
  `:83-86`, analytics `:44-47`. ✓
- **All byte-identical** — printed all twelve lines with leading whitespace stripped and compared;
  the three blocks are character-for-character the same. ✓
- **The test half**: `"TENANT_CONTEXT_MISSING"` returns **six** lines total (three declarations +
  `apps/usage-service/tests/middleware.tenant-context.unit.test.ts:53,:70,:86`), and — the claim
  worth checking — **the other three literals have no test occurrences at all**, which my per-literal
  greps confirm (three lines each, all `src/`). ✓
- **The error classes**: `grep -rln "class TenantContextMissingError" apps/*/src` → analytics,
  billing, usage. ✓
- **The "selective omission" evidence**, which is what the entry rests on: read
  `apps/analytics-service/src/constants.ts:21-33` directly — `ANALYTICS_HEADERS.INTERNAL_SECRET`
  from `INTERNAL_AUTH_HEADERS`, `.TENANT_ID` from `TENANT_CONTEXT_HEADERS` (`:23-24`), and
  `CODE_UNAUTHORIZED` from `INTERNAL_AUTH_RESPONSES` (`:33`). Two vocabularies derived, one
  re-typed, in one file. ✓
- **`apps/web` reads none of the four** — grep returns nothing. ✓
- **The promotion target is real**: `TENANT_CONTEXT_HEADERS` at
  `packages/shared-types/src/index.ts:103`. ✓

Only the *Failure mode* universal is wrong — MEDIUM-4.

**Ids and renumbering:**

```
$ diff <(git show HEAD:.claude/rules/known-gaps.md | grep "^## S-") <(grep "^## S-" .claude/rules/known-gaps.md)
3c3   S-9's title
48a49,50   S-57, S-58 appended
```

Nothing else moved. Four hunks, three inside S-9's section and one appending at `:3949`. S-57 and
S-58 were genuinely free — no artifact outside this change cites either id.

### 3 · S-58's measurement — reproduced, with a control the entry lacks

See MEDIUM-3 above for the transcript. The census, lengths, compose uniformity (5 lines, 1 value)
and the live/not-live split (billing and worker have routes; analytics does not until T-051) are
all correct.

**"Changing analytics' value breaks nothing that depended on the old one" — the part nobody had
checked.** Verified: `grep -rn "ci-internal-api-secret-with-at-least-32-chars"` across `*.ts`,
`*.yml`, `*.json` and `.env.example` returns only `docker/docker-compose.yml:93,112,135,164,190`
(its own self-consistent world), `.github/workflows/ci.yml:48` (job-level, and turbo's `test`
task does not declare the passthrough) and one **comment** in the new `.env.example` itself.
`apps/analytics-service/tests/setup.ts:17` is unchanged and carries its own
`test-internal-api-secret-change-in-production` (md5 verified identical to Round 1). No analytics
test references any `.env.example` secret value — `grep -rn "dev-local\|ci-internal"
apps/analytics-service/tests/` returns nothing. **Nothing depended on the old value.**

### 4 · LOW-1's declined test — I tried to refute the near-universal and could not

The implementer's claim is that dropping the `return` is byte-identical on four behavioural
observations. The refuting shape is that a hook which returns and one which does not differ *when
something runs after it*, so I composed exactly that: the real
`buildInternalAuthMiddleware` and `analyticsTenantContextHandler`, plus **a second `onRequest`
hook registered behind the guard**, a `preHandler`, an `onSend`, an `onResponse`, and **a route
that would otherwise match** — six observation points rather than four. One request with no
secret, both forms of the guard:

```
shipped (return reply)  status=401 body={"code":"UNAUTHORIZED"} len=23 log=[onSend,onResponse]
mutated (no return)     status=401 body={"code":"UNAUTHORIZED"} len=23 log=[onSend,onResponse]
```

Identical. The second `onRequest` hook, the tenant hook, the `preHandler` and the route handler
ran under **neither** form; `onSend` and `onResponse` ran under both. At fastify 5.10.0,
`reply.send()` inside an async `onRequest` hook short-circuits the lifecycle whether or not the
reply is returned. **The claim survives, now on six observations rather than four**, and declining
to add a case is the right call. *Limit:* I varied hook count, hook phase and route matching; I
did not vary the fastify version, and the guard is `async` so the callback-style hook shape was
not probed.

### 5 · LOW-4 — the epic's four-placement table re-derived against the real middleware

Composed the production scope from the real `buildInternalAuthMiddleware` and
`analyticsTenantContextHandler` with the real `registerGlobalErrorHandler`, and registered one
route in each of the four positions the epic names:

```
route inside the guarded scope       GET /v1/analytics/metrics -> 200  hooksRan=["auth","tenant"]
                                     no creds                 -> 401 {"code":"UNAUTHORIZED"}  hooksRan=[auth]
route in a sibling scope             GET /v1/analytics/metrics -> 200  hooksRan=[]
                                     no creds                 -> 200 {"ok":true}              hooksRan=[]
route on the root instance           GET /v1/analytics/metrics -> 200  hooksRan=[]
                                     no creds                 -> 200 {"ok":true}              hooksRan=[]
route in a sibling scope, prefixed   GET /v1/analytics/metrics -> 200  hooksRan=[]
                                     no creds                 -> 200 {"ok":true}              hooksRan=[]
```

**All four rows reproduce exactly**, including the fourth (prefixed sibling scope) that this
rework added. The "no creds" rows are mine and are stronger than the table: the three wrong
placements answer **`200 {"ok":true}` to a caller holding no credentials at all**, which is the
blockquote's "a `200` that works, with the guard silently skipped" measured rather than asserted.

**Placement of the warning** — the blockquote sits immediately under the **Files** line in
`docs/epics/epic-9-analytics-service.md` § *T-051*, before the Query params block, so a reader
who greps for the file path meets it at first contact. That is the S-32 fix-direction shape and
the S-45/epic-8 precedent. The cross-references resolve: `BU78` exists and is the cited shape
(re-verified in Round 1), and S-53 exists at `known-gaps.md:3442`.

### 6 · LOW-3 — figures and the in-place correction

`docs/plans/s-009-analytics-internal-auth.md:332` now reads *"every suite importing `src/app.ts`
or `src/config/env.ts` fails to collect — measured, not all 30; see §10"*, so §4.8 is correct
where a reader first meets it and points forward. §10 carries **both** trees, each labelled with
what produced it. The shipped-tree figures match my Round-1 measurement exactly, including the
file lists: four failing (`env.schema`, `internal-auth.middleware`, `smoke`, `config/container`)
and three surviving (`prisma.singleton` 4, `index.graceful-shutdown` 7,
`tenant-context.middleware` 5 = 16). ✓

### 7 · NIT-1 — the replacement mutation reddens `AU23b` alone

Applied the mutation the new comment names — `/health` returning an extra
`internal: <boolean>` field when `X-Internal-Secret` is present — to `src/app.ts`, then restored:

```
× AU23b - answers /health identically whether or not a valid secret is sent
  Test Files  1 failed | 6 passed (7)
       Tests  1 failed | 55 passed (56)
```

**`AU23b` alone**, exactly as claimed, and `AU23` stays green because `toMatchObject` on `status`
does not see an added field. The rewritten comment also states the old justification's
measured failure (three cases) rather than deleting it, which is the right way to correct a
claim.

### 8 · S-24 datapoint — confirmed, **and contradicted within this same session**

The implementer's counter-evidence checks out: Round 1's review records
`4b0b9a3c02844d2e22d301bf0848430a`, 3 907 lines, 48 headings, and states the injected copy
matched disk. Two agents independently saw agreement at that md5.

**But the opposite happened to me this round.** The `known-gaps.md` injected into *this* session
is the Round-1 revision — 48 headings ending at S-56, without S-57 or S-58 — while disk is
`543fbc3a3ab8f0d0937775b6997abbd9`, 4 079 lines, 50 headings. The very entries this round exists
to verify were absent from the injected copy. I read from disk, which is S-24's working practice
and is the only thing that caught it.

So the honest summary is that **both** outcomes were observed inside one task, hours apart, on
one machine: agreement in Round 1, staleness in Round 2. That is not counter-evidence that S-24
is closed — it is evidence that the condition is intermittent, which no sighting has previously
established. **Recommend adding this pair to S-24's bullet list** as one sighting with both
halves, and correcting its "twice"/"four times" count from the bullets at the same time, which
the entry already asks someone to do.

### 9 · Compile-time gate — `--force`, 13 packages, `Cached: 0`

```
pnpm lint --force       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   24.186s
pnpm typecheck --force  Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   20.298s
pnpm build --force      Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   23.770s
pnpm test --force       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
pnpm test:smoke         6 suites, 6 passed
```

Per-package tests: analytics **56/7**, auth 166/15, billing 231/20, gateway 50/9, usage 238/19,
worker 251/18, shared-config 4, shared-logger 4, shared-tracing 2, shared-types 8, shared-utils
26, shared-validation 30, web 0 (`--passWithNoTests`). **Total 1066**, unchanged from Round 1 —
correct, since the rework touched no executable path but the `.env.example` value, which no test
reads.

Lint: **0 errors, exactly 14 warnings**, the same two files and the same line numbers as Round 1
(auth `:61,86,117,144,179,204,231,262,297,323`; usage `:339,340,543,544`). Both files are absent
from `git status --porcelain`; provenance `d68e719` and `b0f6921`. **No analytics-service file
appears in any lint, typecheck or build output** — analytics' lint block is three lines of banner
and nothing else.

### 10 · Environment

Postgres before and after, read-only: `Tenant 2 | User 2` and **all** of Event, UsageLine,
Invoice, InvoiceLineItem, Meter, MetricRollup, RefreshToken at **0**. No seeding, no role change,
no migration touched.

Redis db 0: `DBSIZE` 2 → 2. The `denylist:` key present at the start had expired and one new one
was written by auth-service's suite during the mandated `pnpm test --force` (`TTL 826`,
self-expiring). `telemetry:events` untouched — `XLEN 2`, `TTL -1`, identical to Round 1. No write
issued by me to db 0; no `FLUSHDB` anywhere. All probe apps used db 12.

---

## What I could not verify this round, and why

1. **The intermediate tree's 26/37 figures** — still unreproducible, because that tree was never
   committed. §10 now says so itself, which is the correct disposition.
2. **S-58's consequence through two real processes behind a real gateway proxy.** I drove
   billing's real guard factory through `app.inject`, the same limit the entry declares. A real
   two-process run would additionally exercise the gateway's header re-injection.
3. **Whether a further evasion of `AU15` exists** beyond the length oracle. One found, not an
   exhaustive search; S-51's standing subject.
4. **The `return`-less guard under a non-async hook shape or a different fastify version.** The
   guard is `async` and the probe pinned 5.10.0.
5. **That T-051's route will land inside the scope.** Unfalsifiable while the scope is empty —
   the change's own honest limit, now documented in four places plus the epic.

---

## Verdict

# APPROVED FOR QA

**with two MEDIUM text corrections carried forward to Gate 6, which must land before the commit
gate.**

Every Round-1 finding is resolved, and each fix was re-verified by running the mutation it claims
rather than by reading the diff. The two things I most wanted to break both held: MEDIUM-1's
replacement text is at measured strength and has not over-corrected, and LOW-1's "no behavioural
difference" near-universal **survived** a directed refutation attempt across six observation
points. The epic's four-placement table and S-58's 401/200 both reproduced exactly, and S-57's
census is right in every particular I could re-derive. The gate is genuinely green — 13/13 on all
four tasks with `Cached: 0`, 1066 tests, 14 pre-existing warnings with commits behind them.

The two new MEDIUMs are **word-level accuracy defects in `.claude/rules/` entries about latent
LOW gaps**. Neither touches shipped behaviour, the test suite, tenant isolation, or anything QA
exercises. Sending this back to Gate 3 for a third round on the same class — a count stated more
strongly than measured — would be the non-converging loop rather than a proportionate response,
and the tie-break above says what to do instead. The single executable change in the rework (one
`.env.example` value) is verified safe: nothing on the tree depended on the old value.

**Must land before commit (Gate 6 re-checks):**
1. `.claude/rules/known-gaps.md:4020` — S-58's title and table: **six** files, **two** values; add
   the root `.env.example:18` row; "all six" in the fix direction.
2. `apps/analytics-service/.env.example:30-31` — "two spellings across six files".
3. `docs/plans/s-009-analytics-internal-auth.md:567` — drop "three-way".
4. `.claude/rules/known-gaps.md` S-57 *Failure mode* — replace the "any one of the three" universal
   with the measured two-of-three form, and add the consequence for its own fix direction.

**Recommended, out of scope to fix here:**
5. `.claude/rules/known-gaps.md` S-24 — add this task's paired sighting (agreement in Round 1,
   staleness in Round 2) and renumber the entry's count from its bullets.
6. `.claude/rules/known-gaps.md` S-33 — add this task as a two-instance row, as evidence for the
   mechanical checker its own fix direction proposes.
7. NIT-3 — optional one-clause addition to the `readSource` docblock.

---

## Round 3 — Gate 6, final review

Rounds 1 and 2 are untouched: `head -1185 <this file> | md5sum` =
`5df760bb6653f3dd15168966d9ff4a5b`, identical to the whole-file md5 taken before this section was
appended.

Five mutations, each applied to one file, run, and restored from a scratchpad copy; `md5sum -c`
clean on both distinct files. `git status --porcelain` is **20 entries** before and after.
Nothing committed, staged or branched; no `checkout --`/`restore`/`stash`.

`.claude/rules/known-gaps.md` read from disk — md5 `5b36b69e8066454c15bc96b1e83bf5bd`, 4 343
lines, **52** `## S-` headings, S-59 at `:4182`, S-60 at `:4267`. (My injected copy this session
was again the Round-1 revision, 48 headings ending at S-56 — a third data point for S-60's
neighbour S-24, and the reason everything below was `cat`-ed.)

---

## Findings

### LOW-6 · S-58's analytics citation is stale by +6, broken by the same rework that corrected the entry — **fifth instance of this task's recurring class**

`.claude/rules/known-gaps.md`, S-58's table, row 4.

The rework corrected S-58's two counts (MEDIUM-3, discharged — see below) and, in the same change,
added six comment lines above the declaration in
`apps/analytics-service/.env.example`. The table's citation was not re-derived:

```
FILE                                          CITED    ACTUAL
.env.example                                  18       18       OK
apps/gateway/.env.example                     18       18       OK
apps/usage-service/.env.example               18       18       OK
apps/analytics-service/.env.example           33       39       **STALE**
apps/billing-service/.env.example             35       35       OK
apps/worker-service/.env.example              58       58       OK
```

Five of six exact; the stale one is the only file this commit edits. This is S-33's third shape —
*"a `file:line` citation broken by the citing change's own edit"* — landing inside the entry that
was rewritten **for** this class and that now cites S-33 for it.

**Fix:** `.claude/rules/known-gaps.md`, S-58 table row 4 — `apps/analytics-service/.env.example:39`.
Better, and what S-33's own remedy prescribes: drop the line number from that one row and cite the
file, since it is the row most likely to move again.

### LOW-7 · S-59 attributes "four gates, four previously-unlisted spellings" to S-48; that accounting is S-51's

`.claude/rules/known-gaps.md`, S-59, final paragraph of *Two known evasions…*:

> S-48 records exactly that progression for billing — four gates, four previously-unlisted
> spellings.

Measured:

```
$ sed -n '/^## S-48/,/^## S-49/p' .claude/rules/known-gaps.md | grep -c "four gates"   ->  0
$ sed -n '/^## S-51/,/^## S-52/p' .claude/rules/known-gaps.md | grep -c "four gates"   ->  2
```

S-51 is where the four-gate accounting lives (*"the cheapest evasion found across four gates,
because unlike the delegate cast (Gate 4), `reinterpret<T>` (Gate 4 Round 2) and QA's
annotation-plus-`as never` (Gate 5, E2)…"*, and *"four gates have each found one the previous had
not"*). S-48's own prose enumerates **two** previously-unlisted spellings — the delegate-level cast
at Gate 4 and `reinterpret<T>` at Gate 4 Round 2 — not four.

The citation is not empty: S-48 does record a progression. But the *figure* attached to it belongs
to a different entry, and S-59 already cites S-51 correctly two paragraphs earlier for a different
sentence, so the fix is trivial. This is the **second half** of S-33's proposal — cross-document
citation of finding ids — and it is a cleaner example than any S-33 currently carries, because the
citing text and the correct target are both in the same file.

**Fix:** S-59 — *"**S-51** records exactly that progression for billing — four gates, four
previously-unlisted spellings; S-48 carries two of them."*

### LOW-8 · QA §3's AU16 aside is false as literally written — and its own hedge was load-bearing

`docs/qa/s-009-analytics-internal-auth.md` § 3, the AC3 row:

> `AU16`'s is too (`reply.status(ANALYTICS_RESPONSES…)` is required and `reply.status(401)`
> forbidden, but a `const U = 401` indirection would pass) — not separately probed.

Probed here, both forms, each reverted:

| Mutation | Result |
|---|---|
| `const U = 401;` … `.status(U)` — the naive form the sentence describes | **`Tests 1 failed \| 13 passed (14)`** — `AU16` red on `→ expected '…' to contain 'ANALYTICS_RESPONSES.HTTP_STATUS_UNAUT…'` |
| the same, plus a **decoy** reference to the constant (`const U: number = ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED === 0 ? 0 : 401;`) | **`Tests 56 passed (56)`** — green |

So the naive indirection is **caught**, by `AU16`'s *positive* assertion, which the sentence does
not account for. What passes is the decoy form — which is exactly S-59's trick applied to `AU16`
rather than to `AU15`, and is the more interesting claim. QA labelled the aside "not separately
probed"; that hedge is the only reason this is LOW rather than a false claim in a committed
artifact.

**Fix:** `docs/qa/s-009-analytics-internal-auth.md` § 3, AC3 row — replace the parenthetical with:
*"a bare `const U = 401` indirection is caught, by the positive assertion (`1 failed | 13 passed
(14)`); it passes only with a decoy reference to the constant (`56/56`) — S-59's shape applied to
`AU16`. Measured at Gate 6."* Consider giving `AU16` a one-line note pointing at S-59, since the
two cases now share one defeat.

### NIT-4 · S-60's "four of six services" is not derivable from its own table

The table has **five** service rows — four red, gateway immune. The sixth service, **auth-service,
is absent**, and it is immune for a reason unrelated to gateway's lazy parse:
`grep -c "INTERNAL_API_SECRET" apps/auth-service/src/config/env.ts` → **0**. It declares no such
field, so no ambient value can redden it. A reader counting the table gets "four of five".

**Fix:** add the row — `| auth-service | not applicable — declares no INTERNAL_API_SECRET (grep → 0) |`
— so the headline's denominator is visible.

### NIT-5 · The byte-prefix short-circuit claim is inherited reasoning, not measurement, and is not labelled

S-59: *"this one restores the full **byte-prefix short-circuit** that S-8 existed to remove …
response latency reveals how many leading bytes a guess got right, so the secret is recoverable one
byte at a time rather than guessed whole."*

Stated flatly. It is the platform's standing position —
`.claude/rules/tenant-isolation.md` and the middleware docblock say the same — and nothing on this
tree has ever measured a timing differential through V8's string comparison over a socket. The
direction of the error is safe (it treats the code as more exploitable than proven), which is why
this is a NIT and not a finding. But S-59 is otherwise scrupulous about labelling measurement, and
this is the one sentence in it that is not.

**Fix:** one clause — *"(the short-circuit is the standing platform premise from S-8, reasoned
rather than measured on this tree; no timing differential has been observed here)"*.

---

## Convergence — this is the escalation point, and I am not opening a fourth round

**LOW-6 and LOW-7 are the same class** as Round 1's MEDIUM-1 and Round 2's MEDIUM-3/MEDIUM-4: a
count or citation stated more strongly than it was measured, falsified by the commit that writes
it. They are instances **five and six** across three rounds of one task.

At Round 2 I said a fourth instance is the signal to build S-33's checker rather than file another
entry. S-33's new block now says the same in the repository's own voice — *"Four tasks have now
filed instances and the checker is still unbuilt … should not wait for a fifth instance."* The
fifth and sixth arrived **in the round that wrote that sentence**. That is not a criticism of the
author; it is the strongest available evidence that this class is not fixable by care.

**One sharpening this round adds, which S-33's block does not have.** Its table concludes the
checker *"reaches the counts and misses the universals"*. LOW-6 and LOW-7 are **neither**: one is a
`file:line`, one is a finding-id cross-reference. Both are reached by the *second* half of S-33's
proposal — the citation checker its scope note names as "the harder and more valuable target" —
and neither is reached by the `grep`-and-compare half. So the recurrence is now evidence for the
half of the checker that has never been prioritised, and S-33's block should say so rather than
leaving the reader with "counts yes, universals no".

**The decision goes to the user, in one sentence:** should S-33's checker be built before this
commits, or should this commit and own the residue?

| Option | What changes | Cost |
|---|---|---|
| **A — commit now, fix the four text spots, file the sharpening in S-33** *(recommended)* | Four one-line edits + one paragraph in S-33. The commit proceeds. | Minutes. **Changes the diff**, trivially. |
| **B — build S-33's citation checker first** | A new task: extract `file:line` and `S-nn`/`T-0nn`/case-id citations from `.claude/rules/`, `docs/` and source comments, verify each resolves and says what the citing text claims, run it in CI. This change then commits behind it. | Its own plan, review and QA cycle. **Does not change this diff.** |
| **C — commit now and open the checker task immediately after** | As A, plus the epic gains a task. | Minutes now, a task later. **Does not change this diff** beyond A. |

**Recommendation: A, or C if the checker is to be scheduled rather than remembered.** Six
instances in one task is a strong argument for the checker, but none of the six caused a wrong
behavioural conclusion, and holding a verified, fully-gated security change behind a new tooling
task inverts the priority order. What would change my recommendation to B: any instance of this
class that led to a **wrong verdict** rather than a corrected sentence. None has, in six.

---

## Verification detail

### 1 · S-59 — reproduced exactly, and its second claim is stated in the right direction

Mutation applied to the shipped middleware and reverted (`md5sum -c` OK):

```
typecheck  -> exit 0
lint       -> exit 0, 0 findings
vitest run -> Test Files 7 passed (7) / Tests 56 passed (56)

AU15's three assertions against the mutated source:
  contains `secretsMatch } from "@telemetry/shared-utils"`  -> true
  contains `secretsMatch(`                                  -> true
  contains `!== internalApiSecret`   (assertion requires false) -> false
```

All three hold while the live decision is `!(providedSecret === internalApiSecret)`. **S-59's
headline is exactly right**, and the `shapeOk` device is legitimate: `secretsMatch("", "")` is
`true`, so `!shapeOk` is `false` for any string input and behaviour is preserved — which is why
`AU7`–`AU14` stay green.

**Judged under the *Universals* gate, as hard as MEDIUM-1 was.** S-59's second claim — *"Two known
evasions is evidence the set is larger than enumerated, not that it is now complete"* — is an
**anti**-universal. It asserts incompleteness rather than completeness, which is the direction that
cannot be refuted by finding one more spelling, and it explicitly forbids the tempting fix
(adding `=== internalApiSecret` to the list). That is the correct strength. Its *"S-51's title is
scoped to billing-service's censuses, so extending it would make that title false"* reasoning
checks out — `grep -n "^## S-51"` confirms the title is scoped to `BU126`. Only the S-48
attribution is wrong (LOW-7).

### 2 · S-60 — five of seven rows re-derived, both controls, and every structural claim

**Controls first, because they bound the entry** (my shell had `INTERNAL_API_SECRET` genuinely
unset — verified):

```
pnpm --filter @telemetry/analytics-service exec vitest run   -> Test Files 7 passed (7)  / Tests 56 passed (56)
pnpm --filter @telemetry/gateway           exec vitest run   -> Test Files 9 passed (9)  / Tests 50 passed (50)
```

So vitest does **not** load the repo-root `.env` into `process.env`; the value must be exported
into the invoking shell to bite. The entry's control reproduces.

**The table, ambient `INTERNAL_API_SECRET=short`:**

| Command | S-60 claims | I measured |
|---|---|---|
| `exec vitest` analytics | `4 failed \| 3 passed (7)` | **`4 failed \| 3 passed (7)`** ✓ |
| `exec vitest` gateway | `9 passed (9)` — immune | **`9 passed (9)`** ✓ |
| `exec vitest` worker | `4 failed \| 14 passed (18)` | **`4 failed \| 14 passed (18)`** ✓ |
| `exec vitest` usage | `6 failed \| 13 passed (19)` | **`6 failed \| 13 passed (19)`** ✓ |
| turbo `test --force` analytics | `56 passed (56)` — stripped | **`Tests 56 passed (56)`** ✓ |
| turbo `test --force` billing | `231 passed (231)` | not re-run — same mechanism as the row above |

**Structural claims, all verified directly:**

- Root `.env` exists with `INTERNAL_API_SECRET=dev-local-secret` — **16 characters**, below the 32
  minimum — and `git check-ignore -v .env` → `.gitignore:6`. Untracked, one developer's, not
  shipped. ✓
- `turbo.json` per task: `build []`, **`dev ["INTERNAL_API_SECRET"]`**, `lint []`, `typecheck []`,
  `test []`. ✓
- Gateway's immunity is structural: `apps/gateway/src/config/env.ts:41-42` is
  `export const loadEnv = () => parseEnv(EnvSchema, process.env)` — lazy — against
  `export const env = parseEnv(EnvSchema, process.env)` at module load in billing `:43`, auth `:39`,
  analytics `:49`, worker `:127`, usage `:41`. ✓

S-60 is accurate and honestly bounded — it separates "the mechanism is platform-wide" from "the
`.env` file does not by itself reach a vitest process here", which is exactly the distinction that
makes it usable. Only the denominator is loose (NIT-4).

### 3 · S-58 — re-derived by **discovery**, not by list

Held to the entry's own fix direction, which says a hard-coded list is how the root file came to be
omitted. `find . -name ".env.example" -not -path "*/node_modules/*"` → eight files; eight probed:

```
./.env.example                        dev-local-internal-secret-at-least-32-chars   len=43
./apps/analytics-service/.env.example dev-local-internal-secret-at-least-32-chars   len=43
./apps/gateway/.env.example           dev-local-internal-secret-at-least-32-chars   len=43
./apps/usage-service/.env.example     dev-local-internal-secret-at-least-32-chars   len=43
./apps/billing-service/.env.example   dev-local-secret-change-in-production         len=37
./apps/worker-service/.env.example    dev-local-secret-change-in-production         len=37
./apps/auth-service/.env.example      (no INTERNAL_API_SECRET)
./apps/web/.env.example               (no INTERNAL_API_SECRET)

distinct:  4 × dev-local-internal-secret-at-least-32-chars
           2 × dev-local-secret-change-in-production
```

**Six files, two values, four against two.** The correction is right, discovery finds no seventh
file, and the two excluded files are correctly excluded. MEDIUM-3 **discharged** — bar the stale
line number (LOW-6).

Compose re-checked: five blocks, one value. Unchanged.

### 4 · S-57 — mutation re-run, and the ordering warning matches what I measured

`CODE_TENANT_CONTEXT_MISSING: "TENANT_CONTEXT_MISSING"` → `"TENANT_CONTEXT_MISSINX"`, usage-service,
**whole package** (Round 2 measured only the scoped run):

```
× usageTenantContextMiddleware > rejects request with missing X-Tenant-Id header with 401 TENANT_CONTEXT_MISSING
× usageTenantContextMiddleware > rejects request with empty X-Tenant-Id header
× usageTenantContextMiddleware > rejects request with whitespace-only X-Tenant-Id header
 Test Files  1 failed | 18 passed (19)
      Tests  3 failed | 235 passed (238)
```

Exactly the entry's figure, and exactly its three named cases. The analytics (`56/56`) and billing
(`231/231`) arms were measured at Round 2 on files that are byte-identical since (`cmp` confirms),
so the two-of-three split stands. **MEDIUM-4 discharged.**

The added **ordering warning** — promote first, replace usage's literals second, because replacing
them alone takes the platform from one-service-guarded to zero-service-guarded with the gate green
— describes precisely what the table measures, and goes further than my Round-2 note by naming the
"tidy-up makes it worse" trap explicitly. Good.

### 5 · QA's G5/G6 — re-derived through the real gateway, and I can report what the upstream saw

QA asserted these against two real processes; I could not reproduce that setup cheaply, so I drove
the **real `buildGatewayApp()`** with a real HS256-signed JWT (`jose`, gateway's own `JWT_SECRET`)
against a **real `node:http` echo upstream on a real socket** that reports the headers it received
— which is stronger evidence than a status code:

```
G2 no JWT                                  -> 401  {"code":"TOKEN_MISSING"}
G3 valid JWT                               -> 200  upstreamSaw tenant=d4101ff1-…aaaa  secret=test-internal-api-secret-change-in-production
G4 spoof secret+tenant, NO JWT             -> 401  {"code":"TOKEN_MISSING"}
G5 valid JWT + WRONG spoofed secret        -> 200  upstreamSaw secret=test-internal-api-secret-change-in-production   (NOT the spoofed value)
G6 valid JWT + DIFFERENT spoofed tenant    -> 200  upstreamSaw tenant=d4101ff1-…aaaa   (the JWT's, NOT ffffffff-…bbbb)
```

**QA's G2–G6 confirmed.** Layer 1 of `.claude/rules/tenant-isolation.md` holds for the analytics
prefix: a client's `x-internal-secret` and `x-tenant-id` are stripped and re-injected from verified
JWT state. The mechanism is `stripSpoofableIdentityHeaders`
(`apps/gateway/src/middleware/guards.middleware.ts:52-56`, over `GATEWAY_SPOOFABLE_HEADERS`, which
includes `INTERNAL_SECRET` — `src/constants.ts:21-26`) plus `rewriteRequestHeaders`
(`src/plugins/proxy.plugin.ts:34-50`, which sets the secret from config and tenant/user/role from
`request.authContext`). Both halves also carry **standing tests** —
`apps/gateway/tests/guards.middleware.unit.test.ts:156` ("strips spoofable identity headers",
including the internal secret) and `apps/gateway/tests/proxy.plugin.unit.test.ts:94,140`.

*Limit:* one process pair (gateway + echo upstream) rather than gateway + a real analytics-service,
and `app.inject` for the client leg. The strip-and-reinject path exercised is the production one.

### 6 · The rework is comment-only, proved mechanically

Two `apps/` files changed since Round 2. Rather than reading the diff, I stripped comments and
blank lines from both and compared:

```
diff <(strip r2/internal-auth.middleware.unit.test.ts) <(strip <current>)   -> IDENTICAL executable lines
diff <(grep -v '^#' r2/.env.example)  <(grep -v '^#' <current>)             -> IDENTICAL non-comment lines
```

`INTERNAL_API_SECRET=dev-local-internal-secret-at-least-32-chars` is byte-unchanged (it moved from
line 33 to 39 as comments grew — which is LOW-6's cause). The other six analytics files, and
usage's and billing's `constants.ts`, are `cmp`-identical to my Round-2 snapshots.

**QA's O-1 verified:** `git show HEAD:apps/analytics-service/.env.example | grep -c INTERNAL_API_SECRET`
→ **0**. The line is a net addition, not a value change.

### 7 · Final-review checklist

**Test-coverage alignment.** Every new production symbol has a consumer and a test:
`buildInternalAuthMiddleware` (AU7–AU16), `analyticsTenantContextHandler` (AU17–AU21),
`TenantContextMissingError` / `TenantContextInvalidError` (AU18/AU19, AU20/AU21 — both reached
through the hook rather than constructed directly, which is the right level), `ANALYTICS_HEADERS`
(both fields exercised), the four new `ANALYTICS_RESPONSES` codes/messages (AU18–AU21),
`FastifyRequest.tenantId` (AU17/AU17b assert the bound value on the wire). **All error paths are
tested**; there is no error branch in either middleware without a case.

**No orphaned code.** `src/middleware/index.ts`'s two re-exports are consumed by nothing —
`app.ts` imports from the files directly — but billing's and worker's middleware barrels are
equally unconsumed, so this matches the repo's convention rather than introducing an orphan; only
usage's barrel has a consumer. `ANALYTICS_RESPONSES.HTTP_STATUS_OK` has no production consumer and
is used by tests only, which `.claude/rules/constants.md` requires of tests. Neither is a finding.

**AC1–AC6 satisfied.** I checked QA's AC table against the plan's §7 mapping and against the code;
it is accurate and, unusually, it labels **which** criteria rest on source-text assertions rather
than behaviour (AC3's `AU15`/`AU16`, AC5's `AU22b`) instead of presenting all six as equally
proven. That is the right way to report it. AC3's caveat is now two findings deep (S-59, and
LOW-8's correction to QA's own aside) and is still satisfied: the shipped comparison *is*
`secretsMatch` on the real operands, verified by reading it.

**Regression across the other 12 packages: none, and it is structural rather than argued.**
`git status --porcelain` shows **zero** changes under `packages/` and **zero** in any app other
than analytics. The only cross-service artifacts are two `.claude/rules/` files, the epic,
`docker/docker-compose.yml` (one added key in the analytics block) and the docs. The full gate
confirms it: 1066 tests, the other 12 packages byte-identical in count to Round 1 and Round 2.

**Breaking-change assessment: none.** No exported signature changed. The one contract change is
that analytics-service now **requires** `INTERNAL_API_SECRET` at startup — which is the intended
behaviour, is carried in all four artifacts (`tests/setup.ts`, `.env.example`, compose, CI), and
is a deployment note rather than a code break. `buildAnalyticsServiceApp()` still takes no
arguments.

**Compile-time gate, `--force`, 13 packages, `Cached: 0` on all four:**

```
lint       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
typecheck  Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   20.33s
build      Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   23.86s
test       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
smoke      6 of 6 suites passed
```

1066 tests, 0 failures. Analytics **56/56, 7 files**. Lint **0 errors, exactly 14 warnings** —
10 in `apps/auth-service/tests/auth.service.unit.test.ts` (`d68e719`) and 4 in
`apps/usage-service/tests/ingestion.service.unit.test.ts` (`b0f6921`), both files absent from
`git status`. Analytics' lint block is banner-only.

### 8 · Commit readiness

**The set is one coherent atomic commit.** 20 entries: analytics-service's source, tests,
`.env.example`; `docker/docker-compose.yml`; `.claude/rules/tenant-isolation.md`;
`.claude/rules/known-gaps.md` (seven entries — S-9 narrowed, S-24, S-33, S-57, S-58, S-59, S-60);
`docs/epics/epic-9-analytics-service.md`; and the plan, this review and the QA report, which
`.claude/rules/git-commit.md` requires in the same commit.

**On whether anything belongs elsewhere.** S-24, S-33, S-59 and S-60 are about subjects other than
analytics — agent snapshots, measured-claim hygiene, an `AU15` evasion, the scoping command. Each
is a *finding of this task*, and this repository's settled convention (S-39, S-57) is that such
findings are recorded in the commit that discovered them rather than deferred. **They belong here.**
S-58 is pre-existing but was discovered here; same answer. Nothing in the set should be split out.

**Nothing forbidden is present**: no `.env`, no `dist/`, no `coverage/`, no secrets beyond the
documented local placeholders. `git diff --cached --name-only` is empty — nothing is staged, so the
commit author must stage deliberately.

**One note for the commit message**, since `git-commit.md` prescribes its shape: the *Tests* line
should read `26 added. analytics-service 56/56 passing; build/test/lint/typecheck 13/13 packages`,
and the gate line should say **Senior Reviewer final gate: CONDITIONAL** with the four fixes
applied, not `APPROVED` — the record should show three rounds.

---

## What I verified

The `===` evasion (S-59) at full strength including all three `AU15` assertions; S-60's two
controls, five of its seven rows, and every structural claim behind it (root `.env` length and
gitignore status, `turbo.json` per-task env, gateway's lazy parse against five module-load
parses); S-58 by independent discovery over all eight `.env.example` files; S-57's mutation on the
whole usage package with its three named cases; QA's G2–G6 through the real gateway with a real
signed JWT and a real upstream socket, reporting what the upstream received; the comment-only
nature of the `apps/` diff, proved by stripping comments and diffing; QA's O-1 against `HEAD`;
QA's unprobed `AU16` aside, in both forms; the full gate at 13/13 with `Cached: 0`; coverage
alignment, orphan check, regression surface and commit hygiene.

## What I could not verify, and why

1. **QA's G5/G6 as two real processes behind a real proxy.** I used the real gateway app plus a
   real echo upstream on a real socket, with `app.inject` for the client leg. The strip-and-reinject
   path is production's; the client transport and the upstream are not analytics-service.
2. **The turbo/billing row of S-60's table** — same mechanism as the turbo/analytics row I did run.
3. **A timing differential for `===` versus `secretsMatch`** (NIT-5). Never measured on this
   platform; it is S-8's standing premise.
4. **That `AU15`/`AU16` have no *seventh* evasion.** Two are on record for `AU15` and one for
   `AU16`; S-59 correctly declines to claim the set is closed.
5. **That T-051 registers its route inside the guarded scope.** Structurally unfalsifiable while
   the scope is empty. Recorded in S-9, `tenant-isolation.md`, the plan, `src/app.ts` and the epic.
6. **S-60's reach on other machines** — whether some other tool loads the root `.env`. The entry
   says so itself.

---

## Verdict

# CONDITIONAL

The change is sound and I would not hold it for anything I found. Everything load-bearing has now
been re-derived across three rounds by three different routes: the inert scope over nineteen forms
and six hook phases, the seam table byte-for-byte, the four route placements against the real
middleware, the isolation chain through the real gateway with a real JWT, and the full gate at
13/13 with `Cached: 0` and 1066 tests. AC1–AC6 are satisfied, every error path is tested, there is
no orphaned code, the regression surface is empty by construction, and the commit set is coherent
and hygienic. Round 2's two MEDIUMs are **discharged**, verified by re-running their mutations
rather than by reading the corrections.

`CONDITIONAL` rather than `APPROVED FOR COMMIT` for four one-line text corrections, none of which
touches executable code:

1. `.claude/rules/known-gaps.md` — S-58 table row 4: `apps/analytics-service/.env.example:39`, or
   drop the line number (**LOW-6**).
2. `.claude/rules/known-gaps.md` — S-59: attribute the four-gate progression to **S-51**, not S-48
   (**LOW-7**).
3. `docs/qa/s-009-analytics-internal-auth.md` § 3, AC3 row: the naive `const U = 401` indirection
   is **caught**; only the decoy form passes (**LOW-8**).
4. `.claude/rules/known-gaps.md` — S-60: add the auth-service row so "four of six" is derivable
   (**NIT-4**); S-59: label the byte-prefix claim as reasoning (**NIT-5**).

Plus one paragraph in S-33 recording that this round's two instances are **citations**, which its
own table does not yet claim the checker reaches — and which are reached by the citation half it
has never prioritised.

**Re-review after these is a re-read, not a re-run:** none of the four changes executable code, so
`pnpm --filter @telemetry/analytics-service test` plus reading the four passages is sufficient. The
user decision on S-33's checker (options A/B/C above) is independent of them and does not block the
commit under my recommendation.
