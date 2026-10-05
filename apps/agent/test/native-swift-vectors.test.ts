import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NativeDataSchemas,
  NativeEventSchema,
  NativeHelperResponseSchema,
  NativeRecordSchema,
  NativeRequestSchema,
  NativeResponseSchema,
} from "../src/native/protocol.js";

const vectors = JSON.parse(
  readFileSync(new URL("../../macos/Tests/Fixtures/native-protocol.json", import.meta.url), "utf8"),
) as {
  name: string;
  kind: string;
  command?: keyof typeof NativeDataSchemas;
  valid: boolean;
  value: unknown;
}[];

describe("Swift and TypeScript share native wire vectors", () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      const schemas = {
        request: NativeRequestSchema,
        response: NativeResponseSchema,
        event: NativeEventSchema,
        helper: NativeHelperResponseSchema,
        record: NativeRecordSchema,
      };
      const parsed = schemas[vector.kind as keyof typeof schemas].safeParse(vector.value);
      let valid = parsed.success;
      if (valid && vector.kind === "response" && vector.command) {
        const response = NativeResponseSchema.parse(vector.value);
        if (response.ok) valid = NativeDataSchemas[vector.command].safeParse(response.data).success;
      }
      expect(valid).toBe(vector.valid);
    });
  }
});
