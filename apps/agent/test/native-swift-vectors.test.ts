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
  it("covers every native command's request and successful response", () => {
    const valid = (kind: string) => vectors.filter((v) => v.kind === kind && v.valid);
    const requested = new Set(valid("request").map((v) => (v.value as { cmd: string }).cmd));
    const answered = new Set(valid("response").map((v) => v.command));
    // A command added on one side needs a vector both Swift and TypeScript accept.
    for (const command of Object.keys(NativeDataSchemas)) {
      expect(requested.has(command), `request vector for ${command}`).toBe(true);
      expect(answered.has(command), `response vector for ${command}`).toBe(true);
    }
  });
});
