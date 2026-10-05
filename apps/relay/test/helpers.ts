import { SELF } from "cloudflare:test";
import { decodeEnvelope, type Envelope, encodeEnvelope, parseCtrl } from "@shellbell/protocol";
import {
  createScenarioClient,
  type Conn as ScenarioConn,
  type TestDevice,
} from "../../../packages/relay-core/test-support/client.js";

export { box, TestDevice } from "../../../packages/relay-core/test-support/client.js";

export interface Conn extends ScenarioConn {
  ws: WebSocket;
}

export async function connect(computerFp: string): Promise<Conn> {
  const res = await SELF.fetch(`https://relay.test/ws/${computerFp}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade failed: ${res.status}`);
  ws.accept();
  ws.binaryType = "arraybuffer";
  const queue: Uint8Array[] = [];
  interface Waiter {
    resolve(e: Uint8Array): void;
    reject(err: Error): void;
  }
  const waiters: Waiter[] = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") return;
    const env = new Uint8Array(ev.data as ArrayBuffer);
    const w = waiters.shift();
    if (w) w.resolve(env);
    else queue.push(env);
  });
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.addEventListener("close", (ev) => {
      resolve({ code: ev.code });
      for (const w of waiters.splice(0)) w.reject(new Error("socket closed"));
    });
  });
  const nextRaw = (timeoutMs = 2000) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const q = queue.shift();
      if (q) return resolve(q);
      const waiter: Waiter = {
        resolve: (e) => {
          clearTimeout(t);
          resolve(e);
        },
        reject: (err) => {
          clearTimeout(t);
          reject(err);
        },
      };
      const t = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        waiter.reject(new Error("timeout waiting for frame"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  const next = async (timeoutMs?: number): Promise<Envelope> =>
    decodeEnvelope(await nextRaw(timeoutMs));
  return {
    ws,
    next,
    nextRaw,
    nextCtrl: async (t) => parseCtrl((await next(t)).body),
    sendCtrl: (from, body) => ws.send(encodeEnvelope({ v: 1, t: "ctrl", from, seq: 0, body })),
    sendEnvelope: (e) => ws.send(encodeEnvelope(e)),
    sendRaw: (bytes) => ws.send(bytes),
    closed,
    close: () => ws.close(),
  };
}

const api = createScenarioClient(connect);
export const authenticate = api.authenticate;
export const agentOnline = api.agentOnline;
export function pairPhone(mac: TestDevice, agent: Conn, phone: TestDevice): Promise<void> {
  return api.pair(agent, mac, phone);
}
