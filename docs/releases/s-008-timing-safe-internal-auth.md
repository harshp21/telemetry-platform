# Release note — S-8: timing-safe internal-auth guards, and one declaration of `INTERNAL_API_SECRET`

**This is a failure-mode note, not a deploy runbook**, following the precedent `s-045` sets and
argues for. S-8 ships **no migration, no schema change and no role change**, so there is nothing
to order and nothing to back out of the database.

It is on a slightly stronger footing than `s-045`, which shipped no configuration change at all.
This change **validates an operator-controlled configuration value more strictly and will refuse
to start a service whose secret fails the new rule.** That is the intent. It is also the only
thing here that can wake anyone up, so it is the first section.

---

## 1 · Before you deploy — check the secret (**required step**)

Every service that holds an `INTERNAL_API_SECRET` now parses it through one shared rule:

> **trimmed of surrounding whitespace, then at least 32 characters, then printable ASCII only
> (U+0020–U+007E).**

Internal spaces are legal — the character class includes U+0020 and is applied *after* the trim,
so a passphrase-style secret keeps working. What is now rejected is a secret that is blank once
trimmed, one that reaches 32 characters only by its padding, and one containing any non-printable
or non-ASCII character.

**An internal TAB is now rejected, and it is the one newly-refused class you might have typed on
purpose.** A secret with a space in it keeps working; a secret with a **tab** in it does not.
`\x09` is below `\x20`, so it falls outside the character class. Unlike the invisible-character
class in §4, this is not garbage that arrived by a bad copy-paste: an operator building a
passphrase-style secret in a config file or a secrets manager may have used a tab as the separator,
and that value **worked on all four services before this change**. Measured at the Gate-5 rework
against a real guard over a real `node:http` socket: a 33-character ASCII secret whose sixteenth
byte is `0x09` arrives byte-identical, authenticates `200`, and was accepted by both pre-change
declarations — the `.min(32)` gateway and usage-service had, and the `.trim().min(32)` worker-service
and billing-service had, since `trim()` strips edges only. It is excluded deliberately: a tab inside
a secret is invisible in every config UI and in every `echo`, which is precisely the property that
produced the silent four-way disagreement in §4. The check in this section catches it and names it
as `U+0009`. If you hit it, replace the tab with a space or re-issue per §3 — do not try to
round-trip the tab.

Run this against the value you have deployed, not against the file you think it came from:

```bash
# Prints OK or the reason it will be refused. Reads the variable from the current environment.
node -e '
  const s = process.env.INTERNAL_API_SECRET;
  if (s === undefined) { console.log("FAIL: not set"); process.exit(1); }
  const t = s.trim();
  if (t !== s) console.log("NOTE: has surrounding whitespace, which will be stripped");
  if (t.length < 32) { console.log(`FAIL: ${t.length} characters after trimming, minimum is 32`); process.exit(1); }
  if (!/^[\x20-\x7E]+$/.test(t)) {
    const bad = [...t].filter((c) => !/[\x20-\x7E]/.test(c));
    console.log(`FAIL: contains non-printable or non-ASCII: ${[...new Set(bad)].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ")}`);
    process.exit(1);
  }
  console.log(`OK: ${t.length} characters`);
