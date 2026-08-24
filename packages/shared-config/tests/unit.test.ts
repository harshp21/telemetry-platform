import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv } from "../src";

describe("shared-config", () => {
  it("throws with the missing field name", () => {
    const schema = z.object({
      REQUIRED_KEY: z.string().min(1)
    });

    expect(() => parseEnv(schema, {})).toThrow("REQUIRED_KEY");
  });

  it("returns a frozen parsed env object", () => {
    const schema = z.object({
      PORT: z.coerce.number().int().positive()
    });

    const parsed = parseEnv(schema, { PORT: "3001" });

    expect(parsed.PORT).toBe(3001);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("includes nested field path in validation errors", () => {
    const schema = z.object({
      DATABASE: z.object({
        URL: z.string().url()
      })
    });

    expect(() => parseEnv(schema, { DATABASE: "not-an-object" })).toThrow("DATABASE");
  });

  it("prevents top-level mutation on parsed env", () => {
    const schema = z.object({
      LOG_LEVEL: z.string().min(1)
    });

    const parsed = parseEnv(schema, { LOG_LEVEL: "info" });

    expect(() => {
      Object.assign(parsed, { LOG_LEVEL: "debug" });
    }).toThrow();
  });
});
