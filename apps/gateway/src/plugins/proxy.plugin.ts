import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyInstance } from "fastify";
import { GATEWAY_HEADERS, GATEWAY_PROXY_PREFIXES } from "../constants";

export interface GatewayProxyUpstreams {
  readonly authServiceUrl: string;
  readonly usageServiceUrl: string;
  readonly billingServiceUrl: string;
  readonly analyticsServiceUrl: string;
  /**
   * Shared `INTERNAL_API_SECRET`. Proves to an upstream that the request came through the
   * gateway rather than straight at the service's port (S-4).
   */
  readonly internalApiSecret: string;
}

const registerProxyRoute = (
  app: FastifyInstance,
  prefix: string,
  upstream: string,
  internalApiSecret: string
): void => {
  app.register(fastifyHttpProxy, {
    upstream,
    prefix,
    // Keep path structure unchanged across gateway and upstream services.
    rewritePrefix: prefix,
    replyOptions: {
      rewriteRequestHeaders: (request, headers) => {
        // Set unconditionally, and before the auth-context branch below. The secret asserts
        // "this request came through the gateway", which is independent of whether a user
        // identity exists -- and setting it on every path means there is no branch on which a
        // client-supplied x-internal-secret is forwarded verbatim to an upstream.
        const proxiedHeaders = {
          ...headers,
          [GATEWAY_HEADERS.INTERNAL_SECRET]: internalApiSecret
        };

        const authContext = request.authContext;

        if (!authContext) {
          return proxiedHeaders;
        }

        return {
          ...proxiedHeaders,
          [GATEWAY_HEADERS.TENANT_ID]: authContext.tenantId,
          [GATEWAY_HEADERS.USER_ID]: authContext.userId,
          [GATEWAY_HEADERS.USER_ROLE]: authContext.role
        };
      }
    }
  });
};

export const registerGatewayProxyRoutes = (
  app: FastifyInstance,
  upstreams: GatewayProxyUpstreams
): void => {
  const { internalApiSecret } = upstreams;

  registerProxyRoute(app, GATEWAY_PROXY_PREFIXES.AUTH, upstreams.authServiceUrl, internalApiSecret);
  registerProxyRoute(app, GATEWAY_PROXY_PREFIXES.USAGE, upstreams.usageServiceUrl, internalApiSecret);
  registerProxyRoute(
    app,
    GATEWAY_PROXY_PREFIXES.BILLING,
    upstreams.billingServiceUrl,
    internalApiSecret
  );
  registerProxyRoute(
    app,
    GATEWAY_PROXY_PREFIXES.ANALYTICS,
    upstreams.analyticsServiceUrl,
    internalApiSecret
  );
};
