import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { WORKER_DATABASE } from "../src/constants";
import { BillingEnumerationRepository } from "../src/repositories/billing-enumeration.repository";
import {
  INTEGRATION_COUNTS,
  INTEGRATION_ENUMERATION
} from "./integration.constants";

/**
 * Unit cases for the one caller of the cross-tenant resolver (T-042, S4).
 *
 * The *behaviour* of the resolver is proven against a live database in
 * `billing-enumeration.integration.test.ts`, as `telemetry_worker_app`. What is proven here is
 * the **shape of the call**, which no integration case can see: that both period bounds leave
 * this process as bound parameters rather than as SQL text, and that the function name comes
 * from a frozen constant. Those are the two properties that keep `CLAUDE.md` § *Raw SQL*
 * satisfied, and an integration test passes identically whether the values were bound or
 * interpolated.
 */

interface QueryRawStub {
  readonly calls: Prisma.Sql[];
  readonly client: PrismaClient;
}

/**
 * A Prisma double that records the `Prisma.Sql` it was handed.
 *
 * `$queryRaw` is the only member the repository touches, so the cast is to exactly that surface
 * rather than to `PrismaClient` at large.
 */
const stubClient = (rows: { tenantId: string }[]): QueryRawStub => {
  const calls: Prisma.Sql[] = [];
  const queryRaw = vi.fn((sql: Prisma.Sql) => {
    calls.push(sql);

    return Promise.resolve(rows);
  });

  return { calls, client: { $queryRaw: queryRaw } as unknown as PrismaClient };
};

/**
 * Returns the single recorded statement, or throws.
 *
 * Throws rather than returning `undefined`, so a repository that stopped issuing the query
 * cannot leave the assertions below passing vacuously (`.claude/rules/testing.md`).
 */
const onlyStatement = (stub: QueryRawStub): Prisma.Sql => {
  if (stub.calls.length !== INTEGRATION_COUNTS.SINGLE) {
    throw new Error(
      `expected exactly one $queryRaw call, saw ${String(stub.calls.length)}`
    );
  }

  const [statement] = stub.calls;
  if (!statement) {
    throw new Error("the recorded $queryRaw call carried no statement");
  }

  return statement;
};

describe("BillingEnumerationRepository", () => {
  it("E1 - calls the resolver named by the constant, with both period bounds as bound parameters", async () => {
    const stub = stubClient([]);
    const repository = new BillingEnumerationRepository(stub.client);

    await repository.listTenantsWithUnbilledUsage(
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    const statement = onlyStatement(stub);
    expect(statement.sql).toContain(WORKER_DATABASE.UNBILLED_TENANTS_FN);
    // **The injection-safety assertion.** Both bounds are in `values`, which means PostgreSQL
    // receives them as parameters, not as SQL text. `Prisma.raw` is applied to the frozen
    // function-name constant and to nothing else.
    expect(statement.values).toEqual([
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    ]);
    // The negative that carries the weight: neither bound appears in the SQL text. A template
    // that interpolated them would satisfy the `toContain` above and this assertion is what
    // would catch it.
    expect(statement.sql).not.toContain(INTEGRATION_ENUMERATION.WINDOW_START_ISO);
    expect(statement.sql).not.toContain(INTEGRATION_ENUMERATION.WINDOW_END_ISO);
  });

  it("E2 - returns the resolver's tenant ids", async () => {
    const first = "11111111-1111-1111-1111-111111111111";
    const second = "22222222-2222-2222-2222-222222222222";
    const stub = stubClient([{ tenantId: first }, { tenantId: second }]);
    const repository = new BillingEnumerationRepository(stub.client);

    const tenants = await repository.listTenantsWithUnbilledUsage(
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    expect(tenants).toEqual([first as TenantId, second as TenantId]);
  });

  it("E3 - returns an empty list when no tenant has unbilled usage", async () => {
    const stub = stubClient([]);
    const repository = new BillingEnumerationRepository(stub.client);

    // An empty window is a normal night, not a failure: the job must distinguish "nobody used
    // the product yesterday" from "the enumeration failed", because only the second is a
    // reason to retry the whole job (D5).
    await expect(
      repository.listTenantsWithUnbilledUsage(
        INTEGRATION_ENUMERATION.EMPTY_WINDOW_START_ISO,
        INTEGRATION_ENUMERATION.EMPTY_WINDOW_END_ISO
      )
    ).resolves.toEqual([]);
  });

  it("E4 - propagates a database failure rather than reporting an empty tenant list", async () => {
    const failure = new Error("connection terminated");
    const client = {
      $queryRaw: vi.fn(() => Promise.reject(failure))
    } as unknown as PrismaClient;
    const repository = new BillingEnumerationRepository(client);

    // **The most important negative in this file.** Swallowing this error and returning `[]`
    // would make a failed enumeration indistinguishable from a quiet night, and the job would
    // report success having invoiced nobody. §1 of the plan names that as the expensive
    // failure: usage is metered, never invoiced, and nothing raises an alarm because "no
    // invoice" looks exactly like "no usage".
    await expect(
      repository.listTenantsWithUnbilledUsage(
        INTEGRATION_ENUMERATION.WINDOW_START_ISO,
        INTEGRATION_ENUMERATION.WINDOW_END_ISO
      )
    ).rejects.toBe(failure);
  });
});
