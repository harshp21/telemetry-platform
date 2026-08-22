import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";

export const packageName = "@telemetry/shared-tracing";
export const packageDescription = "Shared OpenTelemetry setup";

let tracingInitialized = false;

export const initTracing = (serviceName: string): void => {
	if (tracingInitialized) {
		return;
	}

	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
	if (!endpoint) {
		return;
	}

	const provider = new NodeTracerProvider({
		resource: new Resource({
			[SemanticResourceAttributes.SERVICE_NAME]: serviceName
		})
	});

	provider.addSpanProcessor(
		new BatchSpanProcessor(
			new OTLPTraceExporter({
				url: endpoint
			})
		)
	);

	provider.register();

	registerInstrumentations({
		instrumentations: [new FastifyInstrumentation(), new PrismaInstrumentation(), new IORedisInstrumentation()]
	});

	tracingInitialized = true;
};
