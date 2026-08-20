# Epic 2 — Database Foundation

**Milestone**: v1-mvp
**Depends on**: Epic 1 (shared-types must be final), Q1, Q6 decisions
**Blocks**: All service epics (3–9)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q1 — Event payload | Field names must be locked before `Event` model is written |
| Q6 — Multi-tenancy | Single membership or can one user belong to multiple tenants? Affects `Membership` model |

---

## T-007 · Prisma models: identity domain

**File**: `prisma/schema.prisma`

**Story**: Define the identity and access models. Every other model references `Tenant`. Multi-tenancy must be decided before this is written — if a user can belong to multiple tenants, a `Membership` join table is needed; if not, `tenantId` on `User` is sufficient.

**Models**:
```prisma
model Tenant {
  id          String    @id @default(uuid())
  name        String
  plan        Plan      @default(FREE)
  timezone    String    @default("UTC")
  createdAt   DateTime  @default(now())
  deletedAt   DateTime?

  users       User[]
  events      Event[]
  invoices    Invoice[]
}

enum Plan { FREE PRO ENTERPRISE }

model User {
  id           String    @id @default(uuid())
  tenantId     String
  tenant       Tenant    @relation(fields: [tenantId], references: [id])
  email        String
  passwordHash String
  role         Role      @default(MEMBER)
  createdAt    DateTime  @default(now())

  @@unique([tenantId, email])
  @@index([tenantId])
}

enum Role { OWNER ADMIN MEMBER }

model RefreshToken {
  id        String    @id @default(uuid())
  userId    String
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}
```

**Constraint**: If Q6 decides multi-membership, add `Membership` model and remove direct `tenantId` from `User`.

---

## T-008 · Prisma models: usage domain

**File**: `prisma/schema.prisma`

**Story**: Events are the source of truth for all billing and analytics. The `Event` model field names must exactly match the Q1 decision on `EventPayload`. `UsageLine` is the processed, billing-safe record derived from each event.

**Models**:
```prisma
model Event {
  id              String    @id @default(uuid())
  tenantId        String
  tenant          Tenant    @relation(fields: [tenantId], references: [id])
  idempotencyKey  String    @unique
  eventType       String
  quantity        Decimal   @db.Decimal(18, 6)
  unit            String
  occurredAt      DateTime
  metadata        Json?
  createdAt       DateTime  @default(now())

  usageLine       UsageLine?

  @@index([tenantId, occurredAt])
  @@index([tenantId, eventType])
}

model UsageLine {
  id           String   @id @default(uuid())
  tenantId     String
  eventId      String   @unique
  event        Event    @relation(fields: [eventId], references: [id])
  metricKey    String
  quantity     Decimal  @db.Decimal(18, 6)
  periodStart  DateTime
  periodEnd    DateTime
  processedAt  DateTime @default(now())
  billed       Boolean  @default(false)

  @@index([tenantId, periodStart, periodEnd])
  @@index([tenantId, billed])
}
```

---

## T-009 · Prisma models: billing domain

**File**: `prisma/schema.prisma`

**Story**: Billing models represent the financial system of record. `Invoice` records are immutable once finalized — enforced at the service layer, documented in a migration comment. `Meter` stores rate plan configuration per tenant per metric.

**Models**:
```prisma
model Meter {
  id          String    @id @default(uuid())
  tenantId    String
  tenant      Tenant    @relation(fields: [tenantId], references: [id])
  metricKey   String
  unitPrice   Decimal   @db.Decimal(18, 6)
  currency    String    @default("USD")
  tierJson    Json?     // null = flat rate; populated = tiered volume config
  activeFrom  DateTime
  activeTo    DateTime?

  @@unique([tenantId, metricKey, activeFrom])
  @@index([tenantId])
}

model Invoice {
  id           String        @id @default(uuid())
  tenantId     String
  tenant       Tenant        @relation(fields: [tenantId], references: [id])
  periodStart  DateTime
  periodEnd    DateTime
  status       InvoiceStatus @default(DRAFT)
  totalAmount  Decimal       @db.Decimal(18, 6)
  currency     String        @default("USD")
  createdAt    DateTime      @default(now())
  finalizedAt  DateTime?

  lineItems    InvoiceLineItem[]

  @@unique([tenantId, periodStart, periodEnd])
  @@index([tenantId, status])
}

enum InvoiceStatus { DRAFT FINALIZED PAID }

model InvoiceLineItem {
  id         String   @id @default(uuid())
  invoiceId  String
  invoice    Invoice  @relation(fields: [invoiceId], references: [id])
  metricKey  String
  quantity   Decimal  @db.Decimal(18, 6)
  unitPrice  Decimal  @db.Decimal(18, 6)
  amount     Decimal  @db.Decimal(18, 6)
}
```

---

## T-010 · Prisma models: analytics + audit domain

**File**: `prisma/schema.prisma`
**Milestone**: v1

**Story**: Pre-aggregated rollups avoid expensive on-demand GROUP BY queries for dashboard APIs. `ExportAudit` captures who exported what and when for compliance traceability.

**Models**:
```prisma
model MetricRollup {
  id          String      @id @default(uuid())
  tenantId    String
  metricKey   String
  granularity Granularity
  bucketStart DateTime
  value       Decimal     @db.Decimal(18, 6)
  computedAt  DateTime    @default(now())

  @@unique([tenantId, metricKey, granularity, bucketStart])
  @@index([tenantId, granularity, bucketStart])
}

enum Granularity { HOUR DAY WEEK }

model ExportAudit {
  id         String   @id @default(uuid())
  tenantId   String
  userId     String
  filters    Json
  rowCount   Int
  exportedAt DateTime @default(now())

  @@index([tenantId, exportedAt])
}
```

---

## T-011 · Initial migration + seed script

**Files**: `prisma/migrations/`, `prisma/seed.ts`

**Story**: Generate the initial migration, review the SQL manually, and write a seed script for local development. The seed creates one complete tenant environment so any service can be started without manual DB setup.

**Seed creates**:
- One `Tenant` (`id: fixed UUID for local dev`, `name: "Acme Corp"`, `plan: PRO`)
- One `User` (`email: admin@acme.local`, `role: OWNER`, hashed password: `password123`)
- One `Meter` per default metric key (`api.request`, `storage.write`, `storage.read`)

**Commands**:
```bash
pnpm --filter @telemetry/prisma migrate dev --name init
pnpm --filter @telemetry/prisma db seed
```

**Acceptance**:
- `prisma migrate reset` followed by `prisma db seed` completes without error on a fresh Docker Compose stack
- Migration SQL reviewed for missing indexes and constraint correctness
- No raw `Decimal` precision loss — all money fields use `@db.Decimal(18, 6)`
