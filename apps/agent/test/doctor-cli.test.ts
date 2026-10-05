import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDoctorCommand, printDoctorResult } from "../src/cli.js";
import type { Check } from "../src/doctor.js";

const blockedDefaultDoctor = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("BLOCKED_DEFAULT_DOCTOR");
  }),
);
vi.mock("../src/doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/doctor.js")>()),
  runDoctor: blockedDefaultDoctor,
}));

const failingChecks: Check[] = [
  { name: "identity", ok: false, severity: "error", detail: "missing" },
];

async function invokeDoctorAction(
  json: boolean,
  checks: Check[],
  args: string[] = [],
  failure = false,
) {
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
  const prior = process.exitCode;
  process.exitCode = 0;
  const runDoctor = vi.fn(async () => {
    if (failure) throw new Error("PRIVATE_SENTINEL");
    return checks;
  });
  const program = new Command().option("--json");
  program.exitOverride();
  addDoctorCommand(program, { runDoctor, defaultStateDir: "/unused", env: {} });
  try {
    await program.parseAsync([...(json ? ["--json"] : []), "doctor", ...args], {
      from: "user",
    });
    return { code: process.exitCode, output, runDoctor };
  } finally {
    log.mockRestore();
    process.exitCode = prior;
  }
}

describe("doctor command", () => {
  afterEach(() => {
    expect(blockedDefaultDoctor).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("JSON output propagates a failed check exit", () => {
    const output: string[] = [];
    const exits: number[] = [];
    printDoctorResult(
      failingChecks,
      true,
      (line) => output.push(line),
      (code) => {
        exits.push(code);
      },
    );
    expect(JSON.parse(output[0]!)).toEqual(failingChecks);
    expect(exits).toEqual([1]);
  });

  it.each([true, false])("failed checks return 1 in JSON=%s", async (json) => {
    const result = await invokeDoctorAction(json, failingChecks);
    expect(result.code).toBe(1);
    expect(result.output).toHaveLength(1);
    if (json) expect(JSON.parse(result.output[0]!)).toEqual(failingChecks);
    else expect(result.output[0]).toContain("identity");
  });

  it("optional warnings return 0 and retain JSON array shape", async () => {
    const checks: Check[] = [
      { name: "tmux", ok: true, severity: "warning", detail: "not installed" },
      { name: "herdr", ok: true, severity: "pass", detail: "connected" },
    ];
    const result = await invokeDoctorAction(true, checks);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output[0]!)).toEqual(checks);
    const text = await invokeDoctorAction(false, checks);
    expect(text.code).toBe(0);
    expect(text.output[0]).toContain("! tmux");
  });

  it("deduplicates repeatable required backends", async () => {
    const result = await invokeDoctorAction(
      true,
      [],
      ["--require-backend", "tmux", "--require-backend", "tmux", "--require-backend", "herdr"],
    );
    expect(result.runDoctor).toHaveBeenCalledWith(
      expect.objectContaining({ requiredBackends: ["tmux", "herdr"] }),
    );
  });

  it("passes reverse-order required backends in canonical backend order", async () => {
    const result = await invokeDoctorAction(
      true,
      [],
      ["--require-backend", "herdr", "--require-backend", "iterm2", "--require-backend", "herdr"],
    );
    expect(result.runDoctor).toHaveBeenCalledWith(
      expect.objectContaining({ requiredBackends: ["iterm2", "herdr"] }),
    );
  });

  it("rejects invalid required backend without running probes", async () => {
    const result = await invokeDoctorAction(true, [], ["--require-backend", "PRIVATE_SENTINEL"]);
    expect(result.code).toBe(2);
    expect(result.runDoctor).not.toHaveBeenCalled();
    expect(JSON.parse(result.output[0]!)).toEqual([
      expect.objectContaining({ severity: "error", ok: false }),
    ]);
    expect(result.output[0]).not.toContain("PRIVATE_SENTINEL");
    const text = await invokeDoctorAction(false, [], ["--require-backend", "PRIVATE_SENTINEL"]);
    expect(text.code).toBe(2);
    expect(text.runDoctor).not.toHaveBeenCalled();
    expect(text.output[0]).not.toContain("PRIVATE_SENTINEL");
  });

  it("rejects a missing required-backend value as structured usage error", async () => {
    const result = await invokeDoctorAction(true, [], ["--require-backend"]);
    expect(result.code).toBe(2);
    expect(result.runDoctor).not.toHaveBeenCalled();
    expect(JSON.parse(result.output[0]!)).toEqual([
      expect.objectContaining({ name: "doctor arguments", severity: "error" }),
    ]);
  });

  it("keeps unexpected diagnostic failure structured and private in JSON mode", async () => {
    const result = await invokeDoctorAction(true, [], [], true);
    expect(result.code).toBe(1);
    expect(result.output).toHaveLength(1);
    expect(JSON.parse(result.output[0]!)).toEqual([
      expect.objectContaining({ name: "doctor", severity: "error", ok: false }),
    ]);
    expect(result.output[0]).not.toContain("PRIVATE_SENTINEL");
  });
});
