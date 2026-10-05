import { describe, expect, it } from "vitest";
import { terminalWebUrl } from "../src/terminal/links";

describe("terminal links crossing into native URL handlers", () => {
  it.each([
    [
      "https://shellbell.dev/docs?mode=terminal#input",
      "https://shellbell.dev/docs?mode=terminal#input",
    ],
    ["HTTP://localhost:3000", "http://localhost:3000/"],
    ["https://[::1]:8443/status", "https://[::1]:8443/status"],
  ])("allows web URL %s", (input, expected) => {
    expect(terminalWebUrl(input)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "intent://open#Intent;scheme=shellbell;end",
    "file:///private/keys",
    "data:text/html,<script>alert(1)</script>",
    "shellbell://pair?secret=example",
    "mailto:example@example.com",
    "//example.com",
    "https://example.com\\@other.example",
    "https://user:password@example.com",
    "https://example.com/\npath",
    "https://example.com/\u0000path",
    "https://example.com:invalid",
    `https://example.com/${"a".repeat(1800)}`,
    null,
    {},
  ])("rejects unsafe or invalid value %j", (input) => {
    expect(terminalWebUrl(input)).toBeNull();
  });
});
