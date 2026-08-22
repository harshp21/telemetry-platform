---
description: "Use when changing Prisma schema, writing SQL migrations, renaming migrations, or reviewing data-model changes. Covers v1_* naming, schema alignment, and validation steps."
---
# Prisma Migration Guidelines

- Use ordered `v1_*` migration folder names for this repo.
- Keep `prisma/schema.prisma` and migration SQL aligned in the same task slice.
- Prefer additive, deterministic SQL.
- If a constraint changes, update both schema and migration history.
- Validate with the narrowest available Prisma command from a workspace that has the CLI.
- Ask for approval before commit when migrations are changed.