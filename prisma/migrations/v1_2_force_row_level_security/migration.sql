-- Enable FORCE ROW LEVEL SECURITY on all tenant-scoped tables
-- CORRECTION (v1_4_app_role_non_superuser): FORCE ROW LEVEL SECURITY does NOT stop a
-- superuser, and does not stop a role holding BYPASSRLS. All it does is remove the
-- *table owner's* exemption, so the owner is subject to its own policies too.
-- Stopping a superuser is not possible with any table-level setting; the only fix is to
-- connect as a NOSUPERUSER NOBYPASSRLS non-owner role. That role is telemetry_app,
-- created in v1_4_app_role_non_superuser.
-- Required for multi-tenant SaaS data isolation

ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Event" FORCE ROW LEVEL SECURITY;
ALTER TABLE "UsageLine" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Meter" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" FORCE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceLineItem" FORCE ROW LEVEL SECURITY;
ALTER TABLE "MetricRollup" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ExportAudit" FORCE ROW LEVEL SECURITY;
