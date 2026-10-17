import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRunningHerdrServer } from "../src/backends/herdr/executable.js";

const always = () => true;

describe("findRunningHerdrServer on macOS", () => {
  const ps = (table: string, comm: Record<string, string>) => async (args: string[]) => {
    if (args.includes("pid=,args=")) return table;
    const pids = args.at(-1)!.split(",");
    return pids.map((pid) => comm[pid] ?? "").join("\n");
  };

  it("names the program of this user's server, including a path with spaces", async () => {
    const table = [
      "  101 /Users/me/.local/bin/herdr",
      "  102 /Users/me/My Tools/herdr server",
      "  103 herdr server stop",
      "  104 /bin/zsh -c herdr server",
    ].join("\n");
    const found = await findRunningHerdrServer({
      platform: "darwin",
      ps: ps(table, { "102": "/Users/me/My Tools/herdr" }),
      executable: always,
    });
    expect(found).toBe("/Users/me/My Tools/herdr");
  });

  it("ignores a shell whose command line ends with a server command", async () => {
    // A wrapper such as `sh -c '…; /opt/custom/herdr server'` waits beside the server itself.
    const table = [
      "  201 /bin/sh -c trap true TERM; /opt/custom/herdr server",
      "  202 /opt/custom/herdr server",
    ].join("\n");
    const found = await findRunningHerdrServer({
      platform: "darwin",
      ps: ps(table, { "201": "/bin/sh", "202": "/opt/custom/herdr" }),
      executable: always,
    });
    expect(found).toBe("/opt/custom/herdr");
  });

  it("gives up when servers from different programs run, or none does", async () => {
    const two = "1 /a/herdr server\n2 /b/herdr server\n";
    const options = { platform: "darwin" as const, executable: always };
    expect(
      await findRunningHerdrServer({
        ...options,
        ps: ps(two, { "1": "/a/herdr", "2": "/b/herdr" }),
      }),
    ).toBeUndefined();
    expect(
      await findRunningHerdrServer({
        ...options,
        ps: ps(two, { "1": "/a/herdr", "2": "/a/herdr" }),
      }),
    ).toBe("/a/herdr");
    expect(
      await findRunningHerdrServer({ ...options, ps: ps("1 /a/herdr\n", {}) }),
    ).toBeUndefined();
    expect(
      await findRunningHerdrServer({
        ...options,
        ps: async () => {
          throw new Error("ps failed");
        },
      }),
    ).toBeUndefined();
  });
});

describe("findRunningHerdrServer on Linux", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function proc(pid: string, argv: string[], exe: string) {
    mkdirSync(join(root, "proc", pid), { recursive: true });
    writeFileSync(join(root, "proc", pid, "cmdline"), `${argv.join("\0")}\0`);
    symlinkSync(exe, join(root, "proc", pid, "exe"));
  }

  it("reads the server's executable link, skipping clients and replaced programs", async () => {
    root = mkdtempSync(join(tmpdir(), "shellbell-proc-"));
    const program = join(root, "linuxbrew", "herdr");
    mkdirSync(join(root, "linuxbrew"));
    writeFileSync(program, "#!/bin/sh\n");
    chmodSync(program, 0o755);
    proc("7", ["herdr", "server"], program);
    proc("8", ["herdr"], join(root, "elsewhere", "herdr"));
    proc("9", ["herdr", "server"], `${join(root, "old", "herdr")} (deleted)`);
    writeFileSync(join(root, "proc", "self"), "");
    expect(await findRunningHerdrServer({ platform: "linux", procRoot: join(root, "proc") })).toBe(
      program,
    );
  });
});
