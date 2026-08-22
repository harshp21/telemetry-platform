-- Align migration history with Prisma schema: enforce global user email uniqueness.
DROP INDEX IF EXISTS "User_tenantId_email_key";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
