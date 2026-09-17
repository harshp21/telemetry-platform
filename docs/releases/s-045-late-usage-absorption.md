# Release note — S-45 · late usage is absorbed into an existing invoice, and one unmetered row refuses the whole window

Applies to the change that makes `POST /v1/internal/billing/generate` absorb usage that landed
*after* a period's invoice was created, instead of returning the existing invoice untouched.
Plan: `docs/plans/s-045-late-usage-absorption.md`. Review:
`docs/reviews/s-045-late-usage-absorption.md`.

**This is a failure-mode note, not a deploy runbook, and that is deliberate rather than an
omission.** The three notes already in this directory (`s-007`, `t-040`, `t-042`) each carry a
deploy order because each ships a migration that must land before or after a service change.
S-45 ships **no migration and no configuration change** — `git status --porcelain` on this change
shows nothing under `prisma/`, and no `.env.example` moves — so there is no ordering to get
wrong and no rollback lever to pull beyond redeploying the previous image. What it does ship is a
response an operator has not seen before, on a path that runs unattended at 02:00 UTC, so what
follows is what that looks like and what clears it.

---

## The behaviour change in one paragraph

Before: a `generate` call for a period that already had an invoice returned
`200 { data: { invoiceId } }` and wrote nothing. Usage that arrived late for that period stayed
`billed = false` forever, silently. After: the call reads the period's unbilled usage, prices it,
and adds it to the existing invoice — `200 { data: { invoiceId, absorbed: true } }`. The money
that was quietly uncollected is now collected.

The cost of pricing it is that pricing can **fail**, and that is the rest of this note.

---

## 1 · One unmetered row refuses the whole window

If any late `UsageLine` in the period carries a `metricKey` with no active `Meter`, the call
answers **`422 METER_NOT_FOUND`** and writes nothing — including for the late rows that *could*
have been priced.

Measured on this change, against a real billing-service process on `telemetry_app`, with
fixtures seeded and read back through `DIRECT_DATABASE_URL`. A `DRAFT` invoice of `10.000000`
for `[2026-08-10, 2026-08-11)`, then two late rows in that window: one `api.request` (12 units at
a `0.500000` meter — `6.000000` of perfectly priceable revenue) and one `s45r3.unmetered`
(3 units, no meter).

```
POST /v1/internal/billing/generate  -> 422
{"code":"METER_NOT_FOUND","message":"No active meter for metric keys: s45r3.unmetered"}

Invoice            10.000000  DRAFT          (unchanged)
InvoiceLineItem    1 row, sum 10.000000      (unchanged)
UsageLine  api.request      12.000000  billed = f
UsageLine  s45r3.unmetered   3.000000  billed = f
```

`readAndPrice` prices the whole set or refuses it. So the unit of failure is the **window**, not
the row: one metric key nobody configured a meter for holds every other late row in that period
unbilled. This is the intended direction — refuse loudly rather than bill part of a period and
leave no record that the rest was owed — but it means the blast radius of a single missing meter
is larger than the row that triggered it.

## 2 · What an operator sees, and for how long

Two things, and nothing else. There is no metric to alert on: `grep -rn "prom-client"
--include=package.json .` outside `node_modules` returns no match, and metrics are deferred to
T-057.

- The nightly job's summary line, `"Invoice generation job completed"`, with a non-zero
  **`failed`** count.
- One `"Invoice generation failed for tenant"` line carrying the tenant id, the period, and
  `error: "billing-service rejected the invoice request: 422: METER_NOT_FOUND"`.

**It fires for that window once, and then never again.** The job's window is always *yesterday*
(`getPreviousDayRange`), so a poisoned window drops out of range the following night and is never
revisited. Measured — the real job over the real enumeration repository as
`telemetry_worker_app`, at four pinned instants:

```
NOW=2026-08-11T02:00Z WINDOW=[2026-08-10,2026-08-11) {"tenants":1,"succeeded":0,"failed":1}  422 METER_NOT_FOUND
NOW=2026-08-12T02:00Z WINDOW=[2026-08-11,2026-08-12) {"tenants":0,"succeeded":0,"failed":0}
NOW=2026-08-13T02:00Z WINDOW=[2026-08-12,2026-08-13) {"tenants":0,"succeeded":0,"failed":0}
NOW=2026-08-14T02:00Z WINDOW=[2026-08-13,2026-08-14) {"tenants":0,"succeeded":0,"failed":0}
```

So **a quiet night is not evidence the problem cleared.** If the *cause* persists — the same
unmetered metric key still arriving — you get one `failed` per new window, one night after
another; that is a different window failing each time, not the old one retrying.

