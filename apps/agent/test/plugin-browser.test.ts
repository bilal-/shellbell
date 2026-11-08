import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { browsePlugins } from "../src/plugins/browser.js";
import type { PluginManager, PluginStatus } from "../src/plugins/manager.js";

const first: PluginStatus = {
  id: "example",
  name: "Example",
  description: "Local board",
  command: "example",
  repository: "acme/example",
  revision: "a".repeat(40),
  installed: false,
  available: true,
  status: "available",
  executable: "/bin/example",
};
function fixture() {
  const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
    }),
    output = Object.assign(new PassThrough(), { isTTY: true });
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  let installed = false;
  const manager = {
    list: vi.fn(async () => [
      { ...first, installed },
      { ...first, id: "other", name: "Other" },
    ]),
    info: vi.fn(async () => ({
      package: {
        manifest: { version: "1.0.0", page: { name: "Example", args: ["serve"] } },
        localPreview: false,
      },
    })),
    install: vi.fn(async () => {
      installed = true;
      return { changed: true };
    }),
    uninstall: vi.fn(async () => {
      installed = false;
      return { changed: true };
    }),
    close: vi.fn(),
  };
  return {
    input,
    output,
    manager,
    key: (name: string) => input.emit("keypress", "", { name }),
    text: () => text,
  };
}
it("browses, reviews then installs/removes through explicit keys and restores terminal state", async () => {
  const f = fixture(),
    pending = browsePlugins(f.manager as unknown as PluginManager, f);
  await vi.waitFor(() => expect(f.text()).toContain("Shellbell plugins"));
  f.key("down");
  expect(f.text()).toContain("> Other");
  f.key("up");
  f.key("return");
  await vi.waitFor(() => expect(f.text()).toContain("Starts on page open"));
  expect(f.manager.install).not.toHaveBeenCalled();
  f.key("i");
  await vi.waitFor(() => expect(f.manager.install).toHaveBeenCalledWith("example", undefined));
  await vi.waitFor(() => expect(f.text()).toContain("plugin installed"));
  f.key("u");
  await vi.waitFor(() => expect(f.manager.uninstall).toHaveBeenCalledWith("example"));
  await vi.waitFor(() => expect(f.text()).toContain("plugin removed"));
  f.key("q");
  await pending;
  expect(f.input.setRawMode.mock.calls).toEqual([[true], [false]]);
  expect(f.input.isPaused()).toBe(true);
  expect(f.text()).toContain("\x1b[?25h\x1b[?1049l");
});
it("keeps uninstall available offline and closes a pending request on quit", async () => {
  const f = fixture();
  f.manager.list.mockResolvedValue([{ ...first, installed: true, status: "installed" }]);
  f.manager.info.mockRejectedValue(new Error("GitHub offline"));
  const pending = browsePlugins(f.manager as unknown as PluginManager, f);
  await vi.waitFor(() => expect(f.text()).toContain("Shellbell plugins"));
  f.key("return");
  await vi.waitFor(() => expect(f.text()).toContain("GitHub offline"));
  f.key("u");
  await vi.waitFor(() => expect(f.text()).toContain("plugin removed"));
  f.key("q");
  await pending;
  expect(f.manager.close).toHaveBeenCalled();
});
it("uses plain output for noninteractive use and never downloads or changes a plugin", async () => {
  const f = fixture();
  f.input.isTTY = false;
  await browsePlugins(f.manager as unknown as PluginManager, f);
  expect(f.text()).toContain("shellbell plugins info");
  expect(f.manager.info).not.toHaveBeenCalled();
  expect(f.manager.install).not.toHaveBeenCalled();
  expect(f.input.setRawMode).not.toHaveBeenCalled();
});
