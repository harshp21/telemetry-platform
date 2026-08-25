FROM node:22-alpine AS base

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.mjs README.md ./
COPY apps ./apps
COPY packages ./packages
COPY prisma ./prisma
COPY docs ./docs

RUN pnpm install --frozen-lockfile=false
RUN cp prisma/schema.prisma apps/auth-service/schema.ci.prisma \
	&& pnpm --filter @telemetry/auth-service exec prisma generate --schema=./schema.ci.prisma \
	&& rm -f apps/auth-service/schema.ci.prisma

ARG SERVICE_NAME
ENV SERVICE_NAME=${SERVICE_NAME}

CMD ["sh", "-lc", "pnpm --filter @telemetry/${SERVICE_NAME} exec tsx src/index.ts"]
