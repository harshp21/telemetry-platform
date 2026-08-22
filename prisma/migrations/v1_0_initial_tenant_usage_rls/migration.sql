CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'FINALIZED', 'PAID');
CREATE TYPE "Granularity" AS ENUM ('HOUR', 'DAY', 'WEEK');

CREATE TABLE "Tenant" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "plan" "Plan" NOT NULL DEFAULT 'FREE',
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefreshToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Event" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "quantity" DECIMAL(18,6) NOT NULL,
  "unit" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageLine" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "metricKey" TEXT NOT NULL,
  "quantity" DECIMAL(18,6) NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "billed" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "UsageLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Meter" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "metricKey" TEXT NOT NULL,
  "unitPrice" DECIMAL(18,6) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "tierJson" JSONB,
  "activeFrom" TIMESTAMP(3) NOT NULL,
  "activeTo" TIMESTAMP(3),

  CONSTRAINT "Meter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Invoice" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "totalAmount" DECIMAL(18,6) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finalizedAt" TIMESTAMP(3),

  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceLineItem" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "metricKey" TEXT NOT NULL,
  "quantity" DECIMAL(18,6) NOT NULL,
  "unitPrice" DECIMAL(18,6) NOT NULL,
  "amount" DECIMAL(18,6) NOT NULL,

  CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetricRollup" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "metricKey" TEXT NOT NULL,
  "granularity" "Granularity" NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "value" DECIMAL(18,6) NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MetricRollup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExportAudit" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "filters" JSONB NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ExportAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE UNIQUE INDEX "Event_idempotencyKey_key" ON "Event"("idempotencyKey");
CREATE INDEX "Event_tenantId_occurredAt_idx" ON "Event"("tenantId", "occurredAt");
CREATE INDEX "Event_tenantId_eventType_idx" ON "Event"("tenantId", "eventType");
CREATE UNIQUE INDEX "UsageLine_eventId_key" ON "UsageLine"("eventId");
CREATE INDEX "UsageLine_tenantId_periodStart_periodEnd_idx" ON "UsageLine"("tenantId", "periodStart", "periodEnd");
CREATE INDEX "UsageLine_tenantId_billed_idx" ON "UsageLine"("tenantId", "billed");
CREATE UNIQUE INDEX "Meter_tenantId_metricKey_activeFrom_key" ON "Meter"("tenantId", "metricKey", "activeFrom");
CREATE INDEX "Meter_tenantId_idx" ON "Meter"("tenantId");
CREATE UNIQUE INDEX "Invoice_tenantId_periodStart_periodEnd_key" ON "Invoice"("tenantId", "periodStart", "periodEnd");
CREATE INDEX "Invoice_tenantId_status_idx" ON "Invoice"("tenantId", "status");
CREATE UNIQUE INDEX "MetricRollup_tenantId_metricKey_granularity_bucketStart_key" ON "MetricRollup"("tenantId", "metricKey", "granularity", "bucketStart");
CREATE INDEX "MetricRollup_tenantId_granularity_bucketStart_idx" ON "MetricRollup"("tenantId", "granularity", "bucketStart");
CREATE INDEX "ExportAudit_tenantId_exportedAt_idx" ON "ExportAudit"("tenantId", "exportedAt");

ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsageLine" ADD CONSTRAINT "UsageLine_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Meter" ADD CONSTRAINT "Meter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Meter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetricRollup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExportAudit" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Event" FORCE ROW LEVEL SECURITY;
ALTER TABLE "UsageLine" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Meter" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" FORCE ROW LEVEL SECURITY;
ALTER TABLE "MetricRollup" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ExportAudit" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_self_select" ON "Tenant" FOR SELECT USING ("id" = current_setting('app.tenant_id', true));
CREATE POLICY "tenant_self_insert" ON "Tenant" FOR INSERT WITH CHECK ("id" = current_setting('app.tenant_id', true));
CREATE POLICY "tenant_self_update" ON "Tenant" FOR UPDATE USING ("id" = current_setting('app.tenant_id', true)) WITH CHECK ("id" = current_setting('app.tenant_id', true));
CREATE POLICY "tenant_self_delete" ON "Tenant" FOR DELETE USING ("id" = current_setting('app.tenant_id', true));

CREATE POLICY "user_tenant_isolation" ON "User" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "event_tenant_isolation" ON "Event" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "usage_line_tenant_isolation" ON "UsageLine" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "meter_tenant_isolation" ON "Meter" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "invoice_tenant_isolation" ON "Invoice" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "metric_rollup_tenant_isolation" ON "MetricRollup" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "export_audit_tenant_isolation" ON "ExportAudit" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
