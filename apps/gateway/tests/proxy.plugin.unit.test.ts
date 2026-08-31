import { describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
import { GATEWAY_HEADERS, GATEWAY_PROXY_PREFIXES } from "../src/constants";
import { registerGatewayProxyRoutes } from "../src/plugins/proxy.plugin";

const INTERNAL_API_SECRET = "gateway-test-internal-secret-at-least-32-chars";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

const UPSTREAMS = {
  authServiceUrl: "http://auth-service:3000",
  usageServiceUrl: "http://usage-service:3001",
  billingServiceUrl: "http://billing-service:3002",
  analyticsServiceUrl: "http://analytics-service:3003"
} as const;

type ProxyRegistrationOptions = {
  upstream: string;
  prefix: string;
  rewritePrefix: string;
  replyOptions: {
    rewriteRequestHeaders: (request: FastifyRequest, headers: Record<string, string>) => Record<string, string>;
  };
};

type ProxyAppMock = {
  register: (plugin: unknown, options: ProxyRegistrationOptions) => void;
};

const createRequest = (authContext?: { tenantId: string; userId: string; role: string }): FastifyRequest => {
  return {
    authContext
  } as FastifyRequest;
};

describe("gateway proxy route registration", () => {
  it("registers all proxy route groups with expected upstream mapping", () => {
    const registerCalls: Array<{ plugin: unknown; options: ProxyRegistrationOptions }> = [];
    const app = {
      register: (plugin: unknown, options: ProxyRegistrationOptions): void => {
        registerCalls.push({ plugin, options });
      }
    } satisfies ProxyAppMock;

    registerGatewayProxyRoutes(app as unknown as FastifyInstance, {
      ...UPSTREAMS,
      internalApiSecret: INTERNAL_API_SECRET
    });

    expect(registerCalls).toHaveLength(4);
    for (const call of registerCalls) {
      expect(call.plugin).toBe(fastifyHttpProxy);
    }

    expect(registerCalls[0]?.options).toMatchObject({
      prefix: GATEWAY_PROXY_PREFIXES.AUTH,
      rewritePrefix: GATEWAY_PROXY_PREFIXES.AUTH,
      upstream: "http://auth-service:3000"
    });
    expect(registerCalls[1]?.options).toMatchObject({
      prefix: GATEWAY_PROXY_PREFIXES.USAGE,
      rewritePrefix: GATEWAY_PROXY_PREFIXES.USAGE,
      upstream: "http://usage-service:3001"
    });
    expect(registerCalls[2]?.options).toMatchObject({
      prefix: GATEWAY_PROXY_PREFIXES.BILLING,
      rewritePrefix: GATEWAY_PROXY_PREFIXES.BILLING,
      upstream: "http://billing-service:3002"
    });
    expect(registerCalls[3]?.options).toMatchObject({
      prefix: GATEWAY_PROXY_PREFIXES.ANALYTICS,
      rewritePrefix: GATEWAY_PROXY_PREFIXES.ANALYTICS,
      upstream: "http://analytics-service:3003"
    });
  });

  it("injects auth context headers only for authenticated requests", () => {
    let captured: ProxyRegistrationOptions | undefined;
    const app = {
      register: (_plugin: unknown, options: ProxyRegistrationOptions): void => {
        captured = options;
      }
    } satisfies ProxyAppMock;

    registerGatewayProxyRoutes(app as unknown as FastifyInstance, {
      ...UPSTREAMS,
      internalApiSecret: INTERNAL_API_SECRET
    });

    if (!captured) {
      throw new Error("Proxy options were not captured");
    }

    const rewrite = captured.replyOptions.rewriteRequestHeaders;
    const baseHeaders = { "content-type": "application/json" };

    // Unauthenticated (public auth routes): identity headers still absent...
    const passthrough = rewrite(createRequest(), baseHeaders);
    expect(passthrough[GATEWAY_HEADERS.TENANT_ID]).toBeUndefined();
    expect(passthrough[GATEWAY_HEADERS.USER_ID]).toBeUndefined();
    expect(passthrough[GATEWAY_HEADERS.USER_ROLE]).toBeUndefined();
    // ...but the internal secret is still injected: it asserts "this came through the gateway",
    // which is independent of whether a user identity exists.
    expect(passthrough).toEqual({
      "content-type": "application/json",
      [GATEWAY_HEADERS.INTERNAL_SECRET]: INTERNAL_API_SECRET
    });

    const rewritten = rewrite(
      createRequest({ tenantId: TENANT_ID, userId: "user-1", role: "admin" }),
      baseHeaders
    );

    expect(rewritten).toEqual({
      "content-type": "application/json",
      [GATEWAY_HEADERS.INTERNAL_SECRET]: INTERNAL_API_SECRET,
      [GATEWAY_HEADERS.TENANT_ID]: TENANT_ID,
      [GATEWAY_HEADERS.USER_ID]: "user-1",
      [GATEWAY_HEADERS.USER_ROLE]: "admin"
    });
  });

  it("overwrites a client-supplied internal secret rather than forwarding it", () => {
    let captured: ProxyRegistrationOptions | undefined;
    const app = {
      register: (_plugin: unknown, options: ProxyRegistrationOptions): void => {
        captured = options;
      }
    } satisfies ProxyAppMock;

    registerGatewayProxyRoutes(app as unknown as FastifyInstance, {
      ...UPSTREAMS,
      internalApiSecret: INTERNAL_API_SECRET
    });

    if (!captured) {
      throw new Error("Proxy options were not captured");
    }

    const rewrite = captured.replyOptions.rewriteRequestHeaders;

    const forged = rewrite(createRequest(), {
      "content-type": "application/json",
      [GATEWAY_HEADERS.INTERNAL_SECRET]: "attacker-supplied-secret"
    });

    expect(forged[GATEWAY_HEADERS.INTERNAL_SECRET]).toBe(INTERNAL_API_SECRET);
  });
});