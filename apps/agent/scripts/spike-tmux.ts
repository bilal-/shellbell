/* Spike: tmux control mode from Node. Run with `pnpm spike:tmux` while a GUI terminal is
 * attached to `tmux -L sbspike -t spike`. Records everything the control client prints to
 * test/fixtures/tmux-transcript.txt. */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SOCKET = process.env.TMUX_SPIKE_SOCKET ?? "sbspike";
const SESSION = process.env.TMUX_SPIKE_SESSION ?? "spike";

mkdirSync(join(import.meta.dirname, "..", "test", "fixtures"), { recursive: true });
const transcript = createWriteStream(
  join(import.meta.dirname, "..", "test", "fixtures", "tmux-transcript.txt"),
);
transcript.on("error", () => {});

const client = spawn(
  "tmux",
  ["-L", SOCKET, "-C", "attach-session", "-t", SESSION, "-f", "ignore-size"],
  {
    stdio: ["pipe", "pipe", "inherit"],
  },
);
const rl = createInterface({ input: client.stdout });

type Reply = { lines: string[]; error: boolean; t0: number };
const queue: ((r: Reply) => void)[] = [];
let current: Reply | null = null;

rl.on("line", (line) => {
  if (!transcript.writableEnded) transcript.write(`${line}\n`);
  if (line.startsWith("%begin")) {
    current = { lines: [], error: false, t0: performance.now() };
  } else if (line.startsWith("%end") || line.startsWith("%error")) {
    if (current) {
      current.error = line.startsWith("%error");
      queue.shift()?.(current);
      current = null;
    }
  } else if (current) {
    current.lines.push(line);
  } else if (line.startsWith("%output")) {
    console.log("EVENT", line.slice(0, 80));
  } else {
    console.log("NOTIF", line.slice(0, 120));
  }
});

rl.on("close", () => {
  transcript.end(() => process.exit(0));
});

function cmd(s: string): Promise<Reply> {
  return new Promise((resolve) => {
    queue.push(resolve);
    client.stdin.write(`${s}\n`);
  });
}

async function main() {
  await new Promise((r) => setTimeout(r, 500));
  const panes = await cmd(
    "list-panes -a -F '#{pane_id}\t#{session_name}\t#{pane_width}\t#{pane_height}\t#{history_size}'",
  );
  console.log("panes:", panes.lines);
  const clients = await cmd("list-clients -F '#{client_session}\t#{client_control_mode}'");
  console.log("clients (expect one control=1 and one control=0):", clients.lines);
  const pane = panes.lines[0]?.split("\t")[0];
  if (!pane) throw new Error("no pane");

  const size1 = await cmd(`display-message -p -t ${pane} '#{pane_width}x#{pane_height}'`);
  console.log(
    "pane size seen by control client:",
    size1.lines[0],
    "(compare with the GUI window; it must NOT have shrunk)",
  );

  const cap = await cmd(`capture-pane -p -e -N -t ${pane}`);
  console.log("capture-pane raw reply lines (look at how ESC is escaped):");
  for (const l of cap.lines.slice(0, 6)) console.log(JSON.stringify(l));

  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await cmd(`capture-pane -p -e -N -t ${pane}`);
    samples.push(performance.now() - r.t0);
  }
  samples.sort((a, b) => a - b);
  console.log(
    `capture-pane reply latency ms: p50=${samples[10]?.toFixed(1)} max=${samples.at(-1)?.toFixed(1)}`,
  );

  console.log("sending keys via the control channel; expect %output events to follow…");
  await cmd(`send-keys -t ${pane} -l -- 'echo shellbell-tmux-spike-ok'`);
  await cmd(`send-keys -t ${pane} Enter`);
  await new Promise((r) => setTimeout(r, 800));

  const hist = await cmd(`capture-pane -p -e -N -t ${pane} -S -5 -E -1`);
  console.log("history capture (-S -5 -E -1) lines:", hist.lines.length);

  client.stdin.write("detach-client\n");
}

main().catch((e) => {
  console.error("SPIKE FAILED", e);
  process.exit(1);
});
