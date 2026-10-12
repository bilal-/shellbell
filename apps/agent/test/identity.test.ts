import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paths } from "../src/config.js";
import * as identities from "../src/identity.js";

/** Lets a test run code while this process is generating its keys. */
const generation = vi.hoisted(() => ({ during: null as null | (() => void) }));
vi.mock("@shellbell/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellbell/protocol")>();
  return {
    ...actual,
    generateIdentity: () => {
      const identity = actual.generateIdentity();
      const during = generation.during;
      generation.during = null;
      during?.();
      return identity;
    },
  };
});

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

describe("loadOrCreateIdentity on a first start", () => {
  it("keeps the identity another process saved first", async () => {
    const p = fixture();
    const { generateIdentity, identityToJson, fingerprint } = await import("@shellbell/protocol");
    const winner = generateIdentity();
    generation.during = () =>
      writeFileSync(p.identity, JSON.stringify(identityToJson(winner)), { mode: 0o600 });
    const loaded = identities.loadOrCreateIdentity(p);
    expect(loaded.fp).toBe(fingerprint(winner.ed25519.pub));
    expect(identities.readIdentity(p)?.fp).toBe(loaded.fp);
  });
});
