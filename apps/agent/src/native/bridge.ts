import type { Readable, Writable } from "node:stream";
import { ControlLineDecoder, encodeControlLine } from "../control-framing.js";
import type { NativeCoordinator } from "./coordinator.js";
import {
  NativeControllerError,
  NativeDataSchemas,
  NativeErrorCodeSchema,
  type NativeEvent,
  NativeEventSchema,
  NativeRequestSchema,
} from "./protocol.js";

export function runNativeBridge(
  input: Readable,
  output: Writable,
  coordinator: NativeCoordinator,
  options: { agentVersion: string },
): { close(): Promise<void> } {
  let closed = false,
    hello = false,
    lastId = 0,
    pending = false,
    opening = false;
  let early: NativeEvent | undefined;
  let flow: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearTimeout(timer);
    unsubscribe();
    input.off("data", data);
    input.off("end", finish);
    input.destroy();
    closing = Promise.resolve(coordinator.close()).finally(() => {
      output.end();
    });
    // EventEmitter callbacks cannot await; callers still receive the rejection.
    void closing.catch(() => {});
    return closing;
  };
  const send = (value: unknown): boolean => {
    if (closed) return false;
    const frame = encodeControlLine(value);
    const queued = output.writableLength;
    if (
      !frame ||
      output.destroyed ||
      !Number.isFinite(queued) ||
      queued < 0 ||
      queued + frame.byteLength > 262144
    ) {
      close();
      return false;
    }
    try {
      output.write(frame);
    } catch {
      close();
      return false;
    }
    return true;
  };
  const fail = (id: number, code: string) => send({ v: 1, id, ok: false, error: { code } });
  const unsubscribe = coordinator.onEvent((value) => {
    const parsed = NativeEventSchema.safeParse(value);
    if (!parsed.success) {
      close();
      return;
    }
    if (opening) {
      if (early) close();
      else early = parsed.data;
      return;
    }
    if (parsed.data.flowId !== flow) {
      close();
      return;
    }
    send(parsed.data);
    if (parsed.data.event === "pairing.closed") flow = undefined;
  });
  const decoder = new ControlLineDecoder({
    onError: close,
    onLine(line) {
      if (closed) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        close();
        return;
      }
      const parsed = NativeRequestSchema.safeParse(value);
      if (!parsed.success) {
        if (
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          typeof value.id === "number" &&
          Number.isSafeInteger(value.id) &&
          value.id > lastId
        ) {
          fail(value.id, "v" in value && value.v !== 1 ? "unsupported-version" : "bad-request");
        }
        close();
        return;
      }
      const request = parsed.data;
      if (request.id <= lastId) {
        close();
        return;
      }
      lastId = request.id;
      if (!hello) {
        if (request.cmd !== "hello") {
          fail(request.id, "handshake-required");
          close();
          return;
        }
        hello = true;
        clearTimeout(timer);
        send({
          v: 1,
          id: request.id,
          ok: true,
          data: NativeDataSchemas.hello.parse({
            version: 1,
            agentVersion: options.agentVersion,
            capabilities: ["status", "settings", "lifecycle", "pairing", "devices", "diagnostics"],
          }),
        });
        return;
      }
      if (request.cmd === "hello") {
        close();
        return;
      }
      if (pending) {
        fail(request.id, "busy");
        close();
        return;
      }
      pending = true;
      opening = request.cmd === "pairing.open";
      const mutation = "args" in request;
      timer = setTimeout(
        () => {
          fail(request.id, mutation ? "delivery-unknown" : "timeout");
          close();
        },
        request.cmd.startsWith("service.") ||
          request.cmd.startsWith("desktop.") ||
          request.cmd.startsWith("ownership.")
          ? 60000
          : 5000,
      );
      void coordinator
        .execute(request)
        .then(
          (result) => {
            if (closed) return;
            const checked = NativeDataSchemas[request.cmd].safeParse(result);
            if (!checked.success) {
              fail(request.id, mutation ? "delivery-unknown" : "operation-failed");
              close();
              return;
            }
            if (request.cmd === "pairing.open") flow = (checked.data as { flowId: string }).flowId;
            if (!encodeControlLine({ v: 1, id: request.id, ok: true, data: checked.data })) {
              fail(request.id, "response-too-large");
              close();
              return;
            }
            send({ v: 1, id: request.id, ok: true, data: checked.data });
            opening = false;
            if (early) {
              if (early.flowId !== flow) {
                close();
                return;
              }
              send(early);
              if (early.event === "pairing.closed") flow = undefined;
              early = undefined;
            }
          },
          (error) => {
            const code =
              error instanceof NativeControllerError &&
              NativeErrorCodeSchema.safeParse(error.code).success
                ? error.code
                : "operation-failed";
            fail(request.id, code);
            opening = false;
            early = undefined;
          },
        )
        .finally(() => {
          clearTimeout(timer);
          pending = false;
        });
    },
  });
  const data = (chunk: Buffer) => decoder.push(chunk);
  const finish = () => {
    decoder.finish();
    close();
  };
  input.on("data", data);
  input.once("end", finish);
  input.once("error", close);
  output.once("error", close);
  timer = setTimeout(close, 5000);
  return { close };
}
