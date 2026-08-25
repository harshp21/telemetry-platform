import { describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
import { GATEWAY_PROXY_PREFIXES } from "../src/constants";
import { registerGatewayProxyRoutes } from "../src/plugins/proxy.plugin";

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
      authServiceUrl: "http://auth-service:3000",
      usageServiceUrl: "http://usage-service:3001",
      billingServiceUrl: "http://billing-service:3002",
      analyticsServiceUrl: "http://analytics-service:3003"
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
      authServiceUrl: "http://auth-service:3000",
      usageServiceUrl: "http://usage-service:3001",
      billingServiceUrl: "http://billing-service:3002",
      analyticsServiceUrl: "http://analytics-service:3003"
    });

    if (!captured) {
      throw new Error("Proxy options were not captured");
    }

    const rewrite = captured.replyOptions.rewriteRequestHeaders;
    const baseHeaders = { "content-type": "application/json" };

    const passthrough = rewrite(createRequest(), baseHeaders);
    expect(passthrough).toEqual(baseHeaders);

    const rewritten = rewrite(
      createRequest({ tenantId: "tenant-1", userId: "user-1", role: "admin" }),
      baseHeaders
    );

    expect(rewritten).toEqual({
      "content-type": "application/json",
      "x-tenant-id": "tenant-1",
      "x-user-id": "user-1",
      "x-user-role": "admin"
    });
  });
});