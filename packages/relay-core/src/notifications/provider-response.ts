export type ResponseHead = { status: number; retryAfter: string | null };
export type ResponseFailureCode = "timeout" | "network" | "response-too-large" | "invalid-response";

export class ProviderResponseError extends Error {
  constructor(
    readonly code: ResponseFailureCode,
    readonly head?: ResponseHead,
  ) {
    super(code);
  }
}

/**
 * Bounded transport mechanics only; HTTP and payload policy belong to the caller.
 * `after-body` enforces complete-body size/deadline bounds before UTF-8 validation.
 */
export async function readProviderResponse(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  maxBytes: number,
  readBody: (head: ResponseHead) => boolean = () => true,
  decodeTiming: "stream" | "after-body" = "stream",
): Promise<{ head: ResponseHead; text: string; hasBody: boolean }> {
  const controller = new AbortController();
  let expired = false;
  let head: ResponseHead | undefined;
  let body: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const discard = (stream: ReadableStream<Uint8Array> | null) => {
    if (stream) void stream.cancel().catch(() => undefined);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      reject(new ProviderResponseError("timeout", head));
    }, 5000);
  });
  try {
    const pending = fetchImpl(url, {
      ...init,
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
    });
    void pending.then(
      (response) => {
        if (expired) discard(response.body);
      },
      () => undefined,
    );
    const response = await Promise.race([pending, deadline]);
    body = response.body;
    head = { status: response.status, retryAfter: response.headers.get("retry-after") };
    if (!readBody(head)) return { head, text: "", hasBody: body !== null };
    if (Number(response.headers.get("content-length")) > maxBytes)
      throw new ProviderResponseError("response-too-large", head);
    let text = "";
    if (body) {
      reader = body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) throw new ProviderResponseError("response-too-large", head);
        if (decodeTiming === "after-body") {
          chunks.push(chunk.value);
          continue;
        }
        try {
          text += decoder.decode(chunk.value, { stream: true });
        } catch {
          throw new ProviderResponseError("invalid-response", head);
        }
      }
      try {
        if (decodeTiming === "after-body") {
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          text = decoder.decode(bytes);
        } else text += decoder.decode();
      } catch {
        throw new ProviderResponseError("invalid-response", head);
      }
    }
    return { head, text, hasBody: body !== null };
  } catch (error) {
    if (error instanceof ProviderResponseError) throw error;
    throw new ProviderResponseError(expired ? "timeout" : "network", head);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else discard(body);
  }
}
