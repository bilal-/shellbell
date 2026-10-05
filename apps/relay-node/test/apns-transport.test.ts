import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import {
  type ClientHttp2Session,
  connect,
  createSecureServer,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { sendApns } from "@shellbell/relay-core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApnsHttp2Transport } from "../src/apns-transport.js";
import { temporaryDirectory } from "./helpers.js";

const dir = temporaryDirectory();
let key: Buffer;
let cert: Buffer;
beforeAll(() => {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-subj",
      "/CN=api.push.apple.com",
      "-addext",
      "subjectAltName=DNS:api.push.apple.com,DNS:api.sandbox.push.apple.com",
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(join(dir, "key.pem"));
  cert = readFileSync(join(dir, "cert.pem"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
async function localServer(
  run: (
    server: ReturnType<typeof createSecureServer>,
    transport: typeof fetch,
    owner: ReturnType<typeof createApnsHttp2Transport>,
    replacement: () => ReturnType<typeof createApnsHttp2Transport>,
  ) => Promise<void>,
  options: { trusted?: boolean; deadlineMs?: number; idleMs?: number; capacity?: number } = {},
) {
  const server = createSecureServer({
    key,
    cert,
    allowHTTP1: false,
    settings: { maxConcurrentStreams: options.capacity ?? 1000 },
  });
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
    session.on("close", () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const transports: ReturnType<typeof createApnsHttp2Transport>[] = [];
  const replacement = () => {
    const transport = createApnsHttp2Transport({
      deadlineMs: options.deadlineMs ?? 1000,
      idleMs: options.idleMs,
      connect: (authority, settings) => {
        expect(["https://api.push.apple.com", "https://api.sandbox.push.apple.com"]).toContain(
          String(authority),
        );
        expect(settings?.rejectUnauthorized).toBe(true);
        return connect(`https://127.0.0.1:${port}`, {
          ...settings,
          ...(options.trusted === false ? {} : { ca: cert }),
        });
      },
    });
    transports.push(transport);
    return transport;
  };
  const transport = replacement();
  try {
    await run(server, transport.fetch, transport, replacement);
  } finally {
    const closed = [...sessions].map((session) => once(session, "close"));
    for (const transport of transports) transport.close();
    await Promise.all(closed);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const url = "https://api.push.apple.com/3/device/abcdef";
const init = {
  method: "POST",
  headers: { authorization: "bearer synthetic", "apns-topic": "dev.example.app" },
  body: '{"aps":{"alert":"Ready"}}',
};
it("reuses one verified session for sequential requests", async () => {
  await localServer(async (server, transport) => {
    let sessions = 0;
    server.on("session", () => sessions++);
    server.on("stream", (stream: ServerHttp2Stream) => {
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
    expect(await (await transport(url, init)).text()).toBe("ok");
    expect(await (await transport(url, init)).text()).toBe("ok");
    expect(sessions).toBe(1);
  });
});
it("uses verified TLS HTTP/2 with exact APNs headers, body and response", async () => {
  await localServer(async (server, transport) => {
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      expect(stream.session?.alpnProtocol).toBe("h2");
      expect(headers[":authority"]).toBe("api.push.apple.com");
      expect(headers[":path"]).toBe("/3/device/abcdef");
      expect(headers[":method"]).toBe("POST");
      expect(headers["apns-topic"]).toBe("dev.example.app");
      let body = "";
      stream.on("data", (chunk) => {
        body += chunk;
      });
      stream.on("end", () => {
        expect(body).toBe(init.body);
        stream.respond({ ":status": 400, "retry-after": "12" });
        stream.end('{"reason":"BadDeviceToken"}');
      });
    });
    const response = await transport(url, init);
    expect(response.status).toBe(400);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.json()).toEqual({ reason: "BadDeviceToken" });
  });
});
it("rejects untrusted certificates without an HTTP/1 fallback", async () => {
  await localServer(
    async (_server, transport) => {
      await expect(transport(url, init)).rejects.toThrow();
    },
    { trusted: false },
  );
});
it.each([
  "http://api.push.apple.com/3/device/abc",
  "https://api.push.apple.com.evil.test/3/device/abc",
  "https://user@api.push.apple.com/3/device/abc",
  "https://api.push.apple.com:8443/3/device/abc",
  "https://api.push.apple.com/3/device/abc?leak=yes",
  "https://localhost/3/device/abc",
])("rejects non-APNs destinations before connecting: %s", async (target) => {
  const dial = vi.fn();
  await expect(createApnsHttp2Transport({ connect: dial }).fetch(target, init)).rejects.toThrow();
  expect(dial).not.toHaveBeenCalled();
});
it("aborts stalled response bodies and closes only the stream", async () => {
  await localServer(async (server, transport) => {
    const closed = new Promise<void>((resolve) =>
      server.once("stream", (stream) => stream.once("close", resolve)),
    );
    server.on("stream", (stream: ServerHttp2Stream) => {
      stream.respond({ ":status": 400 });
      stream.write("{");
    });
    const controller = new AbortController();
    const response = await transport(url, { ...init, signal: controller.signal });
    controller.abort();
    await expect(response.text()).rejects.toThrow();
    await closed;
  });
});
it("bounds both waiting for response headers and consuming a stalled body", async () => {
  for (const headers of [false, true])
    await localServer(
      async (server, transport) => {
        server.on("stream", (stream: ServerHttp2Stream) => {
          if (headers) {
            stream.respond({ ":status": 400 });
            stream.write("{");
          }
        });
        await expect(transport(url, init).then((response) => response.text())).rejects.toThrow();
      },
      { deadlineMs: 50 },
    );
});
it("bounds untrusted response bytes", async () => {
  await localServer(async (server, transport) => {
    server.on("stream", (stream: ServerHttp2Stream) => {
      stream.respond({ ":status": 400 });
      stream.end("x".repeat(16385));
    });
    await expect(transport(url, init).then((response) => response.text())).rejects.toThrow();
  });
});

it.each([
  [429, 90_000],
  [503, 900_000],
])(
  "preserves APNs HTTP %s backoff when the declared body exceeds the limit",
  async (status, retryAfterMs) => {
    await localServer(async (server, transport) => {
      let streamClosed!: Promise<unknown>;
      server.on("stream", (stream: ServerHttp2Stream) => {
        streamClosed = once(stream, "close");
        stream.respond({ ":status": status, "content-length": "16385", "retry-after": "90" });
        // Deliberately never send a body: the shared reader must reject from the head.
      });
      const now = 1_800_000_000_000;
      const outcome = await sendApns(
        {
          destination: { provider: "apns", token: "abcdef", environment: "production" },
          route: { computerFp: "computer", sessionId: "session", kind: "prompt" },
          genericTitle: "Shellbell",
          genericBody: "Ready",
          group: "group",
          expiresAtSeconds: now / 1000 + 120,
        },
        {
          teamId: "TEAM123456",
          keyId: "KEY1234567",
          topic: "dev.example.app",
          privateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString(),
        },
        transport,
        () => now,
      );
      expect(outcome).toEqual({ status: "retryable", code: "response-too-large", retryAfterMs });
      await streamClosed;
    });
  },
);

it("bounds declared oversized bodies for direct consumers while a sibling completes", async () => {
  await localServer(async (server, transport) => {
    let held!: ServerHttp2Stream;
    let admitted!: () => void;
    const siblingEntered = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      if (headers[":path"] === "/3/device/abc") {
        held = stream;
        admitted();
        return;
      }
      stream.respond({ ":status": 429, "content-length": "20000", "retry-after": "90" });
      stream.end("x".repeat(20000));
    });
    const sibling = transport("https://api.push.apple.com/3/device/abc", init);
    await siblingEntered;
    const response = await transport(url, init);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("90");
    const reader = response.body!.getReader();
    let bytes = 0;
    await expect(
      (async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          bytes += chunk.value.byteLength;
        }
      })(),
    ).rejects.toThrow();
    reader.releaseLock();
    expect(bytes).toBeLessThanOrEqual(16384);
    held.respond({ ":status": 200 });
    held.end("sibling");
    expect(await (await sibling).text()).toBe("sibling");
  });
});

it("destroys an unverified connection when its last request times out", async () => {
  const server = createTcpServer((socket) => socket.resume());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let session!: ClientHttp2Session;
  const transport = createApnsHttp2Transport({
    deadlineMs: 30,
    connect: (_authority, settings) => {
      session = connect(`https://127.0.0.1:${(server.address() as AddressInfo).port}`, settings);
      return session;
    },
  });
  try {
    await expect(transport.fetch(url, init)).rejects.toThrow();
    expect(session.destroyed).toBe(true);
  } finally {
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([false, true])("multiplexes concurrent streams (cancel one=%s)", async (cancel) => {
  await localServer(async (server, transport) => {
    let sessions = 0;
    server.on("session", () => sessions++);
    const held: ServerHttp2Stream[] = [];
    let both!: () => void;
    const entered = new Promise<void>((resolve) => {
      both = resolve;
    });
    server.on("stream", (stream: ServerHttp2Stream) => {
      held.push(stream);
      if (held.length === 2) both();
    });
    const controller = new AbortController();
    const first = transport(url, { ...init, signal: controller.signal });
    const rejected = cancel ? expect(first).rejects.toThrow() : undefined;
    const second = transport(url, init);
    await entered;
    if (cancel) {
      controller.abort();
      await rejected;
    } else {
      held[0]!.respond({ ":status": 200 });
      held[0]!.end("first");
      expect(await (await first).text()).toBe("first");
    }
    held[1]!.respond({ ":status": 200 });
    held[1]!.end("sibling");
    expect(await (await second).text()).toBe("sibling");
    server.once("stream", (stream: ServerHttp2Stream) => {
      stream.respond({ ":status": 200 });
      stream.end("next");
    });
    expect(await (await transport(url, init)).text()).toBe("next");
    expect(sessions).toBe(1);
  });
});

it("keeps sandbox, production and immutable credential configurations separate", async () => {
  await localServer(async (server, transport, owner, replacement) => {
    const authorities: string[] = [];
    let sessions = 0;
    server.on("session", () => sessions++);
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      authorities.push(String(headers[":authority"]));
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
    for (const target of [url, url.replace("api.push", "api.sandbox.push"), url])
      await (await transport(target, init)).text();
    expect(sessions).toBe(2);
    owner.close();
    await expect(transport(url, init)).rejects.toThrow();
    await (await replacement().fetch(url, init)).text();
    expect(sessions).toBe(3);
    expect(authorities).toEqual([
      "api.push.apple.com",
      "api.sandbox.push.apple.com",
      "api.push.apple.com",
      "api.push.apple.com",
    ]);
  });
});

it("never shares a session between transport owners", async () => {
  await localServer(async (server, first, owner, replacement) => {
    let sessions = 0;
    server.on("session", () => sessions++);
    server.on("stream", (stream: ServerHttp2Stream) => {
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
    const second = replacement();
    await (await first(url, init)).text();
    await (await second.fetch(url, init)).text();
    expect(sessions).toBe(2);
    owner.close();
    expect(await (await second.fetch(url, init)).text()).toBe("ok");
    expect(sessions).toBe(2);
  });
});

it.each([2, 1000])(
  "rejects excess streams promptly at the peer/local bound (peer=%s)",
  async (capacity) => {
    await localServer(
      async (server, transport) => {
        const count = capacity === 2 ? 2 : 100;
        const streams: ServerHttp2Stream[] = [];
        let entered!: () => void;
        const admitted = new Promise<void>((resolve) => {
          entered = resolve;
        });
        server.on("stream", (stream: ServerHttp2Stream) => {
          streams.push(stream);
          if (streams.length === count) entered();
        });
        const pending = Array.from({ length: count }, () =>
          transport(url, init).then((response) => response.text()),
        );
        await admitted;
        await expect(transport(url, init)).rejects.toThrow(/capacity/i);
        expect(streams).toHaveLength(count);
        for (const stream of streams) {
          stream.respond({ ":status": 200 });
          stream.end("ok");
        }
        expect(await Promise.all(pending)).toEqual(Array(count).fill("ok"));
      },
      { capacity },
    );
  },
);

it.each(["goaway", "disconnect"])(
  "fails %s requests without replay and reconnects for the next explicit send",
  async (failure) => {
    await localServer(async (server, transport) => {
      let requests = 0;
      let sessions = 0;
      server.on("session", () => sessions++);
      server.on("stream", (stream: ServerHttp2Stream) => {
        requests++;
        if (requests === 1) {
          if (failure === "goaway") stream.session!.goaway();
          else stream.session!.destroy();
          return;
        }
        stream.respond({ ":status": 200 });
        stream.end("ok");
      });
      await expect(transport(url, init)).rejects.toThrow();
      expect(requests).toBe(1);
      expect(await (await transport(url, init)).text()).toBe("ok");
      expect(sessions).toBe(2);
    });
  },
);

it("cancels an abandoned response body without retiring the healthy session", async () => {
  await localServer(async (server, transport) => {
    let sessions = 0;
    let requests = 0;
    server.on("session", () => sessions++);
    let abandoned!: ServerHttp2Stream;
    server.on("stream", (stream: ServerHttp2Stream) => {
      requests++;
      stream.respond({ ":status": 200 });
      if (requests === 1) {
        abandoned = stream;
        stream.write("held");
      } else stream.end("ok");
    });
    const response = await transport(url, init);
    const closed = once(abandoned, "close");
    await response.body!.cancel();
    await closed;
    expect(await (await transport(url, init)).text()).toBe("ok");
    expect(sessions).toBe(1);
  });
});

it("does not retire a session while a response body is still active", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await localServer(
      async (server, transport) => {
        let held!: ServerHttp2Stream;
        let requests = 0;
        server.on("stream", (stream: ServerHttp2Stream) => {
          stream.respond({ ":status": 200 });
          if (++requests === 1) stream.end("first");
          else {
            held = stream;
            stream.write("held");
          }
        });
        await (await transport(url, init)).text();
        const response = await transport(url, init);
        await vi.advanceTimersByTimeAsync(60);
        expect(held.destroyed).toBe(false);
        held.end(" done");
        expect(await response.text()).toBe("held done");
      },
      { idleMs: 50 },
    );
  } finally {
    vi.useRealTimers();
  }
});

it("retires idle sessions and closes all environments idempotently", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await localServer(
      async (server, transport, owner) => {
        const sessions: ServerHttp2Session[] = [];
        server.on("session", (session) => sessions.push(session));
        server.on("stream", (stream: ServerHttp2Stream) => {
          stream.respond({ ":status": 200 });
          stream.end("ok");
        });
        await (await transport(url, init)).text();
        const retired = once(sessions[0]!, "close");
        await vi.advanceTimersByTimeAsync(50);
        await retired;
        await (await transport(url, init)).text();
        await (await transport(url.replace("api.push", "api.sandbox.push"), init)).text();
        expect(sessions).toHaveLength(3);
        const closed = sessions.slice(1).map((session) => once(session, "close"));
        owner.close();
        owner.close();
        await Promise.all(closed);
        await expect(transport(url, init)).rejects.toThrow();
      },
      { idleMs: 50 },
    );
  } finally {
    vi.useRealTimers();
  }
});
