import { expect, it } from "vitest";
import {
  age,
  agentSessions,
  agentStateLabel,
  settleOrder,
  waitingCount,
} from "../src/util/agents-view";

const session = (id: string, extra: object) =>
  ({ id, title: id, state: "running", agent: { kind: "claude" }, ...extra }) as never;

it("keeps an older computer's state words, which it can't qualify", () => {
  const older = session("a", { state: "blocked" });
  expect(agentStateLabel(older, false, 0)).toBe("waiting for you");
  expect(waitingCount([older], false)).toBe(1);
  // A newer computer that doesn't vouch for the agent's state leaves it unknown.
  expect(agentStateLabel(older, true, 0)).toBe("state unknown");
  expect(waitingCount([older], true)).toBe(0);
});

it("sorts by state, then recent activity, then project and ID, so the order is stable", () => {
  const reported = { kind: "claude", reportsState: true };
  const list = [
    session("idle", { state: "finished", agent: reported, activeAt: 9 }),
    session("old", { agent: reported, activeAt: 1 }),
    session("none", { agent: reported, project: "b" }),
    session("none2", { agent: reported, project: "a" }),
    session("new", { agent: reported, activeAt: 5 }),
    session("wait", { state: "blocked", agent: reported }),
    session("plain", { agent: undefined }),
  ];
  expect(agentSessions(list, true).map((s: { id: string }) => s.id)).toEqual([
    "wait",
    "new",
    "old",
    "none2",
    "none",
    "idle",
  ]);
});

it("says how long ago in the shortest words", () => {
  expect(
    [0, 59_000, 60_000, 3_599_000, 3_600_000, 47 * 3_600_000, 48 * 3_600_000].map(age),
  ).toEqual(["now", "now", "1m", "59m", "1h", "47h", "2d"]);
});

it("keeps a new agent where it first appeared until the next re-sort", () => {
  // A then B shown; C arrives sorted between them, then its rank changes before a re-sort.
  let shown = settleOrder(["A", "B"], ["A", "C", "B"]);
  expect(shown).toEqual(["A", "C", "B"]);
  shown = settleOrder(shown, ["C", "A", "B"]);
  expect(shown).toEqual(["A", "C", "B"]);
  // A row that leaves goes at once.
  expect(settleOrder(shown, ["C", "B"])).toEqual(["C", "B"]);
});
