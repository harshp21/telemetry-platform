# Development Setup

## Prerequisites

- Node.js 22+
- pnpm 10+
- Docker + Docker Compose

## Install

pnpm install

## Start Infra

docker compose -f docker/docker-compose.yml up -d

## Start Apps

pnpm dev

## Database roles

Two connection strings, by design (see `.claude/rules/tenant-isolation.md`):

- `DATABASE_URL` -> `telemetry_app`. NOSUPERUSER, NOBYPASSRLS, owns no table. This is what
  every service uses at runtime, and it is the only reason the RLS policies enforce.
- `DIRECT_DATABASE_URL` -> the admin/owner role. Prisma reads it as `directUrl`, so
  `prisma migrate deploy` and `prisma migrate status` run as the owner. Nothing at runtime
  should use it.

`telemetry_app` is created by `prisma/migrations/v1_4_app_role_non_superuser`, so on a fresh
clone the ordering is: start Postgres, then

    pnpm --filter @telemetry/auth-service exec prisma migrate deploy --schema=../../prisma/schema.prisma

with `DIRECT_DATABASE_URL` pointing at the admin role. The compose stack does not run
migrations, so it creates the role from `docker/postgres/init/01-app-role.sql` instead --
that script only runs on an empty data volume, so after editing it use
`docker compose -f docker/docker-compose.yml down -v`.

`prisma/migrations/v1_5_auth_tenant_resolvers` then creates two more roles and the two
`SECURITY DEFINER` resolvers auth-service uses to find a tenant *before* one is known:

- `telemetry_auth_definer` — `NOLOGIN NOSUPERUSER NOBYPASSRLS`, owns the resolvers, and reads
  past the tenant policy through two targeted `FOR SELECT` policies rather than a role
  attribute.
- `telemetry_auth_app` — `LOGIN`, auth-service's runtime connection. It alone holds `EXECUTE` on
  the resolvers, so the role the other five services share cannot call them — and it holds
  **fewer** table privileges than `telemetry_app`, not the same: DML on `"Tenant"`, `"User"` and
  `"RefreshToken"` only, with no `ALTER DEFAULT PRIVILEGES`. If you provision it by hand, grant
  those three and no more; the migration's guard rejects anything wider.

`CREATE ROLE` needs `CREATEROLE` or superuser, which is another reason migrations run as the
owner and never as an application role. auth-service must not start on `telemetry_auth_app`
until this migration has been applied — see
`docs/releases/s-007-auth-service-restricted-role.md`.

The compose init script mirrors `telemetry_auth_app` but not the definer role or the resolvers;
`docker/postgres/init/01-app-role.sql` explains why.

Local dev default passwords are `telemetry_app_local_dev` for `telemetry_app` and
`telemetry_auth_app_local_dev` for `telemetry_auth_app` (see `.env.example` and
`apps/auth-service/.env.example`; `telemetry_auth_definer` is `NOLOGIN` and has none).
Real deployments provision the role out of band; because the migration
creates the role only when it is absent, re-running migrations never overwrites a real
credential.
