-- Add firstName and lastName to User model
-- Required for registration endpoint (T-018) to capture user identity for support and audit

ALTER TABLE "User" ADD COLUMN "firstName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "lastName" TEXT NOT NULL DEFAULT '';

-- These defaults will be overridden during migration for existing users if needed
-- New registrations will always provide firstName and lastName
