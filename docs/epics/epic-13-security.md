# Epic 13 — Security Hardening

**Milestone**: v1-mvp (critical items), v1 (all items)
**Depends on**: All service epics
**Note**: T-070 and T-071 must be applied from the start of each service epic — not retrofitted at the end.

---

## T-070 · Tenant isolation type-level enforcement

**Files**: `apps/{service}/src/repositories/`
**Milestone**: v1-mvp — apply during each service epic, not after

**Story**: Every Prisma query must be scoped to `tenantId`. This is enforced via `TenantScopedRepository` (Epic 3, T-013). Add a grep-based CI check to catch any raw Prisma calls that bypass the repository layer.

**CI check** (add to `scripts/check-tenant-isolation.sh`):
```bash
#!/bin/bash
# Fail if any service file calls prisma.* directly outside a repository file
forbidden=$(grep -rn "prisma\.\(event\|usageLine\|invoice\|tenant\|user\)\.\(findMany\|findFirst\|update\|delete\)" \
  apps/*/src/{controllers,services,plugins,middleware} 2>/dev/null)

if [ -n "$forbidden" ]; then
  echo "ERROR: Direct Prisma calls found outside repository layer:"
  echo "$forbidden"
  exit 1
fi
```

Add to CI pipeline as a pre-test step.

---

## T-071 · Error response normalization (all services)

**Files**: `apps/{service}/src/errors/index.ts`
**Milestone**: v1-mvp — apply during each service epic

**Story**: All unhandled errors must go through a `setErrorHandler` that normalizes responses. No stack traces in production. No Prisma internal error codes exposed to clients.

**Fastify error handler**:
```ts
app.setErrorHandler((error, req, reply) => {
  req.log.error({ err: error }, "Request error");

  if (error instanceof ZodError) {
    return reply.status(400).send({
      code: "VALIDATION_ERROR",
      issues: error.issues.map(i => ({ path: i.path.join("."), message: i.message })),
    });
  }

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      code: error.code,
      message: error.message,
    });
  }

  // Prisma P2002 = unique constraint violation
  if (error.code === "P2002") {
    return reply.status(409).send({ code: "CONFLICT" });
  }

  // never expose internal details in production
  const isProd = process.env.NODE_ENV === "production";
  return reply.status(500).send({
    code: "INTERNAL_ERROR",
    ...(isProd ? {} : { message: error.message }),
  });
});
```

**`AppError` base class**:
```ts
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super("NOT_FOUND", 404, `${resource} not found`);
  }
}

export class ForbiddenError extends AppError {
  constructor() {
    super("FORBIDDEN", 403, "Access denied");
  }
}

export class InvoiceImmutableError extends AppError {
  constructor(invoiceId: string, status: string) {
    super("INVOICE_IMMUTABLE", 409, `Invoice ${invoiceId} is ${status} and cannot be modified`);
  }
}
```

---

## T-072 · Dependency audit gate

**File**: `.github/workflows/ci.yml`
**Milestone**: v1-mvp

**Story**: Block merges when high or critical CVEs are present in dependencies.

**CI step**:
```yaml
- name: Security audit
  run: pnpm audit --audit-level=high
```

**Pre-commit hook** (via `husky` + `.husky/pre-commit`):
```bash
pnpm audit --audit-level=critical
```

Note: Use `critical` in pre-commit (fast local check) and `high` in CI (thorough gate).

---

## T-073 · Internal endpoint protection

**Files**: `apps/billing-service/src/middleware/internal-auth.middleware.ts`, `apps/worker-service/src/`
**Milestone**: v1-mvp

**Story**: Internal service-to-service endpoints (e.g. billing `/v1/internal/billing/generate`) must not be callable without a shared secret. These endpoints are never proxied through the gateway but must still be authenticated.

**Middleware**:
```ts
export const internalAuthMiddleware: preHandlerHookHandler = (req, reply, done) => {
  const secret = req.headers["x-internal-secret"];
  if (secret !== env.INTERNAL_API_SECRET) {
    return reply.status(401).send({ code: "UNAUTHORIZED" });
  }
  done();
};
```

**Register only on internal routes** — not globally. Public health endpoint must remain unauthenticated.

**Acceptance**:
- Request without `X-Internal-Secret` → `401`
- Request with wrong secret → `401` (same response — no enumeration)
- Request with correct secret → proceeds normally
