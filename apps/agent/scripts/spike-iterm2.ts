/* Spike: talk to the iTerm2 API from Node. Run with `pnpm spike:iterm2`.
 * Prints sessions, the first session's styled screen, GetBuffer latency, and writes
 * fixtures to test/fixtures/. Set ITERM2_SPIKE_SEND=1 to also send a harmless echo. */
import { mkdir, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import WebSocket from "ws";
import { requestCookieAndKey } from "../src/backends/iterm2/auth.js";
import {
  ClientOriginatedMessageSchema,
  GetBufferRequestSchema,
  LineRangeSchema,
  ListSessionsRequestSchema,
  SendTextRequestSchema,
  type ServerOriginatedMessage,
  ServerOriginatedMessageSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";

const SOCKET = join(homedir(), "Library", "Application Support", "iTerm2", "private", "socket");
const HEADERS_BASE = {
  origin: "ws://localhost/",
  "x-iterm2-library-version": "shellbell 0.0.1",
  "x-iterm2-disable-auth-ui": "true",
  "x-iterm2-advisory-name": "Shellbell",
};

async function connect(): Promise<WebSocket> {
  const { cookie, key } = await requestCookieAndKey("Shellbell");
  const headers = { ...HEADERS_BASE, "x-iterm2-cookie": cookie, "x-iterm2-key": key };
  const mode = process.env.ITERM2_SPIKE_MODE ?? "socketpath";
  // NOTE: ws@8.21.3's constructor-level `socketPath` option is discarded unconditionally
  // by initAsClient (it is only honored when parsed out of a `ws+unix://` URL), and the
  // `unix-url` mode's `ws+unix://${encodeURI(SOCKET)}:/` breaks because the WHATWG URL
  // parser percent-encodes the space in "Application Support" and ws never decodes it
  // back before using it as a filesystem path. `socketpath` mode instead uses `ws`'s
  // documented `createConnection` hook to dial the real Unix domain socket directly,
  // sidestepping URL parsing entirely.
  const ws =
    mode === "socketpath"
      ? new WebSocket("ws://localhost/", ["api.iterm2.com"], {
          headers,
          createConnection: () => netConnect({ path: SOCKET }),
        })
      : new WebSocket(`ws+unix://${encodeURI(SOCKET)}:/`, ["api.iterm2.com"], { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return ws;
}

let nextId = 1n;
const pending = new Map<bigint, (m: ServerOriginatedMessage) => void>();

function request(
  ws: WebSocket,
  submessage: { case: string; value: unknown },
): Promise<ServerOriginatedMessage> {
  const id = nextId++;
  const msg = create(ClientOriginatedMessageSchema, { id, submessage: submessage as never });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for response ${id}`));
    }, 5000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    ws.send(toBinary(ClientOriginatedMessageSchema, msg));
  });
}

async function main() {
  const ws = await connect();
  console.log("connected via", process.env.ITERM2_SPIKE_MODE ?? "socketpath");
  ws.on("message", (data: Buffer) => {
    const m = fromBinary(ServerOriginatedMessageSchema, new Uint8Array(data));
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    } else if (m.submessage.case === "notification") {
      console.log(
        "notification:",
        JSON.stringify(toJson(ServerOriginatedMessageSchema, m)).slice(0, 200),
      );
    }
  });

  // 1. sessions
  const ls = await request(ws, {
    case: "listSessionsRequest",
    value: create(ListSessionsRequestSchema, {}),
  });
  if (ls.submessage.case !== "listSessionsResponse")
    throw new Error(`unexpected ${ls.submessage.case}`);
  const sessions: { id: string; title: string; w: number; h: number; tmux: string }[] = [];
  for (const win of ls.submessage.value.windows) {
    for (const tab of win.tabs) {
      const walk = (node: typeof tab.root): void => {
        if (!node) return;
        for (const link of node.links) {
          if (link.child.case === "session") {
            const s = link.child.value;
            sessions.push({
              id: s.uniqueIdentifier ?? "",
              title: s.title ?? "",
              w: s.gridSize?.width ?? 0,
              h: s.gridSize?.height ?? 0,
              tmux: tab.tmuxWindowId ?? "",
            });
          } else if (link.child.case === "node") walk(link.child.value);
        }
      };
      walk(tab.root);
    }
  }
  console.log(`${sessions.length} sessions:`);
  for (const s of sessions)
    console.log(`  ${s.id}  ${s.w}x${s.h}  ${s.title}${s.tmux ? `  (tmux ${s.tmux})` : ""}`);
  const target = sessions[0];
  if (!target) throw new Error("no sessions");

  // 2. styled screen of the first session
  const getBuffer = () =>
    request(ws, {
      case: "getBufferRequest",
      value: create(GetBufferRequestSchema, {
        session: target.id,
        lineRange: create(LineRangeSchema, { screenContentsOnly: true }),
        includeStyles: true,
      }),
    });
  const first = await getBuffer();
  if (first.submessage.case !== "getBufferResponse") throw new Error("bad buffer response");
  const resp = first.submessage.value;
  console.log(
    `status=${resp.status} lines=${resp.contents.length} cursor=${resp.cursor?.x},${resp.cursor?.y} firstLine=${resp.windowedCoordRange?.coordRange?.start?.y}`,
  );
  for (const line of resp.contents.slice(0, 5)) {
    console.log(
      JSON.stringify(line.text).slice(0, 100),
      "styles:",
      line.style.length,
      "cpc:",
      line.codePointsPerCell.length,
    );
  }

  // 3. latency
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await getBuffer();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p = (q: number) =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]?.toFixed(1);
  console.log(
    `GetBuffer latency ms: p50=${p(0.5)} p95=${p(0.95)} max=${samples.at(-1)?.toFixed(1)}`,
  );

  // 4. fixtures
  const dir = join(import.meta.dirname, "..", "test", "fixtures");
  await mkdir(dir, { recursive: true });
  const stamp = Date.now();
  await writeFile(
    join(dir, `getbuffer-${stamp}.json`),
    JSON.stringify(toJson(ServerOriginatedMessageSchema, first), null, 2),
  );
  await writeFile(
    join(dir, `listsessions-${stamp}.json`),
    JSON.stringify(toJson(ServerOriginatedMessageSchema, ls), null, 2),
  );
  console.log("fixtures written to", dir);

  // 5. optional send
  if (process.env.ITERM2_SPIKE_SEND === "1") {
    const st = await request(ws, {
      case: "sendTextRequest",
      value: create(SendTextRequestSchema, {
        session: target.id,
        text: "echo shellbell-spike-ok\r",
        suppressBroadcast: true,
      }),
    });
    console.log(
      "sendText:",
      st.submessage.case,
      JSON.stringify(toJson(ServerOriginatedMessageSchema, st)),
    );
  }
  ws.close();
}

main().catch((err) => {
  console.error("SPIKE FAILED:", err);
  process.exit(1);
});
