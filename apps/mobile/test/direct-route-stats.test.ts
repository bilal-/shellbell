import { describe, expect, it } from "vitest";
import { directRouteStats } from "../src/net/direct/route-stats";
import { directRouteDetail } from "../src/util/transport-state";

function report(local: object, remote: object, pair: object = {}, selected = true) {
  return new Map<string, unknown>([
    ["T1", { type: "transport", id: "T1", ...(selected && { selectedCandidatePairId: "CP1" }) }],
    [
      "CP1",
      {
        type: "candidate-pair",
        id: "CP1",
        localCandidateId: "L1",
        remoteCandidateId: "R1",
        state: "succeeded",
        nominated: true,
        currentRoundTripTime: 0.018,
        ...pair,
      },
    ],
    ["CP2", { type: "candidate-pair", id: "CP2", state: "failed", nominated: false }],
    ["L1", { type: "local-candidate", id: "L1", ...local }],
    ["R1", { type: "remote-candidate", id: "R1", ...remote }],
  ]);
}

describe("direct route stats", () => {
  it("reads the selected pair's path and round trip", () => {
    expect(directRouteStats(report({ candidateType: "host" }, { candidateType: "host" }))).toEqual({
      path: "local",
      rttMs: 18,
    });
    expect(
      directRouteStats(report({ candidateType: "srflx" }, { candidateType: "host" })),
    ).toMatchObject({ path: "internet" });
    expect(
      directRouteStats(report({ candidateType: "prflx" }, { candidateType: "srflx" })),
    ).toMatchObject({ path: "internet" });
  });
  it("names how this device reaches its TURN server", () => {
    expect(
      directRouteStats(
        report({ candidateType: "relay", relayProtocol: "tls" }, { candidateType: "srflx" }),
      ),
    ).toEqual({ path: "turn", turnTransport: "tls", rttMs: 18 });
    // The computer's end relayed: still through TURN, but not over this device's link.
    expect(directRouteStats(report({ candidateType: "host" }, { candidateType: "relay" }))).toEqual(
      { path: "turn", rttMs: 18 },
    );
  });
  it("falls back to the nominated pair when the transport names none", () => {
    expect(
      directRouteStats(report({ candidateType: "host" }, { candidateType: "host" }, {}, false)),
    ).toEqual({ path: "local", rttMs: 18 });
  });
  it("is null before a pair carries traffic, and omits an unknown round trip", () => {
    expect(directRouteStats(new Map())).toBeNull();
    expect(
      directRouteStats(
        report({ candidateType: "host" }, { candidateType: "host" }, {}, false).set("CP1", {
          type: "candidate-pair",
          state: "in-progress",
          nominated: false,
        }),
      ),
    ).toBeNull();
    expect(
      directRouteStats(
        report(
          { candidateType: "host" },
          { candidateType: "host" },
          { currentRoundTripTime: undefined },
        ),
      ),
    ).toEqual({ path: "local" });
  });
});

describe("direct route detail", () => {
  it("joins the path, round trip and setup time", () => {
    expect(directRouteDetail({ path: "local", rttMs: 18 }, 1240)).toBe(
      "Peer to peer on your network · 18 ms round trip · set up in 1.2 s",
    );
    expect(directRouteDetail({ path: "turn", turnTransport: "tcp" }, null)).toBe(
      "Through a relay server, which can't read it (TCP)",
    );
    expect(directRouteDetail(null, 900)).toBeNull();
  });
});
