import { describe, expect, it, vi } from "vitest";
import { createCloudflareTurnProvider } from "../src/adapters/turn.js";

const HOUR = 3_600_000;
const response = (username = "user-1") =>
  new Response(
    JSON.stringify({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
        {
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:53?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turn:turn.cloudflare.com:80?transport=tcp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username,
          credential: "credential-1",
        },
      ],
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );

function memoryKv() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    values,
  };
}

function setup(fetcher = vi.fn(async () => response()), kv = memoryKv()) {
  const clock = { now: 0 };
  const make = () =>
    createCloudflareTurnProvider(
      { TURN_KEY_ID: "key-id", TURN_KEY_API_TOKEN: "api-token" },
      { fetch: fetcher, now: () => clock.now, kv },
    )!;
  return { provider: make(), make, fetcher, clock, kv };
}

describe("Cloudflare TURN credentials", () => {
  it("is off unless both TURN secrets are configured", () => {
    expect(createCloudflareTurnProvider({})).toBeUndefined();
    expect(createCloudflareTurnProvider({ TURN_KEY_ID: "key-id" })).toBeUndefined();
    expect(createCloudflareTurnProvider({ TURN_KEY_API_TOKEN: "api-token" })).toBeUndefined();
  });

  it("requests a 24-hour credential with the key's bearer token and keeps three TURN URLs", async () => {
    const { provider, fetcher } = setup();
    const issue = await provider();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer api-token");
    expect(JSON.parse(String(init.body))).toEqual({ ttl: 86_400 });
    expect(issue).toEqual({
      iceServers: [
        {
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username: "user-1",
          credential: "credential-1",
        },
      ],
      expiresInMs: 24 * HOUR,
    });
  });

  it("reuses a credential while at least 16 hours remain, then fetches a new one", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response("first"))
      .mockResolvedValueOnce(response("second"));
    const { provider, clock } = setup(fetcher);
    await provider();
    clock.now = 8 * HOUR;
    expect(await provider()).toMatchObject({ expiresInMs: 16 * HOUR });
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock.now = 8 * HOUR + 1;
    expect((await provider())?.iceServers[0]?.username).toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps a still-valid credential when a refresh fails, and gives none once it expires", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response("first"))
      .mockResolvedValue(new Response("nope", { status: 500 }));
    const { provider, clock } = setup(fetcher);
    await provider();
    clock.now = 20 * HOUR;
    expect(await provider()).toMatchObject({ expiresInMs: 4 * HOUR });
    clock.now = 24 * HOUR;
    expect(await provider()).toBeNull();
  });

  it("keeps credentials across hibernation, which recreates the provider", async () => {
    const { provider, make, fetcher, clock } = setup();
    await provider();
    clock.now = HOUR;
    const woken = make();
    expect(await woken()).toMatchObject({ expiresInMs: 23 * HOUR });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("waits a minute after a failure before asking Cloudflare again, even after hibernation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValue(response());
    const { provider, make, clock } = setup(fetcher);
    expect(await provider()).toBeNull();
    clock.now = 59_999;
    expect(await make()()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock.now = 60_000;
    expect(await make()()).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("discards stored credentials and backoff after the TURN key changes", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response("old-key"))
      .mockResolvedValueOnce(response("new-key"));
    const { provider, fetcher: calls, clock, kv } = setup(fetcher);
    await provider();
    clock.now = HOUR;
    const rotated = createCloudflareTurnProvider(
      { TURN_KEY_ID: "rotated-key", TURN_KEY_API_TOKEN: "api-token" },
      { fetch: fetcher, now: () => clock.now, kv },
    )!;
    expect((await rotated())?.iceServers[0]?.username).toBe("new-key");
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("returns null for a malformed reply or a network error", async () => {
    for (const reply of [
      async () => new Response(JSON.stringify({ iceServers: [{ urls: ["https://x"] }] })),
      async () => {
        throw new Error("offline");
      },
    ]) {
      const { provider } = setup(vi.fn(reply));
      expect(await provider()).toBeNull();
    }
  });
});
