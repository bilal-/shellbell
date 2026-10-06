import { expect, it } from "vitest";
import { CapabilitiesSchema, parseInner } from "../src/inner.js";

it("keeps old backend capabilities valid without enabling new input", () => {
  const old = CapabilitiesSchema.parse({
    subscribe: true,
    prompts: false,
    createSession: true,
    focus: true,
    history: true,
    absoluteLines: false,
  });
  expect(old.terminalInput).toBeUndefined();
  expect(old.terminalPaste).toBeUndefined();
});
it("preserves literal input and requires explicit paste submission semantics", () => {
  const message = {
    type: "input.terminal",
    reqId: "literal",
    sessionId: "tmux:%1",
    data: "\x1b[1;2Dé\0\r\n",
  };
  expect(parseInner(message)).toEqual(message);
  expect(() => parseInner({ ...message, data: "" })).toThrow();
  expect(() => parseInner({ ...message, data: "x".repeat(59_001) })).toThrow();
  const paste = {
    type: "input.paste",
    reqId: "paste",
    sessionId: "herdr:term1",
    text: "first\nsecond",
    submit: false,
  };
  expect(parseInner(paste)).toEqual(paste);
  const { submit: _, ...missing } = paste;
  expect(() => parseInner(missing)).toThrow();
});
