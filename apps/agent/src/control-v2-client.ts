import { createConnection, type Socket } from "node:net";
import {
  CONTROL_LIMITS,
  ControlLineDecoder,
  encodeControlLine,
  writeControlLine,
} from "./control-framing.js";
import {
  type ControlPairingOpen,
  type ControlRuntime,
  ControlV2DataSchemas,
  type ControlV2ErrorCode,
  type ControlV2Event,
  ControlV2EventSchema,
  type ControlV2Request,
  ControlV2RequestSchema,
  ControlV2ResponseSchema,
} from "./control-v2-protocol.js";
import type { LocalStatus } from "./local-status.js";

export interface ControlV2Client {
  readonly runtime: ControlRuntime;
  status(): Promise<LocalStatus>;
  configurationRevision(): Promise<string | null>;
  devices(): Promise<LocalStatus["phones"]>;
  revoke(phoneFp: string): Promise<{ removed: boolean }>;
  openPairing(): Promise<ControlPairingOpen>;
  closePairing(flowId: string): Promise<void>;
  confirm(flowId: string, challengeId: string, phoneFp: string, accept: boolean): Promise<void>;
  close(): void;
}

type ErrorCode =
  | "unavailable"
  | "upgrade-required"
  | "protocol-error"
  | "timeout"
  | "delivery-unknown"
  | "busy"
  | "closed"
  | "server-error";
const messages: Record<ErrorCode, string> = {
  unavailable: "Local control unavailable",
  "upgrade-required": "Local control upgrade required",
  "protocol-error": "Local control protocol error",
  timeout: "Local control timed out",
  "delivery-unknown": "Local control mutation outcome unknown",
  busy: "Local control request already pending",
  closed: "Local control closed",
  "server-error": "Local control server rejected request",
};
export class ControlV2ClientError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly serverCode?: ControlV2ErrorCode,
  ) {
    super(messages[code]);
    this.name = "ControlV2ClientError";
  }
}

