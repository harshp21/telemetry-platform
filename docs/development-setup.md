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

Local dev default password for `telemetry_app` is `telemetry_app_local_dev` (see
`.env.example`). Real deployments provision the role out of band; because the migration
creates the role only when it is absent, re-running migrations never overwrites a real
credential.
