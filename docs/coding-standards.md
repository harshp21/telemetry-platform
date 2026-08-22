# Coding Standards

- Strict TypeScript enabled
- ESLint with TypeScript rules and Prettier compatibility
- Thin controllers
- Service and repository layers
- Zod runtime validation for inputs and environment
- Dependency injection via app container modules
- Extract reusable literals into service-local constants modules
- Do not hard-code service names, listen hosts, default ports, route paths, header names, response codes/messages, or workflow/event names in controllers, routes, middleware, and entrypoints
- Keep runtime startup values under a dedicated runtime constants object per service (example: SERVICE_RUNTIME.DEFAULT_PORT, SERVICE_RUNTIME.HOST)
- Keep `index.ts` startup constants in a side-effect-free module (example: `startup.constants.ts`) so tracing can initialize before any heavy service/module graph is pulled in
