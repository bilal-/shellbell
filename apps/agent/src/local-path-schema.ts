import { isAbsolute } from "node:path";
import { z } from "zod";
export const NativePathSchema = z
  .string()
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= 4096 &&
      isAbsolute(value) &&
      ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
  );