'
```

**Run it before you deploy anything, and treat both outcomes as blocking.**

- **Any `FAIL:` line — fix the secret first.** The service refuses to start; §2 has the exact
  message per class.
- **A `NOTE: has surrounding whitespace` line — strip the padding and re-issue first, even though
  the value is accepted.** This is the one case where the check prints `OK` and you must still
  act before deploying. A padded secret *is* valid under the new rule, because the trim runs
  before the length check — so the rule does not protect you here, and it is precisely the class
  for which old and new services disagree about what to transmit. §5 has the measured matrix.

Doing this first is what makes the deploy order a non-issue: measured over six sample values, the
three pre-change declarations (`z.string().min(32)` in gateway and usage-service,
`z.string().trim().min(32)` in worker-service and billing-service) and the new shared rule parse
to **byte-identical** strings for all five that are unpadded, so old and new code transmit and
compare the same bytes. The sixth — a string of all 95 printable ASCII code points, which begins
with U+0020 — differs, and this check flags it with the same `NOTE`. That is the reach as
measured, not a claim about every possible value.

**The script's exit status is deliberately unchanged**: a padded-but-valid secret prints the
`NOTE` and still exits `0`. Making it exit non-zero was considered and declined — a pipeline
already scripted against exit `0` would begin failing on a value the new rule accepts on purpose.
The blocking step is the operator acting on the `NOTE`, not the exit code.

Every `INTERNAL_API_SECRET` configured anywhere in this repository passes unchanged — the five
`.env.example` files, the four `docker/docker-compose.yml` service blocks, `.github/workflows/ci.yml`,
the three `tests/setup.ts` defaults and the test constants. Nothing in the repository had to be
re-issued. That says nothing about your production value, which is why the check above exists.

## 2 · The exact startup error, per failure class

The failing service exits at **module load**, before it binds a port, so it never appears healthy.
The message names the variable and the constraint:

```
Invalid environment configuration for INTERNAL_API_SECRET: String must contain at least 32 character(s)
```

— too short, **or blank once trimmed, or reaching 32 only by padding**. All three produce this
message, because the length rule is checked after the trim and before the character rule.

```
Invalid environment configuration for INTERNAL_API_SECRET: must contain only printable ASCII characters (U+0020-U+007E)
```

— long enough, but carrying a character outside printable ASCII. This is the genuinely new
rejection class; the first message could already be produced before this change by
worker-service and billing-service.

**Which service reports it first.** gateway, usage-service, worker-service and billing-service all
hold this variable. Three of them — **usage-service, worker-service and billing-service** — parse
it at module load, so they fail immediately on start. **gateway parses lazily**, inside `loadEnv()`,
so it fails when it first loads its configuration rather than at import time. In a rolling deploy
the first service you restart is the first to report; there is no designated canary. Only one
message is printed even if a value fails two rules, because the env parser reports the first issue.

## 3 · The remedy

Re-issue an ASCII secret and roll it to **all four** services. This is a **coordinated secret
rotation, not a per-service edit** — gateway sends the header and the other three check it, so a
window in which they disagree is a window in which every proxied request is rejected.

A safe generator:

```bash
openssl rand -base64 48 | tr -d '\n'
```

Base64's alphabet is printable ASCII and round-trips through the header layer unchanged (measured:
base64 with `+`, `/` and `=`, and hex, both arrive byte-identical over a real socket).

## 4 · What this fixes — read this if you have seen the symptom

**If ingestion was returning `401` while billing and the worker kept serving normally, a
whitespace-padded `INTERNAL_API_SECRET` was probably why.**

Before this change the four services did not agree on what a valid secret was. gateway and
usage-service accepted a padded value and used it verbatim; worker-service and billing-service
trimmed it. Both HTTP clients in this stack strip leading and trailing space and tab from a header
value **in transit**, so with one stray space in the deployed secret:

```
gateway sends padded -> usage-service (compares against the padded value):   401
gateway sends padded -> billing-service (compares against the trimmed value): 200
```

Measured end-to-end over a real socket against the real guards. Nothing in any log named the
cause: the gateway saw a healthy upstream returning `401`, and usage-service saw a secret that did
not match. The two services that behaved differently were the two that had been fixed first, which
is why partially closing this gap made it worse than leaving it alone.

**The fix is complete only once all four services carry the change.** With a padded secret
deployed, usage-service keeps rejecting until **usage-service itself** is updated — and only
usage-service: measured on this run, an *old* gateway reaches an *updated* usage-service at `200`,
so gateway is not the service that has to move first. §5 carries the full matrix and the deploy
ordering that follows from it. Redeploy all four regardless: worker-service and billing-service
are unaffected in either direction, and one rule on all four is the state this change exists to
reach.

A second class is closed at the same time, and it did **not** fail safely in either direction.
A secret made of invisible characters was accepted by the previous rule, and what happened next
depended on where the character sat relative to **U+00FF**, because Node encodes header values as
latin-1.

**Two different probes, two different widths** — stating them separately, because an earlier
revision of this paragraph attached one probe's width to the other's result. The `.trim()`
classification ran over **20 characters**; the transit-and-proxy run covered **10**, each
repeated 32 times as a whole secret:

- **At or below U+00FF, it authenticates.** Three characters measured end to end — **U+0085**,
  **U+00AD** and the boundary itself, **U+00FF**. Each was accepted by the old
  `.trim().min(32)`, each arrived at the upstream **byte-identical** to what was sent, and each
  returned **`200`** through the real `@fastify/http-proxy`. Not two characters plus an untested
  boundary marker: all three authenticate, U+00FF included. Such a secret works; it is merely
  unreadable by whoever has to maintain it.
- **Above U+00FF, the caller fails and the service never sees the request.** Seven characters
  measured — **U+0100**, **U+034F**, **U+180E**, **U+200B**, **U+200C**, **U+200D**, **U+2060**.
  The HTTP client refuses to encode the header *before sending*, so the **gateway answers `500`**
  on every proxied request. Three clients, three different refusals: `node:http` throws
  `ERR_INVALID_CHAR`; the `undici` package's `request()` throws `UND_ERR_INVALID_ARG`
  (`InvalidArgumentError`, message `invalid x-internal-secret header`); Node's global `fetch`
  throws a bare `TypeError` with **no `code`**, reading
  `Cannot convert argument to a ByteString because the character at index 0 has a value of …
  which is greater than 255`. If you are checking for this by error code, the `fetch` path has
  none to check.

Neither is "a service that refuses every request", which is what this was previously recorded as.
Both are now refused at startup instead, with the message in §2.

**Scope of those numbers**, so they are not read wider than they were run: 20 code points for
the trim rule; 10 code points through transit and the proxy, plus a 32-character ASCII control
that returned `200`; `node:http`, `undici` 7.29.0 and Node 22.22.2's global `fetch`; fastify
5.10.0 and the real `@fastify/http-proxy` plugin configured as `proxy.plugin.ts` configures it.
No browser, forward proxy, load balancer or managed ingress was in the path of any of it, and no
other code point was tried.

## 5 · Compatibility and rollback

**Deploy ordering is free for an already-unpadded secret, and only for that one.** If §1's check
reports `OK` with **no** `NOTE`, old and new code behave identically in both directions: the new
services accept what the old ones accepted, and the old services accept what the new ones send.
Measured with an unpadded 32-character secret over a real `node:http` socket against the real
guard — `200` in all six cells of the old/new-sender × three-receiver-rule matrix below.

**A whitespace-padded secret is the exception, and it is valid under the new rule**, because the
trim runs before the length check. For that class a **new** gateway transmits the *trimmed* value
while an **old** usage-service still compares against the *padded* one. Both HTTP clients in this
stack strip leading and trailing SP/HTAB in transit (§4) — re-measured against an echo server on
this run: the padded value transmitted arrives at the upstream as the bare 32 characters. Same
probe, deployed value `"  "` + 32 × `a` + `"  "`:

```
                              OLD usage-service   OLD worker/billing   NEW service
                              (.min(32))          (.trim().min(32))    (shared rule)
  OLD gateway (.min(32))            401                 200                200
  NEW gateway (shared rule)         401                 200                200
