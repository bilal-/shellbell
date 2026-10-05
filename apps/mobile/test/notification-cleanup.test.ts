import { describe, expect, it, vi } from "vitest";
import { commitNewPairing, removePairedComputer } from "../src/notifications/cleanup";

describe("private notification unpair cleanup", () => {
  it("blocks reconnect before revoking native state and discards pairing records last", async () => {
    const steps: string[] = [];
    await removePairedComputer("fp", {
      isCurrent: () => true,
      markRemoving: () => {
        steps.push("block");
      },
      disconnect: () => {
        steps.push("disconnect");
      },
      removeNative: async () => {
        steps.push("native");
      },
      deleteSecret: async () => {
        steps.push("secret");
      },
      removeRecord: () => {
        steps.push("record");
      },
    });
    expect(steps).toEqual(["block", "disconnect", "native", "secret", "record"]);
  });
  it("durably prepares revocation before disconnect or secret deletion", async () => {
    const steps: string[] = [];
    await removePairedComputer("fp", {
      isCurrent: () => true,
      markRemoving: () => steps.push("block"),
      prepareRevocation: async () => {
        steps.push("proof");
      },
      disconnect: () => steps.push("disconnect"),
      removeNative: async () => {
        steps.push("native");
      },
      deleteSecret: async () => {
        steps.push("secret");
      },
      removeRecord: () => steps.push("record"),
    });
    expect(steps).toEqual(["block", "proof", "disconnect", "native", "secret", "record"]);
  });
  it("retains local key and disabled record if durable proof preparation fails", async () => {
    const disconnect = vi.fn();
    const deleteSecret = vi.fn();
    const removeRecord = vi.fn();
    let removing = false;
    await expect(
      removePairedComputer("fp", {
        isCurrent: () => true,
        markRemoving: () => {
          removing = true;
        },
        prepareRevocation: async () => {
          throw new Error("disk full");
        },
        disconnect,
        removeNative: async () => {},
        deleteSecret,
        removeRecord,
      }),
    ).rejects.toThrow("disk full");
    expect(removing).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(removeRecord).not.toHaveBeenCalled();
  });
  it.each(["native", "secret"])(
    "keeps a retryable disabled record after %s cleanup fails",
    async (fail) => {
      let removing = false;
      let record = true;
      let secret = true;
      await expect(
        removePairedComputer("fp", {
          isCurrent: () => true,
          markRemoving: () => {
            removing = true;
          },
          disconnect: () => {},
          removeNative: async () => {
            if (fail === "native") throw new Error("locked");
          },
          deleteSecret: async () => {
            if (fail === "secret") throw new Error("locked");
            secret = false;
          },
          removeRecord: () => {
            record = false;
          },
        }),
      ).rejects.toThrow("locked");
      expect(removing).toBe(true);
      expect(record).toBe(true);
      expect(secret).toBe(true);
    },
  );
  it("serializes delayed cleanup before a new pairing so old cleanup cannot erase it", async () => {
    let record = "old";
    let secret = "old";
    let release!: () => void;
    const native = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const removal = removePairedComputer("race", {
      isCurrent: () => record === "old",
      markRemoving: () => {
        started = true;
      },
      disconnect: () => {},
      removeNative: () => native,
      deleteSecret: async () => {
        secret = "";
      },
      removeRecord: () => {
        record = "";
      },
    });
    await vi.waitFor(() => expect(started).toBe(true));
    const pairing = commitNewPairing("race", {
      hasRecord: () => !!record,
      writeSecret: async () => {
        secret = "new";
      },
      addRecord: () => {
        record = "new";
      },
    });
    await Promise.resolve();
    expect(secret).toBe("old");
    release();
    await Promise.all([removal, pairing]);
    expect([record, secret]).toEqual(["new", "new"]);
  });
  it("rejects pairing while a failed cleanup record still exists", async () => {
    const writeSecret = vi.fn();
    await expect(
      commitNewPairing("failed", { hasRecord: () => true, writeSecret, addRecord: () => {} }),
    ).rejects.toThrow("Unpair");
    expect(writeSecret).not.toHaveBeenCalled();
  });
  it("does not let an old confirmation remove a newer pairing generation", async () => {
    const markRemoving = vi.fn();
    await expect(
      removePairedComputer("stale", {
        isCurrent: () => false,
        markRemoving,
        disconnect: () => {},
        removeNative: async () => {},
        deleteSecret: async () => {},
        removeRecord: () => {},
      }),
    ).rejects.toThrow();
    expect(markRemoving).not.toHaveBeenCalled();
  });
});
