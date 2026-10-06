import type { InnerMessageLoose } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { fireInput, INPUT_DELIVERY_UNKNOWN, type RequestingConn } from "../src/input/fireInput";
import { DeliveryUnknownError } from "../src/net/connection";
import { LOST_INPUT_TOAST } from "../src/net/toasts";

const msg = (): InnerMessageLoose & { reqId: string } => ({
  type: "input.key",
  reqId: "r1",
  sessionId: "s1",
  key: "enter",
});

describe("fireInput (task 8 review Important)", () => {
  it("tracks the reqId before requesting when the connection is online", async () => {
    const track = vi.fn();
    const untrack = vi.fn();
    const conn: RequestingConn = { status: "online", request: vi.fn(() => new Promise(() => {})) };
    fireInput(conn, msg(), { track, untrack });
    expect(track).toHaveBeenCalledWith("r1");
    expect(untrack).not.toHaveBeenCalled();
  });

  it("does not track when the connection exists but is not online", async () => {
    const track = vi.fn();
    const untrack = vi.fn();
    const conn: RequestingConn = {
      status: "offline",
      request: vi.fn(() => Promise.reject(new DeliveryUnknownError())),
    };
    const result = await fireInput(conn, msg(), { track, untrack });
    expect(track).not.toHaveBeenCalled();
    expect(result).toBe(INPUT_DELIVERY_UNKNOWN);
    expect(untrack).toHaveBeenCalledWith("r1", LOST_INPUT_TOAST);
  });

  it("a DeliveryUnknownError rejection always cleans up and toasts, even after tracking", async () => {
    const track = vi.fn();
    const untrack = vi.fn();
    const conn: RequestingConn = {
      status: "online",
      request: vi.fn(() => Promise.reject(new DeliveryUnknownError())),
    };
    const result = await fireInput(conn, msg(), { track, untrack });
    expect(track).toHaveBeenCalledWith("r1");
    expect(result).toBe(INPUT_DELIVERY_UNKNOWN);
    expect(untrack).toHaveBeenCalledWith("r1", LOST_INPUT_TOAST);
  });

  it("a non-DeliveryUnknownError rejection cleans up without toasting", async () => {
    const track = vi.fn();
    const untrack = vi.fn();
    const conn: RequestingConn = {
      status: "online",
      request: vi.fn(() => Promise.reject(new Error("boom"))),
    };
    const result = await fireInput(conn, msg(), { track, untrack });
    expect(result).toBeUndefined();
    expect(untrack).toHaveBeenCalledWith("r1", undefined);
  });

  it("a successful request never calls untrack (the ack path clears pendingInputs elsewhere)", async () => {
    const track = vi.fn();
    const untrack = vi.fn();
    const conn: RequestingConn = {
      status: "online",
      request: vi.fn(() => Promise.resolve({ type: "ack", reqId: "r1", ok: true })),
    };
    const result = await fireInput(conn, msg(), { track, untrack });
    expect(result).toEqual({ type: "ack", reqId: "r1", ok: true });
    expect(untrack).not.toHaveBeenCalled();
  });
});
