import { trace } from "@opentelemetry/api";
import pino, { type DestinationStream, type Logger, type LoggerOptions, stdTimeFunctions } from "pino";

export const packageName = "@telemetry/shared-logger";
export const packageDescription = "Shared Pino logger factory";

const DEFAULT_LOG_LEVEL = "info";

const resolveLogLevel = (value: string | undefined): string => {
	const candidate = value?.trim();
	return candidate ? candidate : DEFAULT_LOG_LEVEL;
};

const createLoggerOptions = (serviceName: string): LoggerOptions => {
	return {
		level: resolveLogLevel(process.env.LOG_LEVEL),
		base: {
			service: serviceName
		},
		timestamp: stdTimeFunctions.isoTime,
		formatters: {
			level: (label: string) => ({ level: label })
		},
		mixin: () => {
			const span = trace.getActiveSpan();
			if (!span) {
				return {};
			}

			const { traceId, spanId } = span.spanContext();
			return { traceId, spanId };
		}
	};
};

export const createLogger = (serviceName: string, destination?: DestinationStream): Logger => {
	return pino(createLoggerOptions(serviceName), destination);
};