type Options = {
  connector?: (path: string) => Socket;
  onPairingRequest?: (event: Extract<ControlV2Event, { event: "pairing.request" }>) => void;
  onPairingClosed?: (event: Extract<ControlV2Event, { event: "pairing.closed" }>) => void;
  onDisconnect?: (error: ControlV2ClientError) => void;
};
type Command = ControlV2Request["cmd"];
type Data<C extends Command> = ReturnType<(typeof ControlV2DataSchemas)[C]["parse"]>;
type Pending = {
  id: number;
  command: Command;
  mutation: boolean;
  attempted: boolean;
  resolve: (data: unknown) => void;
  reject: (error: ControlV2ClientError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** One connection, one pending request, no retry or reconnect. Only opens the supplied socket. */
export function connectControlV2(path: string, options: Options = {}): Promise<ControlV2Client> {
  return new Promise((resolve, reject) => {
    let socket: Socket;
    try {
      socket = (options.connector ?? createConnection)(path);
    } catch {
      reject(new ControlV2ClientError("unavailable"));
      return;
    }
    let closed = false;
    let ready = false;
    let started = false;
    let lastId = 0;
    let pending: Pending | undefined;
    let expected: ControlRuntime | undefined;
    let ownedFlow: string | undefined;
    const connectTimer = setTimeout(
      () => disconnect(new ControlV2ClientError("timeout")),
      CONTROL_LIMITS.requestMs,
    );

    function disconnect(error: ControlV2ClientError) {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      const current = pending;
      pending = undefined;
      ownedFlow = undefined;
      if (current) {
        clearTimeout(current.timer);
        current.reject(
          current.mutation && current.attempted
            ? new ControlV2ClientError("delivery-unknown")
            : error,
        );
      }
      if (!ready) reject(error);
      socket.destroy();
      options.onDisconnect?.(error);
    }

    function request<C extends Command>(command: C, args?: unknown): Promise<Data<C>> {
      if (closed) return Promise.reject(new ControlV2ClientError("closed"));
      if (pending) return Promise.reject(new ControlV2ClientError("busy"));
      if (lastId === Number.MAX_SAFE_INTEGER) {
        disconnect(new ControlV2ClientError("protocol-error"));
        return Promise.reject(new ControlV2ClientError("protocol-error"));
      }
      const mutation =
        command !== "hello" &&
        command !== "status" &&
        command !== "status.config" &&
        command !== "devices";
      const parsed = ControlV2RequestSchema.safeParse({
        v: 2,
        id: lastId + 1,
        cmd: command,
        ...(mutation ? { expect: expected } : {}),
        ...(args === undefined ? {} : { args }),
      });
      if (!parsed.success) return Promise.reject(new ControlV2ClientError("protocol-error"));
      const bytes = encodeControlLine(parsed.data);
      if (bytes === null) return Promise.reject(new ControlV2ClientError("protocol-error"));
      // Establish refusal before the writer: its false return can also mean a thrown write.
      const queued = socket.writableLength;
      if (
        socket.destroyed ||
        !Number.isFinite(queued) ||
        queued < 0 ||
        queued + bytes.byteLength > CONTROL_LIMITS.queuedBytes
      ) {
        disconnect(new ControlV2ClientError("unavailable"));
        return Promise.reject(new ControlV2ClientError("unavailable"));
      }
      lastId++;
      return new Promise<Data<C>>((resolveRequest, rejectRequest) => {
        const current: Pending = {
          id: lastId,
          command,
          mutation,
          attempted: false,
          resolve: (data) => resolveRequest(data as Data<C>),
          reject: rejectRequest,
          timer: setTimeout(
            () => disconnect(new ControlV2ClientError("timeout")),
            CONTROL_LIMITS.requestMs,
          ),
        };
        pending = current;
        current.attempted = true;
        if (!writeControlLine(socket, bytes)) disconnect(new ControlV2ClientError("unavailable"));
      });
    }

    const decoder = new ControlLineDecoder({
      onError: () => disconnect(new ControlV2ClientError("protocol-error")),
      onLine: (line) => {
        if (closed) return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          disconnect(new ControlV2ClientError("protocol-error"));
          return;
        }
        if (typeof value === "object" && value !== null && "event" in value) {
          const parsed = ControlV2EventSchema.safeParse(value);
          if (!parsed.success) {
            disconnect(new ControlV2ClientError("protocol-error"));
            return;
          }
          const event = parsed.data;
          // An opening flow can close before the server returns its typed open failure.
          if (event.event === "pairing.closed" && event.flowId !== ownedFlow) return;
          if (event.flowId !== ownedFlow) {
            disconnect(new ControlV2ClientError("protocol-error"));
            return;
          }
          if (event.event === "pairing.closed") {
            ownedFlow = undefined;
            options.onPairingClosed?.(event);
          } else options.onPairingRequest?.(event);
          return;
        }
        const current = pending;
        if (
          current?.command === "hello" &&
          typeof value === "object" &&
          value !== null &&
          !("v" in value) &&
          "ok" in value &&
          typeof value.ok === "boolean"
        ) {
          disconnect(new ControlV2ClientError("upgrade-required"));
          return;
        }
        const response = ControlV2ResponseSchema.safeParse(value);
        if (!response.success || !current || response.data.id !== current.id) {
          disconnect(new ControlV2ClientError("protocol-error"));
          return;
        }
        if (!response.data.ok) {
          clearTimeout(current.timer);
          pending = undefined;
          const error = new ControlV2ClientError("server-error", response.data.error.code);
          current.reject(error);
          if (current.command === "hello") disconnect(error);
          return;
        }
        const parsed = ControlV2DataSchemas[current.command].safeParse(response.data.data);
        if (!parsed.success) {
          disconnect(new ControlV2ClientError("protocol-error"));
          return;
        }
        // Must happen synchronously: the next frame in this read may be a consent event.
        if (current.command === "pairing.open")
          ownedFlow = (parsed.data as ControlPairingOpen).flowId;
        clearTimeout(current.timer);
        pending = undefined;
        current.resolve(parsed.data);
      },
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("error", () => disconnect(new ControlV2ClientError("unavailable")));
    const finish = () => {
      decoder.finish();
      disconnect(new ControlV2ClientError("unavailable"));
    };
    socket.once("end", finish);
    socket.once("close", finish);
    const start = () => {
      if (closed || started) return;
      started = true;
      clearTimeout(connectTimer);
      void request("hello").then(
        (data) => {
          if (closed) return;
          expected = { ...data.runtime };
          ready = true;
          resolve({
            runtime: { ...data.runtime },
            status: () => request("status"),
            configurationRevision: async () => {
              try {
                return (await request("status.config")).revision;
              } catch (error) {
                if (
                  error instanceof ControlV2ClientError &&
                  error.code === "server-error" &&
                  error.serverCode === "bad-request"
                )
                  return null;
                throw error;
              }
            },
            devices: () => request("devices"),
            revoke: (phoneFp) => request("devices.revoke", { phoneFp }),
            openPairing: () => request("pairing.open"),
            closePairing: async (flowId) => {
              await request("pairing.close", { flowId });
            },
            confirm: async (flowId, challengeId, phoneFp, accept) => {
              await request("pairing.confirm", { flowId, challengeId, phoneFp, accept });
            },
            close: () => disconnect(new ControlV2ClientError("closed")),
          });
        },
        (error: ControlV2ClientError) => disconnect(error),
      );
    };
    socket.once("connect", start);
    if (!socket.connecting) start();
  });
}