```

Read it as follows, because the ordering advice is not "any order" and it is also not "no safe
order":

- **The `401` is not created by the deploy — it is already there.** With a padded secret,
  `OLD gateway -> OLD usage-service` is `401` before anything is redeployed. That is the §4
  symptom.
- **Deploying gateway first does not fix it.** `NEW gateway -> OLD usage-service` is still `401`.
  This section previously read "the services may be redeployed in any order", which an operator
  could take as permission to start with gateway and expect interoperation; that claim was false
  for exactly the secret this change exists to fix, and is corrected here.
- **usage-service is the service that has to move.** Both senders reach a `NEW service` at `200`,
  and worker-service and billing-service already trimmed before this change, so their column is
  `200` throughout.
- **Stripping the padding first (§1) removes the question entirely**, which is why §1 is a
  required step rather than a note.

**§4 is the authority on this**: *"The fix is complete only once all four services carry the
change… Redeploy all four."* Nothing in this section relaxes that.

One further mixed-version case, which is not a `401` at all: a secret that fails the new rule
outright makes the **new** service refuse to start, with the message in §2, where the old one may
have started on it — the character class in particular was accepted by every pre-change
declaration (§4). §1's `FAIL` lines are exactly that set, which is the other reason to run it
first.

Two behaviour changes are visible to a caller, and neither affects a correctly-configured client:

- billing's `POST /v1/internal/billing/generate` and worker's `POST /v1/internal/worker/replay`
  now answer `401` for an unauthenticated request that previously got a `500` describing the JSON
  body parser. A caller holding the secret is unaffected; a caller without it now learns strictly
  less.
- A duplicated `X-Internal-Secret` header is rejected by all three services rather than having its
  first value taken by two of them. In practice such a header arrives joined into a single string
  and was already rejected on that path.

**Rollback is unconditional: redeploy the previous image.** There is no migration, no schema
change and no persisted state, so nothing has to be undone first. The only thing rolling back
restores is the looser secret rule — a service that refused to start under the new rule will start
under the old one, with the split described in §4 back in place.
