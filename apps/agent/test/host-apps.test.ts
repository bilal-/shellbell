import { describe, expect, it } from "vitest";
import {
  herdrAttachShown,
  herdrClientSession,
  herdrHostApps,
} from "../src/backends/herdr/host-apps.js";
import { hostAppOf, parseProcessTable } from "../src/backends/host-app.js";

const TABLE = parseProcessTable(
  [
    "  100     1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
    "  101   100 /usr/bin/login -flp someone /bin/bash --noprofile --norc -c exec -l /bin/zsh",
    "  102   101 -/bin/zsh",
    "  103   102 herdr",
    "  200     1 /Applications/iTerm.app/Contents/MacOS/iTerm2",
    "  201   200 /Applications/iTerm.app/Contents/MacOS/iTermServer-3.6.0 /tmp/sock",
    "  202   201 -zsh",
    "  203   202 /Users/someone/.local/bin/herdr --session work",
    "  300     1 /Users/someone/.local/bin/herdr server",
    "  301   102 herdr workspace list",
    "  400   999 herdr",
    "",
  ].join("\n"),
);

describe("host apps", () => {
  it("walks a process up to the nearest app bundle and names iTerm2 as its product", () => {
    expect(hostAppOf(103, TABLE)).toBe("Ghostty");
    expect(hostAppOf(203, TABLE)).toBe("iTerm2");
    expect(hostAppOf(300, TABLE)).toBeUndefined();
    expect(hostAppOf(400, TABLE)).toBeUndefined();
  });

  it("recognises only interactive Herdr clients and the session they attach to", () => {
    expect(herdrClientSession("herdr")).toBe("");
    expect(herdrClientSession("/Users/someone/.local/bin/herdr --session work")).toBe("work");
    expect(herdrClientSession("herdr --session=work")).toBe("work");
    expect(herdrClientSession("herdr session attach work")).toBe("work");
    expect(herdrClientSession("herdr server")).toBeUndefined();
    expect(herdrClientSession("herdr workspace list")).toBeUndefined();
    expect(herdrClientSession("herdr-auto-title")).toBeUndefined();
  });

  it("names the apps whose clients attach to the watched Herdr socket", () => {
    const env = { XDG_CONFIG_HOME: "/cfg" };
    expect(herdrHostApps(TABLE, "/cfg/herdr/herdr.sock", env)).toEqual(["Ghostty"]);
    expect(herdrHostApps(TABLE, "/cfg/herdr/sessions/work/herdr.sock", env)).toEqual(["iTerm2"]);
    expect(herdrHostApps(TABLE, "/elsewhere/herdr.sock", env)).toEqual([]);
  });
});

describe("a window showing a new Herdr terminal", () => {
  const ghostty = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
  const attach = "/Users/someone/.local/bin/herdr terminal attach term_7";

  it("counts an attach client inside a desktop app, as Ghostty or iTerm2 starts it", () => {
    const table = parseProcessTable(
      [
        `  10     1 ${ghostty} --initial-window=true`,
        `  11    10 /usr/bin/login -flp someone /bin/bash --noprofile --norc -c exec -l /bin/zsh`,
        `  12    11 ${attach}`,
      ].join("\n"),
    );
    expect(herdrAttachShown(table, "term_7")).toBe(true);
    expect(herdrAttachShown(table, "term_8")).toBe(false);
  });

  it("does not count an attach over ssh, the dashboard, or another command", () => {
    const sshd = parseProcessTable(
      ["  20     1 sshd: someone@ttys004", `  21    20 ${attach}`].join("\n"),
    );
    expect(herdrAttachShown(sshd, "term_7")).toBe(false);
    for (const args of [
      "/Users/someone/.local/bin/herdr",
      "/Users/someone/.local/bin/herdr terminal attach term_7 --extra",
      "/Users/someone/bin/not-herdr terminal attach term_7",
      "grep herdr terminal attach term_7",
    ]) {
      const table = parseProcessTable([`  10     1 ${ghostty}`, `  12    10 ${args}`].join("\n"));
      expect(herdrAttachShown(table, "term_7"), args).toBe(false);
    }
  });
});
