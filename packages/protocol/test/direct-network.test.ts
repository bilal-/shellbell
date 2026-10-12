import { describe, expect, it } from "vitest";
import { parseCtrl } from "../src/ctrl.js";
import {
  DIRECT_STUN_URL,
  directIceServers,
  ICE_REFRESH_BEFORE_MS,
  IceServerCache,
} from "../src/direct-network.js";

const turn = {
  urls: [
    "turn:turn.cloudflare.com:3478?transport=udp",
    "turn:turn.cloudflare.com:53?transport=udp",
    "turns:turn.cloudflare.com:443?transport=tcp",
  ],
  username: "a1b2",
  credential: "c3d4",
};

describe("direct ICE servers", () => {
  it("uses STUN alone when the relay offers no TURN servers", () => {
    expect(directIceServers()).toEqual([{ urls: [DIRECT_STUN_URL] }]);
    expect(directIceServers([])).toEqual([{ urls: [DIRECT_STUN_URL] }]);
  });

  it("adds relay TURN servers after STUN and drops port 53, which apps cannot reach", () => {
    expect(directIceServers([turn])).toEqual([
      { urls: [DIRECT_STUN_URL] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "a1b2",
        credential: "c3d4",
      },
    ]);
  });

  it("ignores relay STUN entries and TURN entries without credentials", () => {
    expect(
      directIceServers([
        { urls: ["stun:stun.example.test:3478"] },
        { urls: ["turn:turn.example.test:3478"] },
      ]),
    ).toEqual([{ urls: [DIRECT_STUN_URL] }]);
  });

  it("keeps at most three TURN URLs so candidate gathering stays within signaling limits", () => {
    const urls = [3478, 3479, 3480, 3481, 3482].map((port) => `turn:turn.example.test:${port}`);
    const [, relay] = directIceServers([{ urls, username: "u", credential: "c" }]);
    expect(relay?.urls).toEqual(urls.slice(0, 3));
  });
});

describe("relay ICE messages", () => {
  it("accepts TURN servers on auth-ok and in an ice-servers reply", () => {
    const authOk = parseCtrl({
      type: "auth-ok",
      role: "phone",
      agentOnline: true,
      computerName: null,
      serverTime: 1,
      minFrameMs: 125,
      iceServers: [turn],
      iceExpiresInMs: 3_600_000,
    });
    expect(authOk).toMatchObject({ iceServers: [turn], iceExpiresInMs: 3_600_000 });
    expect(parseCtrl({ type: "ice-refresh" })).toEqual({ type: "ice-refresh" });
    expect(
      parseCtrl({ type: "ice-servers", iceServers: [turn], iceExpiresInMs: 60_000 }),
    ).toMatchObject({ type: "ice-servers" });
  });

  it("rejects URLs that are not STUN or TURN", () => {
    expect(() =>
      parseCtrl({
        type: "ice-servers",
        iceServers: [{ urls: ["https://evil.example"], username: "u", credential: "c" }],
        iceExpiresInMs: 60_000,
      }),
    ).toThrow();
  });
});

describe("ICE server cache", () => {
  it("serves TURN servers until they expire and asks to refresh before then", () => {
    const cache = new IceServerCache();
    expect(cache.supported).toBe(false);
    expect(cache.servers(0)).toEqual([{ urls: [DIRECT_STUN_URL] }]);
    cache.update([turn], 10 * 3_600_000, 0);
    expect(cache.supported).toBe(true);
    expect(cache.servers(1)).toHaveLength(2);
    expect(cache.needsRefresh(1)).toBe(false);
    const due = 10 * 3_600_000 - ICE_REFRESH_BEFORE_MS;
    expect(cache.needsRefresh(due)).toBe(true);
    expect(cache.servers(10 * 3_600_000)).toEqual([{ urls: [DIRECT_STUN_URL] }]);
  });

  it("asks for a refresh at most once per interval", () => {
    const cache = new IceServerCache();
    cache.update([turn], 60_000, 0);
    expect(cache.takeRefresh(1)).toBe(true);
    expect(cache.takeRefresh(2)).toBe(false);
    expect(cache.takeRefresh(10 * 60_000 + 2)).toBe(true);
  });

  it("does not ask a relay without TURN support to refresh", () => {
    const cache = new IceServerCache();
    expect(cache.takeRefresh(0)).toBe(false);
  });
});
