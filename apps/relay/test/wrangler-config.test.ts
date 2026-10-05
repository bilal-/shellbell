import { describe, expect, it } from "vitest";
// @ts-expect-error - no ambient module declaration for Vite's `?raw` suffix
import hostedRaw from "../wrangler.hosted.jsonc?raw";
// `?raw` (Vite's raw-text import) is resolved at bundle time, not via a runtime fs read --
// workerd's test pool has no real filesystem, so `node:fs` cannot read these files (M7).
// @ts-expect-error - no ambient module declaration for Vite's `?raw` suffix
import selfHostedRaw from "../wrangler.jsonc?raw";

/**
 * Minimal JSONC -> JSON: strips `//` and `/* *\/` comments while respecting string literals
 * (including escapes) and drops trailing commas before `}`/`]`. Good enough for these two
 * hand-written, single-line-comment-only config files -- not a general JSONC parser.
 */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next;
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

describe("relay wrangler config parity (M7: nothing enforced the two files stay in sync)", () => {
  const selfHosted = parseJsonc(selfHostedRaw as string) as Record<string, unknown>;
  const hosted = parseJsonc(hostedRaw as string) as Record<string, unknown>;

  it("wrangler.hosted.jsonc minus `routes` deep-equals wrangler.jsonc", () => {
    const { routes: _routes, ...hostedWithoutRoutes } = hosted;
    expect(hostedWithoutRoutes).toEqual(selfHosted);
  });

  it("wrangler.jsonc (the self-hosted default) declares no `routes`", () => {
    expect(selfHosted).not.toHaveProperty("routes");
  });

  it("wrangler.hosted.jsonc does declare `routes` (sanity check the fixtures aren't both empty)", () => {
    expect(hosted).toHaveProperty("routes");
  });
});
