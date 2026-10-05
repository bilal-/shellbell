const MAX_BODY_BYTES = 4 * 1024;
const DEADLINE_MS = 5_000;

/** Public reachability evidence only; never authenticates or creates a relay computer socket. */
export async function probeRelayHealth(
  relayUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  let healthUrl: string;
  try {
    const url = new URL(relayUrl);
    const protocol = { "ws:": "http:", "wss:": "https:", "http:": "http:", "https:": "https:" }[
      url.protocol
    ];
    if (!protocol || !url.hostname) return false;
    url.protocol = protocol;
    url.username = "";
    url.password = "";
    url.pathname = "/healthz";
    url.search = "";
    url.hash = "";
    healthUrl = url.toString();
  } catch {
    return false;
  }

  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const timer = setTimeout(() => {
    controller.abort();
    void reader?.cancel().catch(() => {});
  }, DEADLINE_MS);
  try {
    const response = await fetchImpl(healthUrl, { redirect: "manual", signal: controller.signal });
    if (!response.body) return false;
    reader = response.body.getReader();
    if (response.status !== 200) return false;
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) return false;
      chunks.push(value);
    }
    if (controller.signal.aborted) return false;
    const body = Buffer.concat(chunks, length).toString("utf8");
    return body === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      // Start cancellation but never wait on a misbehaving stream's cancel hook.
      void reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        /* a pending read releases on cancellation */
      }
    }
  }
}
