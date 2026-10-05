import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paths } from "../src/config.js";
import * as identities from "../src/identity.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sb-identity-"));
  dirs.push(dir);
  return paths(join(dir, "state"));
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("readIdentity", () => {
  it("returns null without creating missing state", () => {
    const p = fixture();
    expect(identities.readIdentity?.(p)).toBe(null);
    expect(existsSync(p.dir)).toBe(false);
  });
  it("reads the existing fingerprint without rewriting its keys", () => {
    const p = fixture();
    const created = identities.loadOrCreateIdentity(p);
    const bytes = readFileSync(p.identity);
    expect(identities.readIdentity?.(p)?.fp).toBe(created.fp);
    expect(readFileSync(p.identity)).toEqual(bytes);
  });
  it("does not include malformed identity contents in errors", () => {
    const p = fixture();
    identities.loadOrCreateIdentity(p);
    writeFileSync(p.identity, '{"PRIVATE_SENTINEL"');
    expect(() => identities.readIdentity?.(p)).toThrow(/invalid identity/);
    try {
      identities.readIdentity?.(p);
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_SENTINEL");
    }
  });
});
