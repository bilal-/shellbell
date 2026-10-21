import { writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_READ_BYTES,
  TranscriptFile,
  type TranscriptIdentity,
} from "../src/conversation/transcript-file.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(text = '{"type":"user","text":"hello"}\n') {
  const dir = await mkdtemp(join(tmpdir(), "shellbell-conversation-"));
  temporary.push(dir);
  const root = join(dir, "claude");
  await mkdir(root);
  const path = join(root, "conversation.jsonl");
  await writeFile(path, text);
  const reference: TranscriptIdentity = {
    agent: "claude",
    path,
    session: "session-1",
    owner: "pane-1:process-start-1",
  };
  let enabled = true;
  let current: TranscriptIdentity | null = reference;
  const identity = vi.fn(async (_signal: AbortSignal) => current);
  const options = { enabled: () => enabled, identity, roots: { claude: [root], codex: [] } };
  return {
    dir,
    root,
    path,
    reference,
    identity,
    options,
    get enabled() {
      return enabled;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
    set current(value: TranscriptIdentity | null) {
      current = value;
    },
    async open() {
      const result = await TranscriptFile.open(options);
      expect(result.status).toBe("open");
      if (result.status !== "open") throw new Error("fixture could not open");
      return result.file;
    },
  };
}

describe("proven transcript descriptor", () => {
  it("does no identity or file work until the owner enables the feature", async () => {
    const f = await fixture();
    f.enabled = false;
    expect(await TranscriptFile.open(f.options)).toEqual({ status: "stopped", reason: "disabled" });
    expect(f.identity).not.toHaveBeenCalled();
  });

  it("does not open an unbound terminal or infer a file from its folder", async () => {
    const f = await fixture();
    f.current = null;
    expect(await TranscriptFile.open(f.options)).toEqual({ status: "stopped", reason: "unbound" });
  });

  it("reads only bounded windows and follows append-only growth through the same descriptor", async () => {
    const f = await fixture("first\n");
    const file = await f.open();
    try {
      const first = await file.read(0);
      expect(first).toMatchObject({ status: "data", offset: 0, size: 6 });
      if (first.status === "data") expect(Buffer.from(first.bytes).toString()).toBe("first\n");
      await appendFile(f.path, "second\n");
      const second = await file.read(6);
      expect(second).toMatchObject({ status: "data", offset: 6, size: 13 });
      if (second.status === "data") expect(Buffer.from(second.bytes).toString()).toBe("second\n");
      expect(await file.read(13)).toMatchObject({
        status: "data",
        bytes: Buffer.alloc(0),
        size: 13,
      });
      expect(await file.read(0, TRANSCRIPT_READ_BYTES + 1)).toEqual({
        status: "stopped",
        reason: "unsafe",
      });
    } finally {
      file.close();
    }
  });

  it("bounds allocations even for a much larger transcript", async () => {
    const f = await fixture("x".repeat(2 * TRANSCRIPT_READ_BYTES));
    const file = await f.open();
    try {
      const result = await file.read(0);
      expect(result.status).toBe("data");
      if (result.status === "data") expect(result.bytes.byteLength).toBe(TRANSCRIPT_READ_BYTES);
    } finally {
      file.close();
    }
  });

  it("refuses a cursor beyond the currently proven extent instead of silently waiting", async () => {
    const f = await fixture("first\n");
    const file = await f.open();
    try {
      expect(await file.read(7)).toEqual({ status: "stopped", reason: "unsafe" });
    } finally {
      file.close();
    }
  });

  it.each([4, 8])("does not accept a rewrite at consent check %s", async (at) => {
    const f = await fixture("a".repeat(20_000));
    const file = await f.open();
    let checks = 0;
    // The final gate in either validation: at=4 rewrites before the bytes/pending
    // fences are read, so only the OLD fences catch it. At=8 rewrites after the
    // final fence check, so a later read must invalidate rather than follow it.
    f.options.enabled = () => {
      if (++checks === at) writeFileSync(f.path, "b".repeat(30_000));
      return true;
    };
    try {
      const first = await file.read(0);
      expect(checks).toBeGreaterThanOrEqual(at);
      if (at === 4) expect(first).toEqual({ status: "stopped", reason: "changed" });
      if (first.status === "data") {
        expect(Buffer.from(first.bytes).toString()).toBe("a".repeat(20_000));
        expect(await file.read(20_000)).toEqual({ status: "stopped", reason: "changed" });
      } else expect(first).toEqual({ status: "stopped", reason: "changed" });
    } finally {
      file.close();
    }
  });

  it.each([true, false])(
    "checks the canonical destination of a parent symlink (inside=%s)",
    async (inside) => {
      const f = await fixture();
      const target = join(inside ? f.root : f.dir, "target");
      await mkdir(target);
      await writeFile(join(target, "session.jsonl"), "inside\n");
      const link = join(f.root, "parent");
      await symlink(target, link);
      f.current = { ...f.reference, path: join(link, "session.jsonl") };
      const opened = await TranscriptFile.open(f.options);
      if (!inside) expect(opened).toEqual({ status: "stopped", reason: "unsafe" });
      else {
        expect(opened.status).toBe("open");
        if (opened.status !== "open") return;
        try {
          expect(await opened.file.read(0)).toMatchObject({ status: "data" });
        } finally {
          opened.file.close();
        }
      }
    },
  );

  it.each(["outside", "sibling-prefix", "symlink-outside", "symlink-inside"])(
    "refuses %s paths",
    async (mode) => {
      const f = await fixture();
      const outside = mode === "sibling-prefix" ? `${f.root}-other` : join(f.dir, "other");
      await mkdir(outside);
      const target = join(outside, "conversation.jsonl");
      await writeFile(target, "outside");
      if (mode.startsWith("symlink")) {
        const link = join(f.root, "link.jsonl");
        await symlink(mode === "symlink-inside" ? f.path : target, link);
        f.current = { ...f.reference, path: link };
      } else f.current = { ...f.reference, path: target };
      expect(await TranscriptFile.open(f.options)).toEqual({ status: "stopped", reason: "unsafe" });
    },
  );

  it.each(["owner", "session", "path", "agent", "missing"])(
    "ends the generation when %s identity changes",
    async (part) => {
      const f = await fixture();
      const file = await f.open();
      try {
        f.current =
          part === "missing"
            ? null
            : {
                ...f.reference,
                ...(part === "owner" ? { owner: "pane-1:new-process-start" } : {}),
                ...(part === "session" ? { session: "session-2" } : {}),
                ...(part === "path" ? { path: join(f.root, "other.jsonl") } : {}),
                ...(part === "agent" ? { agent: "codex" as const } : {}),
              };
        const reason = part === "missing" ? "unbound" : "changed";
        expect(await file.read(0)).toEqual({ status: "stopped", reason });
        f.current = f.reference;
        expect(await file.read(0)).toEqual({ status: "stopped", reason });
      } finally {
        file.close();
      }
    },
  );

  it("drops bytes if identity proof disappears after the file was read", async () => {
    const f = await fixture();
    const file = await f.open();
    let probes = 0;
    f.identity.mockImplementation(async () => (++probes === 1 ? f.reference : null));
    try {
      expect(await file.read(0)).toEqual({ status: "stopped", reason: "unbound" });
    } finally {
      file.close();
    }
  });

  it("drops bytes if the pathname is replaced during a read", async () => {
    const f = await fixture();
    const file = await f.open();
    let probes = 0;
    f.identity.mockImplementation(async () => {
      if (++probes === 2) {
        await rename(f.path, `${f.path}.old`);
        await writeFile(f.path, "replacement");
      }
      return f.reference;
    });
    try {
      expect(await file.read(0)).toEqual({ status: "stopped", reason: "changed" });
    } finally {
      file.close();
    }
  });

  it.each(["truncate", "rewrite-regrow"])("ends the generation on %s", async (mode) => {
    const f = await fixture("a".repeat(20_000));
    const file = await f.open();
    try {
      await writeFile(f.path, mode === "truncate" ? "small" : "b".repeat(30_000));
      expect(await file.read(0)).toEqual({ status: "stopped", reason: "changed" });
    } finally {
      file.close();
    }
  });

  it("rechecks opt-in after reading and never returns disabled content", async () => {
    const f = await fixture();
    const file = await f.open();
    let probes = 0;
    f.identity.mockImplementation(async () => {
      if (++probes === 2) f.enabled = false;
      return f.reference;
    });
    try {
      expect(await file.read(0)).toEqual({ status: "stopped", reason: "disabled" });
    } finally {
      file.close();
    }
  });

  it.each(["cancel", "disable"])(
    "honors %s between final validation and delivery",
    async (action) => {
      const f = await fixture();
      const file = await f.open();
      let checks = 0;
      f.options.enabled = () => {
        // The final validation's last gate runs inside a promise. Invalidation can
        // happen before read() resumes from that promise, even after the gate passed.
        if (++checks === 8)
          queueMicrotask(() => {
            if (action === "cancel") file.close();
            else f.enabled = false;
          });
        return f.enabled;
      };
      try {
        expect(await file.read(0)).toEqual({
          status: "stopped",
          reason: action === "cancel" ? "cancelled" : "disabled",
        });
        expect(checks).toBeGreaterThanOrEqual(8);
      } finally {
        file.close();
      }
    },
  );

  it.each(["read", "verify"])(
    "allows one %s in flight and cancels a stalled native identity probe",
    async (operation) => {
      const f = await fixture();
      const file = await f.open();
      f.identity.mockImplementation(() => new Promise(() => {}));
      const pending = operation === "read" ? file.read(0) : file.verify();
      expect(await file.read(0)).toEqual({ status: "busy" });
      expect(await file.verify()).toEqual({ status: "busy" });
      file.close();
      expect(await pending).toEqual({ status: "stopped", reason: "cancelled" });
      await file.closed;
      expect(await file.verify()).toEqual({ status: "stopped", reason: "cancelled" });
    },
  );

  it("bounds an unresponsive identity probe instead of opening a file on weak evidence", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.identity.mockImplementation(() => new Promise(() => {}));
    const pending = TranscriptFile.open(f.options);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ status: "stopped", reason: "unbound" });
  });

  it("treats a read probe timeout as lost proof and never revives on its late response", async () => {
    const f = await fixture();
    const file = await f.open();
    vi.useFakeTimers();
    let reply: ((identity: TranscriptIdentity) => void) | undefined;
    f.identity.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    try {
      const pending = file.read(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual({ status: "stopped", reason: "unbound" });
      reply?.(f.reference);
      expect(await file.read(0)).toEqual({ status: "stopped", reason: "unbound" });
    } finally {
      file.close();
    }
  });

  it("cancels the owned descriptor when the view's abort signal fires", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const opened = await TranscriptFile.open({ ...f.options, signal: controller.signal });
    expect(opened.status).toBe("open");
    if (opened.status !== "open") return;
    controller.abort();
    expect(await opened.file.read(0)).toEqual({ status: "stopped", reason: "cancelled" });
  });

  it("honors cancellation during the opening proof and removes its view listener", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    f.identity
      .mockImplementationOnce(async () => f.reference)
      .mockImplementation(async () => {
        controller.abort();
        return f.reference;
      });
    expect(await TranscriptFile.open({ ...f.options, signal: controller.signal })).toEqual({
      status: "stopped",
      reason: "cancelled",
    });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("owns the sampled identity instead of retaining a mutable native response object", async () => {
    const f = await fixture();
    const mutable = { ...f.reference };
    f.current = mutable;
    const file = await f.open();
    try {
      mutable.session = "other-session";
      expect(file.identity.session).toBe("session-1");
      expect(await file.read(0)).toEqual({ status: "stopped", reason: "changed" });
    } finally {
      file.close();
    }
  });
});