One nuance about BullMQ retries, because it changes how many lines you count as one incident.
The nightly job is registered with `attempts: 3`. A retry re-runs the **same** window: the job
closure takes no injected clock, and the previous-day range is identical at 02:00, 02:01 and
02:03. A retry is raised only when the *enumeration* fails, and each such attempt logs its own
`"Invoice generation job failed"` — measured: an enumeration failing on all three attempts
produced three of those lines and no tenant line at all. Measured with a real BullMQ `Queue`/`Worker` on
a reserved Redis database: whichever attempt first gets past the enumeration reaches the tenant
loop and reports `{tenants: 1, succeeded: 0, failed: 1}` for that window, and then the job
*completes*, because a per-tenant failure is counted rather than thrown. The `422` is therefore
announced **once** per window; the repeated lines around it, if any, are enumeration failures and
are a different problem. (Mutating the closure to reject when `failed > 0` — which it does not —
produced three `failed: 1` lines for one window, which is how the "once" above was established
rather than assumed.)

## 3 · What it costs

That tenant's late usage for that window stays `billed = false` **indefinitely**, and nothing on
the platform will find it again on its own. `UsageLine.billed` is only ever set by a successful
invoice write, and the nightly enumeration is window-scoped, so a row left unbilled in a past
window is invisible to every future run.

The claim that nothing else will set the flag is a grep, not an impression:
`grep -rn "billed: true\|billed = true" apps/*/src packages/*/src prisma` returns three lines, two
of which are comments; the only executable one is `markUsageLinesBilled` at
`apps/billing-service/src/repositories/invoice.repository.ts:355`, reached from an invoice write.
(Scope: application code. It says nothing about a hand-written `UPDATE` at a psql prompt, which is
the other way a row can be marked.)

No money moves the wrong way and nothing is destroyed: before this change those rows were equally
unbilled, just without an alarm. What is lost is the benefit — the revenue this change exists to
collect — for that tenant and that period, until someone acts.

Frequency is **not** claimed here. How often an unmetered metric key reaches billing depends
entirely on how meters are provisioned for your tenants, and that has not been measured.

## 4 · Exactly what clears it

Two steps, and **the first alone does nothing**.

1. Create the missing `Meter` for the tenant and metric key named in the `422` message, with an
   `activeFrom` at or before the period.
2. Call the endpoint **again, naming the original window** — out of band. The nightly job will
   not do it for you.

```
POST /v1/internal/billing/generate
Header: x-internal-secret: <INTERNAL_API_SECRET>
{"tenantId":"<uuid>","periodStart":"2026-08-10T00:00:00.000Z","periodEnd":"2026-08-11T00:00:00.000Z"}
```

Measured, both halves. After adding the missing meter, three further nightly runs enumerated
`{"tenants":0,"succeeded":0,"failed":0}` and the invoice stayed at `10.000000` with both rows
unbilled — **the meter alone recovered nothing.** The out-of-band call for the original window
then returned:

```
200 {"data":{"invoiceId":"s45r3-inv-1","absorbed":true}}

Invoice 10.000000 -> 19.000000
  api.request       20 @ 0.500000 = 10.000000   (pre-existing)
  api.request       12 @ 0.500000 =  6.000000   (absorbed)
  s45r3.unmetered    3 @ 1.000000 =  3.000000   (absorbed)
UsageLine api.request billed = t   UsageLine s45r3.unmetered billed = t
```

Notes on step 2:

- The call is safe to repeat. With nothing left to absorb it returns
  `200 { invoiceId, absorbed: false }` and writes nothing —
  `apps/billing-service/src/services/billing.service.ts:284-290`, covered by unit cases, **not**
  something this note drove end to end.
- It only works while the invoice is still `DRAFT`. The guard is `status !== DRAFT`
  (`invoice.repository.ts:538-540`), so `PAID` is refused for the same reason as `FINALIZED`;
  what was *measured* is `FINALIZED`, by `BI23`, which gets `409 INVOICE_IMMUTABLE` with
  nothing written. Recovering a period past `DRAFT` needs a credit or adjustment decision, which
  this platform does not implement.
- If several windows are affected, each one needs its own call with its own
  `periodStart`/`periodEnd`. There is no bulk form.

---

## Verification after deploy

Nothing to verify at deploy time — no migration, no role, no env var. The standing signal is the
nightly job's `failed` count. A `failed` of zero every night means either that nothing was
refused or that no tenant had late usage; the two are not distinguishable from the counter alone,
which is a gap T-057's metrics are expected to close.

## Rollback

Redeploy the previous billing-service image. The endpoint reverts to returning the existing
invoice untouched, which cannot fail the way described above — and resumes leaving late usage
unbilled and unannounced, which is the condition this change exists to end. No data written by
this change needs undoing: an absorbed invoice is an ordinary `DRAFT` invoice with more line
items.
