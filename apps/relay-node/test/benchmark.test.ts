import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

const run = (args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", "bench/run.mjs", ...args], {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
it("rejects non-loopback destinations and unsafe load parameters", () => {
  for (const args of [
    ["--host", "example.com"],
    ["--computers", "0"],
  ]) {
    let failure: unknown;
    try {
      run([...args]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 1, stdout: "" });
    const stderr = String((failure as { stderr: unknown }).stderr);
    expect(stderr.trim()).toBe(
      "Synthetic benchmark failed; check loopback-only options and local runtime",
    );
    expect(stderr).not.toMatch(/ExponentPushToken|ed25519|example\.com/);
  }
});
it("reports received synthetic traffic and separately scoped process and database metrics", () => {
  const report = JSON.parse(run(["--duration", "1", "--warmup", "0.2", "--repeat", "1"]));
  expect(report.synthetic).toBe(true);
  expect(report.runs[0].received.frames).toBeGreaterThan(0);
  expect(report.runs[0].received.bytes).toBeGreaterThan(0);
  expect(report.runs[0].server.scope).toBe("relay child process only");
  expect(report.runs[0].generator.scope).toBe("load generator process only");
  // Authentication happens before measurement; steady ciphertext forwarding
  // must not read storage just to recalculate unchanged deadlines.
  expect(report.runs[0].server.database.count).toBe(0);
  expect(report.runs[0].server.queues.peakBytes).toBeGreaterThan(0);
  expect(report.runs[0].forwardingMs.p99).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toMatch(/ExponentPushToken|ed25519|\/Users\//);
}, 30000);

it("reports flood admission closures during measurement after a separate gentle warmup", () => {
  const report = JSON.parse(
    run(["--scenario", "small-frame", "--fps", "1000", "--duration", "1", "--repeat", "1"]),
  );
  expect(report.runs[0].received.frames).toBeGreaterThan(0);
  expect(report.runs[0].closes[4429]).toBeGreaterThan(0);
  expect(report.runs[0].server.closeRequests[4429]).toBeGreaterThan(0);
});

it("measures reconnects with synthetic phone identities", () => {
  const report = JSON.parse(
    run(["--scenario", "reconnect", "--fps", "20", "--duration", "1", "--repeat", "1"]),
  );
  expect(report.runs[0].reconnects).toBeGreaterThan(0);
  expect(report.runs[0].reconnectAttempts).toBe(report.runs[0].reconnects);
  // Keep a positive control: reconnect authentication still queries storage.
  expect(report.runs[0].server.database.count).toBeGreaterThan(0);
  expect(report.runs[0].received.frames).toBeGreaterThan(0);
});
