import type { ScreenSnapshot } from "@shellbell/protocol";
import { useConnectionsStore } from "../store/connections";
import { networkSource } from "../store/network";
import type { ComputerConnection } from "./connection";
import { connectionManager } from "./manager";

async function until(check: () => boolean, signal: AbortSignal, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (signal.aborted || Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(signal.aborted ? "Qualification cancelled" : "Qualification timed out"));
      } else if (check()) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}

function containsOutput(screen: Readonly<ScreenSnapshot> | undefined, marker: string): boolean {
  return (
    screen?.lines.some(
      (line) =>
        line.r
          .map((run) => run.t)
          .join("")
          .trim() === marker,
    ) ?? false
  );
}

/** Owner-only device check: input is sent exclusively to the newly created fixture tab. */
export async function qualifyTransport(
  fp: string,
  signal: AbortSignal,
  report: (stage: string) => void,
  scenario: "recovery" | "handoff" | "offline" = "recovery",
): Promise<void> {
  if (process.env.EXPO_PUBLIC_SHELLBELL_DIRECT !== "1") throw new Error("Owner build required");
  let fixture: string | null = null;
  let lease: ReturnType<typeof connectionManager.claimView> | null = null;
  let connection: ComputerConnection | undefined;
  const state = () => useConnectionsStore.getState().read(fp);
  const request = async (message: Parameters<ComputerConnection["request"]>[0]) => {
    let settled = false;
    let result: Awaited<ReturnType<ComputerConnection["request"]>> | undefined;
    let failure: unknown;
    const pending = connection!.request(message).then(
      (ack) => {
        result = ack;
        settled = true;
      },
      (error: unknown) => {
        failure = error;
        settled = true;
      },
    );
    await until(() => settled, signal);
    await pending;
    if (failure) throw failure;
    const ack = result!;
    if (!ack.ok) throw new Error(`Fixture request failed: ${ack.error ?? "unknown"}`);
    return ack;
  };
  try {
    report("Waiting for authenticated direct route");
    await until(
      () => connectionManager.get(fp)?.activeRoute === "direct" && state().status === "online",
      signal,
    );
    connection = connectionManager.get(fp)!;
    const existing = new Set(state().sessions.map((session) => session.id));
    if (
      !state().hello?.backends.some(
        (backend) => backend.name === "iterm2" && backend.capabilities.createSession,
      )
    )
      throw new Error("Disposable fixture requires iTerm2");
    const created = await request({
      type: "session.create",
      reqId: connection.newReqId(),
      in: { kind: "tab", backend: "iterm2" },
    });
    if (!created.sessionId || existing.has(created.sessionId))
      throw new Error("Fixture did not create a new session");
    fixture = created.sessionId;
    lease = connectionManager.claimView(fp, fixture);
    await until(
      () =>
        state().boundedView?.sessionId === fixture &&
        state().boundedView?.snapshot.status === "live",
      signal,
    );
    const checkOutput = async (marker: string) => {
      // The marker is split in the command so terminal echo cannot satisfy the output check.
      const split = marker.lastIndexOf("_");
      await request({
        type: "input.line",
        reqId: connection!.newReqId(),
        sessionId: fixture!,
        text: `printf '\\n%s%s\\n' '${marker.slice(0, split)}' '${marker.slice(split)}'`,
      });
      await until(() => containsOutput(state().boundedView?.snapshot.screen, marker), signal);
    };
    report("Checking direct input and screen without relay terminal bytes");
    const before = connection.transportDiagnostics;
    await checkOutput("SHELLBELL_DIRECT_FIXTURE_A");
    const after = connection.transportDiagnostics;
    if (
      after.relaySent !== before.relaySent ||
      after.relayReceived !== before.relayReceived ||
      after.directSent <= before.directSent ||
      after.directReceived <= before.directReceived
    )
      throw new Error("Direct traffic accounting failed");

    if (scenario !== "recovery") {
      const waitForNetwork = async (type: string) => {
        await until(
          () =>
            networkSource.current().type === type && networkSource.current().internet === "online",
          signal,
        );
        await until(
          () => state().status === "online" && state().boundedView?.snapshot.status === "live",
          signal,
        );
      };
      if (scenario === "handoff") {
        report("HANDOFF: waiting for cellular");
        await waitForNetwork("CELLULAR");
        await checkOutput("SHELLBELL_CELLULAR_FIXTURE");
        report(
          `HANDOFF: cellular input/screen passed via ${connection.activeRoute}; waiting for Wi-Fi`,
        );
        await waitForNetwork("WIFI");
        await checkOutput("SHELLBELL_WIFI_RETURN_FIXTURE");
      }
      report("HANDOFF: Wi-Fi input/screen passed; waiting for no network");
      await until(
        () => networkSource.current().disconnected && state().status === "offline",
        signal,
      );
      if (
        connection.send({
          type: "input.line",
          reqId: connection.newReqId(),
          sessionId: fixture,
          text: "",
        })
      )
        throw new Error("Offline input was admitted");
      report("HANDOFF: offline input blocked; waiting for internet");
      await waitForNetwork("WIFI");
      await checkOutput("SHELLBELL_NETWORK_RESTORED_FIXTURE");
      report("HANDOFF: restored input/screen passed");
    } else {
      report("Checking direct input and screen while relay is interrupted");
      connection.testTransport("pause-relay");
      await checkOutput("SHELLBELL_DIRECT_FIXTURE_B");
      if (connection.activeRoute !== "direct") throw new Error("Direct route lost with relay");
      connection.testTransport("resume-relay");
      report("Checking periodic WebRTC retry after a failed recovery attempt");
      const previousGeneration = connection.handshakeGeneration;
      connection.testTransport("fail-next-direct");
      connection.testTransport("interrupt-direct");
      await until(() => connection?.activeRoute === "relay" && state().status === "online", signal);
      await until(
        () =>
          connection?.activeRoute === "direct" &&
          connection.handshakeGeneration > previousGeneration &&
          state().boundedView?.snapshot.status === "live",
        signal,
      );
      await checkOutput("SHELLBELL_DIRECT_FIXTURE_D");
      report("Dropping direct route and checking fresh encrypted relay recovery");
      connection.testTransport("drop-direct");
      await until(
        () =>
          connection?.activeRoute === "relay" &&
          state().status === "online" &&
          state().boundedView?.snapshot.status === "live",
        signal,
      );
      const relayBefore = connection.transportDiagnostics;
      await checkOutput("SHELLBELL_DIRECT_FIXTURE_C");
      const relayAfter = connection.transportDiagnostics;
      if (
        relayAfter.relaySent <= relayBefore.relaySent ||
        relayAfter.relayReceived <= relayBefore.relayReceived
      )
        throw new Error("Relay recovery traffic accounting failed");
    }
  } finally {
    connection?.testTransport("resume-relay");
    lease?.release();
    if (fixture) {
      // The operator may be restoring networks after a failed drill. Keep the
      // owned ID until a fresh connection can close this fixture safely.
      const cleanupSignal = new AbortController().signal;
      await until(() => connectionManager.get(fp)?.online === true, cleanupSignal, 60_000);
      connection = connectionManager.get(fp)!;
      connection.send({
        type: "input.line",
        reqId: connection.newReqId(),
        sessionId: fixture,
        text: "exit",
      });
      await until(() => !state().sessions.some((session) => session.id === fixture), cleanupSignal);
    }
  }
  report(
    scenario === "recovery"
      ? "PASS: direct input/screen, zero relay terminal bytes, relay interruption, periodic WebRTC retry, encrypted fallback; fixture closed"
      : `PASS: direct Wi-Fi, ${scenario === "handoff" ? "cellular/Wi-Fi handoff, " : ""}offline input blocked, restored input/screen; fixture closed`,
  );
}
