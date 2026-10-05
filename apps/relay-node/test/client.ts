import { decodeEnvelope, encodeEnvelope, parseCtrl } from "@shellbell/protocol";
import WebSocket from "ws";
import type { Conn } from "../../../packages/relay-core/test-support/client.js";

export function connect(url: string, computerFp: string): Promise<Conn & { ws: WebSocket }> {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws/${computerFp}`);
  const queue: Uint8Array[] = [];
  const waiters: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }[] = [];
  let ended = false;
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const bytes = new Uint8Array(data as Buffer);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(bytes);
    else queue.push(bytes);
  });
  const closed = new Promise<{ code: number }>((resolve) =>
    ws.on("close", (code) => {
      ended = true;
      resolve({ code });
      for (const waiter of waiters.splice(0)) waiter.reject(new Error("socket closed"));
    }),
  );
  const nextRaw = (timeout = 2000) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const frame = queue.shift();
      if (frame) {
        resolve(frame);
        return;
      }
      if (ended) {
        reject(new Error("socket closed"));
        return;
      }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("timeout waiting for frame"));
      }, timeout);
      const waiter = {
        resolve: (value: Uint8Array) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      waiters.push(waiter);
    });
  const next = async (timeout?: number) => decodeEnvelope(await nextRaw(timeout));
  const conn = {
    ws,
    nextRaw,
    next,
    nextCtrl: async (timeout?: number) => parseCtrl((await next(timeout)).body),
    sendCtrl: (from: string, body: unknown) =>
      ws.send(encodeEnvelope({ v: 1, t: "ctrl", from, seq: 0, body })),
    sendEnvelope: (frame: Parameters<Conn["sendEnvelope"]>[0]) => ws.send(encodeEnvelope(frame)),
    sendRaw: (bytes: Uint8Array) => ws.send(bytes),
    closed,
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(conn));
    ws.on("error", reject);
  });
}
