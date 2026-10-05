import {
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type ClientSessionOptions,
  connect,
  type SecureClientSessionOptions,
} from "node:http2";

type Connect = (
  authority: string,
  options: ClientSessionOptions & SecureClientSessionOptions,
) => ClientHttp2Session;

/** Own one immutable provider configuration's APNs sessions, separated by environment.
 * APNs requires HTTP/2. Never substitute Node's HTTP/1 fetch or follow redirects.
 */
export function createApnsHttp2Transport(
  options: { connect?: Connect; deadlineMs?: number; idleMs?: number } = {},
): { fetch: typeof fetch; close(): void } {
  type Entry = {
    session: ClientHttp2Session;
    ready: Promise<void>;
    usable: boolean;
    active: number;
    limit: number;
    failures: Set<() => void>;
    retired: boolean;
    idleTimer?: ReturnType<typeof setTimeout>;
  };
  const sessions = new Map<string, Entry>();
  let closed = false;
  function retire(origin: string, entry: Entry) {
    if (entry.retired) return;
    entry.retired = true;
    clearTimeout(entry.idleTimer);
    if (sessions.get(origin) === entry) sessions.delete(origin);
    for (const fail of entry.failures) fail();
    entry.session.destroy();
  }
  function acquire(url: URL): Entry {
    const existing = sessions.get(url.origin);
    if (existing) return existing;
    const session = (options.connect ?? connect)(url.origin, {
      rejectUnauthorized: true,
      servername: url.hostname,
      ALPNProtocols: ["h2"],
    });
    let ready!: () => void;
    const entry: Entry = {
      session,
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
      active: 0,
      usable: false,
      limit: 100,
      failures: new Set(),
      retired: false,
    };
    sessions.set(url.origin, entry);
    let verified = false;
    let settingsReceived = false;
    const connected = () => {
      if (verified && settingsReceived) {
        entry.usable = true;
        ready();
      }
    };
    const failed = () => {
      retire(url.origin, entry);
      ready();
    };
    session.on("error", failed);
    session.on("close", failed);
    session.on("goaway", failed);
    session.once("connect", () => {
      if (session.alpnProtocol !== "h2") {
        failed();
        return;
      }
      verified = true;
      connected();
    });
    session.on("remoteSettings", (settings) => {
      entry.limit = Math.min(100, settings.maxConcurrentStreams ?? 100);
      settingsReceived = true;
      connected();
    });
    return entry;
  }
  const fetchApns: typeof fetch = async (input, init) => {
    if (closed) throw new Error("APNs transport closed");
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (
      url.protocol !== "https:" ||
      !["api.push.apple.com", "api.sandbox.push.apple.com"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/3\/device\/[a-fA-F0-9]{1,512}$/.test(url.pathname) ||
      init?.method !== "POST" ||
      typeof init.body !== "string" ||
      Buffer.byteLength(init.body) > 4096
    )
      throw new Error("Invalid APNs request");
    if (init.signal?.aborted) throw new Error("APNs request aborted");
    const headers = Object.fromEntries(new Headers(init.headers));
    const entry = acquire(url);
    // Bound callers even while TLS/settings are pending; never queue behind a full session.
    if (entry.failures.size >= entry.limit) throw new Error("APNs stream capacity exceeded");
    clearTimeout(entry.idleTimer);
    return new Promise<Response>((resolve, reject) => {
      let stream: ClientHttp2Stream | undefined;
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      let finished = false;
      let received = 0;
      let admitted = false;
      const cleanup = () => {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", aborted);
        stream?.destroy();
        entry.failures.delete(fail);
        if (admitted) entry.active--;
        if (!entry.retired && entry.failures.size === 0) {
          if (!entry.usable) {
            retire(url.origin, entry);
            return;
          }
          entry.idleTimer = setTimeout(() => retire(url.origin, entry), options.idleMs ?? 300_000);
          entry.idleTimer.unref();
        }
      };
      const fail = (error = new Error("APNs HTTP/2 transport failed")) => {
        if (finished) return;
        finished = true;
        body?.error(error);
        reject(error);
        cleanup();
      };
      const aborted = () => fail();
      const timer = setTimeout(fail, Math.min(options.deadlineMs ?? 5000, 5000));
      init.signal?.addEventListener("abort", aborted, { once: true });
      entry.failures.add(fail);
      void entry.ready.then(() => {
        if (finished) return;
        if (entry.retired || closed) {
          fail();
          return;
        }
        if (entry.active >= entry.limit) {
          fail(new Error("APNs stream capacity exceeded"));
          return;
        }
        entry.active++;
        admitted = true;
        try {
          stream = entry.session.request({
            ...headers,
            ":method": "POST",
            ":scheme": "https",
            ":authority": url.host,
            ":path": url.pathname,
          });
          stream.on("error", () => fail());
          stream.on("aborted", () => fail());
          stream.once("response", (responseHeaders) => {
            const status = responseHeaders[":status"];
            if (!status || status < 200 || status > 599) {
              fail();
              return;
            }
            const response = new Headers();
            // Preserve the head for provider backoff even when its declared body is too large.
            // Actual bytes and the complete response deadline remain bounded below.
            for (const [key, value] of Object.entries(responseHeaders))
              if (!key.startsWith(":") && value !== undefined)
                response.set(key, Array.isArray(value) ? value.join(", ") : String(value));
            const readable = new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
              },
              pull() {
                stream?.resume();
              },
              cancel() {
                if (!finished) {
                  finished = true;
                  cleanup();
                }
              },
            });
            // APNs uses 200 or JSON errors; handle bodyless HTTP statuses safely too.
            if ([204, 205, 304].includes(status)) {
              finished = true;
              body?.close();
              cleanup();
              resolve(new Response(null, { status, headers: response }));
            } else resolve(new Response(readable, { status, headers: response }));
          });
          stream.on("data", (chunk: Buffer) => {
            if (finished) return;
            received += chunk.length;
            if (!body || received > 16384) {
              fail();
              return;
            }
            body.enqueue(new Uint8Array(chunk));
            if ((body.desiredSize ?? 0) <= 0) stream?.pause();
          });
          stream.on("end", () => {
            if (finished) return;
            if (!body) {
              fail();
              return;
            }
            finished = true;
            body.close();
            cleanup();
          });
          stream.on("close", () => fail());
          stream.end(init.body);
        } catch {
          fail();
        }
      });
    });
  };
  return {
    fetch: fetchApns,
    close() {
      if (closed) return;
      closed = true;
      for (const [origin, entry] of sessions) retire(origin, entry);
    },
  };
}
