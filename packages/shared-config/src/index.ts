import type { ZodType } from "zod";

export const packageName = "@telemetry/shared-config";
export const packageDescription = "Shared configuration primitives and helpers";

export const parseEnv = <TOutput>(schema: ZodType<TOutput>, env: NodeJS.ProcessEnv): Readonly<TOutput> => {
	const parsed = schema.safeParse(env);

	if (!parsed.success) {
		const firstIssue = parsed.error.issues[0];
		const fieldName = firstIssue?.path.join(".") || "unknown";

		throw new Error(`Invalid environment configuration for ${fieldName}: ${firstIssue?.message ?? "unknown error"}`);
	}

	return Object.freeze(parsed.data);
};
