import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import { TmuxVtSource } from "../src/backends/tmux/vt-source.js";
import { createLogger } from "../src/log.js";

const STATE = [
  "0",
  "10",
  "2",
  "0",
  "0",
  "0",
  "1",
  "0",
  "1",
  "0",
  "1",
  "0",
  "0",
  "0",
  "0",
  "0",
  "8",
  "",
  "",
];

/** A control client whose checkpoints report other panes' output from `interleave`. */
function fakeControl(interleave: () => boolean) {
  const control = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let seq = 0;
  const commands: string[] = [];
  Object.assign(control, {
    alive: true,
    commands,
    start: async () => {},
    stop: () => {
      control.alive = false;
    },
    command: async (line: string) => {
      commands.push(line);
      return line.startsWith("list-panes") ? ["%1", "%2"] : [];
    },
    checkpoint: async () => {
      const sentSeq = seq;
      if (interleave()) control.emit("bytes", "%2", new Uint8Array([0x71]), ++seq);
      control.emit("bytes", "%1", new Uint8Array([0x61]), ++seq);
      const outputSeq = seq;
      return { replies: [[STATE.join("\t")], [], ["x", ""], [""], [""]], sentSeq, outputSeq };
    },
  });
  return control as unknown as TmuxControl & { commands: string[] };
}

const options = (control: TmuxControl) => ({
  tmuxSessionId: "$0",
  paneId: "%1",
  log: createLogger({ stdout: false }),
  controlFactory: () => control,
});

describe("TmuxVtSource", () => {
  it("refuses identities that are not tmux session and pane ids", () => {
    const control = fakeControl(() => false);
    expect(() => new TmuxVtSource({ ...options(control), paneId: "%1;kill" })).toThrow(
      "invalid tmux pane identity",
    );
  });

  it("turns other panes off and seeds again when one wrote ahead of the capture", async () => {
    let first = true;
    const control = fakeControl(() => {
      const interleaved = first;
      first = false;
      return interleaved;
    });
    const source = new TmuxVtSource(options(control));
    const seeds: number[] = [];
    source.on("seed", (seed) => seeds.push(seed.generation));
    await source.start();
    expect(seeds).toEqual([1]);
    expect(control.commands.filter((c) => c === "refresh-client -A '%2:off'")).toHaveLength(2);
    source.close();
  });

  it("gives up rather than seeding from a capture it cannot place", async () => {
    const source = new TmuxVtSource(options(fakeControl(() => true)));
    const ended: string[] = [];
    source.on("end", (reason) => ended.push(reason));
    source.on("seed", () => ended.push("seed"));
    await source.start();
    expect(ended).toEqual(["unsettled"]);
  });
});
