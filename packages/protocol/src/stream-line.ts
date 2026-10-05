import { z } from "zod";
import { LineSchema, RunSchema } from "./inner.js";

/** Encoding an isolated surrogate would replace terminal text with U+FFFD. */
function scalarText(text: string): boolean {
  if (text.length > 4096) return false;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export const StreamRunSchema = RunSchema.extend({
  t: RunSchema.shape.t.refine(scalarText),
}).strict();
// Local screen sources can exceed run counts: style fallback may coalesce them losslessly.
export const StreamSourceLineSchema = LineSchema.extend({ r: z.array(StreamRunSchema) }).strict();
export const StreamLineSchema = StreamSourceLineSchema.extend({
  r: z.array(StreamRunSchema).max(2048),
});
