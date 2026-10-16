import { describe, expect, it } from "vitest";
import { herdrClientSession, herdrHostApps } from "../src/backends/herdr/host-apps.js";
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
