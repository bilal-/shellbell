import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/net/connection", () => ({ DeliveryUnknownError: class extends Error {} }));

const { INPUT_DELIVERY_UNKNOWN, withDeliveryTimeout } = await import("../src/input/fireInput");
const { receiptFromOutcome, refusalText, settleReceipt, sendingReceipt, unknownText } =
  await import("../src/conversation/receipt");

afterEach(() => {
  vi.useRealTimers();
});

describe("send receipt", () => {
  it("says Sending, then who it was sent to once the computer confirms", () => {
    expect(sendingReceipt("r1")).toEqual({ id: "r1", state: "sending", text: "Sending…" });
    expect(receiptFromOutcome("r1", { type: "ack", reqId: "r1", ok: true }, "claude")).toEqual({
      id: "r1",
      state: "sent",
      text: "Sent to Claude",
    });
    expect(receiptFromOutcome("r1", { ok: true }, undefined).text).toBe("Sent to the agent");
  });

  it("says why every refusal happened, in plain words", () => {
    const refused = (error?: string) =>
      receiptFromOutcome("r1", { ok: false, ...(error && { error }) }, "claude");
    expect(refused("conversation-changed")).toEqual({
      id: "r1",
      state: "refused",
      text: "Claude’s conversation changed. Check it before sending again.",
    });
    expect(refused("waiting-for-you").text).toBe(
      "Claude is waiting for you. Answer in the terminal.",
    );
    expect(refused("busy").text).toBe(
      "Your computer is still busy with earlier input. Try again in a moment.",
    );
    expect(refused("session-gone").text).toBe("This session has ended on your computer.");
    expect(refused("unchecked").text).toBe("Couldn’t check on Claude just now. Try again.");
    expect(refusalText("unchecked", undefined)).toBe(
      "Couldn’t check on the agent just now. Try again.",
    );
    expect(refused("unsupported").text).toBe(
      "This terminal doesn’t take typed input from the phone.",
    );
    for (const error of ["failed", "cancelled", "something new", undefined])
      expect(refused(error).text).toBe("Not delivered. Your draft is still here.");
    // A missing or odd outcome is not delivered, never sent.
    expect(receiptFromOutcome("r1", undefined, "claude").state).toBe("refused");
    expect(receiptFromOutcome("r1", null, "claude").state).toBe("refused");
    expect(refusalText("conversation-changed", undefined)).toBe(
      "The agent’s conversation changed. Check it before sending again.",
    );
  });

  it("keeps an unknown outcome unknown, from the phone or the computer", () => {
    const text = "Not sure this reached Codex. Check the chat before sending again.";
    expect(unknownText("codex")).toBe(text);
    expect(receiptFromOutcome("r1", INPUT_DELIVERY_UNKNOWN, "codex")).toEqual({
      id: "r1",
      state: "unknown",
      text,
    });
    expect(receiptFromOutcome("r1", { ok: false, error: "delivery-unknown" }, "codex").state).toBe(
      "unknown",
    );
  });

  it("lets only the latest send's outcome change the receipt", () => {
    const latest = sendingReceipt("r2");
    expect(settleReceipt(latest, receiptFromOutcome("r1", { ok: true }, "claude"))).toBe(latest);
    expect(settleReceipt(latest, receiptFromOutcome("r2", { ok: true }, "claude"))?.state).toBe(
      "sent",
    );
    // A dismissed receipt stays dismissed.
    expect(settleReceipt(null, receiptFromOutcome("r2", { ok: true }, "claude"))).toBeNull();
  });
});

describe("waiting for an ack", () => {
  it("passes an outcome straight through when it arrives in time", async () => {
    vi.useFakeTimers();
    const onLate = vi.fn();
    const result = withDeliveryTimeout(Promise.resolve({ ok: true }), onLate);
    await expect(result).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onLate).not.toHaveBeenCalled();
  });

  it("says unknown after 10 seconds without cancelling, and hands a late ack on", async () => {
    vi.useFakeTimers();
    let ack!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      ack = resolve;
    });
    const onLate = vi.fn();
    const result = withDeliveryTimeout(pending, onLate);
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(INPUT_DELIVERY_UNKNOWN);
    ack({ ok: true });
    await vi.waitFor(() => expect(onLate).toHaveBeenCalledWith({ ok: true }));
  });

  it("treats a failed request as no outcome", async () => {
    await expect(withDeliveryTimeout(Promise.reject(new Error("x")), vi.fn())).resolves.toBe(
      undefined,
    );
  });
});
