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
});
