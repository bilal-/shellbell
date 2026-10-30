import type { TerminalSetup } from "@shellbell/protocol";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import { TerminalSetupNotice } from "../src/ui/TerminalSetupNotice";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("react-native", () => ({ View: "View", Text: "Text" }));

async function shown(setup: readonly TerminalSetup[]): Promise<string[]> {
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(TerminalSetupNotice, { setup })));
    return root.container
      .queryAll((node) => node.type === "Text")
      .map((node) => String(node.props.children));
  } finally {
    await act(async () => root.unmount());
  }
}
const absent = (name: string): TerminalSetup => ({
  name,
  connected: false,
  issue: "not-installed",
});

it("tells a Mac with none of iTerm2, tmux or Herdr why Terminal alone is not enough", async () => {
  expect(await shown([absent("iterm2"), absent("tmux"), absent("herdr")])).toEqual([
    "Your Mac needs iTerm2, tmux or Herdr.",
    "Apple's Terminal only lets other apps see plain text and type whole lines, which isn't enough to use a terminal from your phone, so Shellbell can't use it by itself. Install one on your Mac. iTerm2 is the easiest.",
  ]);
});

it("stays quiet when one is installed, and on a Linux computer without tmux", async () => {
  expect(
    await shown([
      absent("iterm2"),
      { name: "tmux", connected: false, issue: "no-session" },
      absent("herdr"),
    ]),
  ).toEqual([]);
  expect(await shown([absent("tmux")])).toEqual([]);
});

it("still names a terminal that needs a step on the computer", async () => {
  expect(await shown([{ name: "iterm2", connected: false, issue: "needs-consent" }])).toEqual([
    "iTerm2 needs one more step on your Mac.",
    "Open Shellbell → Settings → Terminals on that Mac, or run shellbell doctor there.",
  ]);
});
