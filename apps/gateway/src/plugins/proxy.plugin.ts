import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyInstance } from "fastify";
import { GATEWAY_PROXY_PREFIXES } from "../constants";

export interface GatewayProxyUpstreams {
  readonly authServiceUrl: string;
  readonly usageServiceUrl: string;
  readonly billingServiceUrl: string;
  readonly analyticsServiceUrl: string;
}

const registerProxyRoute = (
  app: FastifyInstance,
  prefix: string,
  upstream: string
): void => {
  app.register(fastifyHttpProxy, {
    upstream,
    prefix,
    // Keep path structure unchanged across gateway and upstream services.
    rewritePrefix: prefix
  });
};

export const registerGatewayProxyRoutes = (
  app: FastifyInstance,
  upstreams: GatewayProxyUpstreams
): void => {
  registerProxyRoute(app, GATEWAY_PROXY_PREFIXES.AUTH, upstreams.authServiceUrl);
  registerProxyRoute(app, GATEWAY_PROXY_PREFIXES.USAGE, upstreams.usageServiceUrl);
  registerProxyRoute(app, GATEWAY_PROXY_PREFIXES.BILLING, upstreams.billingServiceUrl);
  registerProxyRoute(app, GATEWAY_PROXY_PREFIXES.ANALYTICS, upstreams.analyticsServiceUrl);
};
