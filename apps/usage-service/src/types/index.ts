declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

export {};

