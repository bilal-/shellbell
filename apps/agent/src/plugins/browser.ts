import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { PluginManager, PluginStatus } from "./manager.js";
import type { PluginPackage } from "./package.js";

export interface PluginBrowserIO {
  signals?: Pick<NodeJS.EventEmitter, "on" | "off">;
  input: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(mode: boolean): unknown };
  output: Writable & { columns?: number; isTTY?: boolean };
}
const safe = (value: string) => stripVTControlCharacters(value).replace(/\p{Cc}/gu, " ");
const label = (p: PluginStatus): string => {
  const status = p.installed
    ? p.status === "needs-attention"
      ? "Installed · needs attention"
      : "Installed"
    : p.status === "custom-page"
      ? "Custom page exists"
      : p.available
        ? "Not installed"
        : "Requires application";
  return status + (p.installed && p.localPreview ? " · local preview" : "");
};
export function pluginListText(pages: readonly PluginStatus[]): string {
  return pages
    .map(
      (p) =>
        `  ${p.name.padEnd(18)} ${label(p)}\n    ${p.description}${p.detail ? `\n    ${p.detail}` : ""}`,
    )
    .join("\n");
}
/** Keyboard browser owns only its temporary terminal mode, never service lifecycle. */
export async function browsePlugins(
  manager: PluginManager,
  io: PluginBrowserIO,
  fromDirectory?: string,
): Promise<void> {
  let plugins = await manager.list();
  if (!io.input.isTTY || !io.output.isTTY || !io.input.setRawMode) {
    io.output.write(
      pluginListText(plugins) +
        "\nUse shellbell plugins info <id>, install <id>, or uninstall <id>.\n",
    );
    return;
  }
  let index = 0,
    details = false,
    busy = false,
    leaving = false,
    closed = false,
    message = "",
    pkg: PluginPackage | undefined;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const render = () => {
    if (closed) return;
    const p = plugins[index];
    const lines = [
      `Shellbell plugins${plugins.length ? `  ${index + 1} / ${plugins.length}` : ""}`,
      "",
    ];
    if (p) lines.push(`> ${p.name}  [${label(p)}]`);
    if (!p) lines.push("No plugins in this registry.");
    else {
      lines.push(
        "",
        p.description,
        `Source: ${fromDirectory || p.localPreview ? "local preview of " : ""}github.com/${p.repository}`,
        `Requires: ${p.command} (installed separately)`,
        p.executable ? `Found: ${p.executable}` : "Application not found. Install it first.",
      );
      if (p.detail) lines.push(p.detail);
      if (details) {
        lines.push(
          "",
          `Reviewed revision: ${p.revision.slice(0, 12)} (full source in shellbell plugins info ${p.id})`,
        );
        if (pkg)
          lines.push(
            `Plugin ${pkg.manifest.version}${pkg.localPreview ? " · local preview" : ""}`,
            `Adds: ${pkg.manifest.page.name} in Pages`,
            pkg.manifest.requires.help,
            `Starts on page open: ${JSON.stringify([p.executable ?? p.command, ...pkg.manifest.page.args])}`,
          );
        lines.push(
          "",
          p.installed ? "u / Enter  Uninstall plugin" : "i / Enter  Install plugin",
          "Esc  Back to registry",
        );
      } else lines.push("", "↑ / ↓  Browse    Enter  View plugin");
    }
    if (message) lines.push("", message);
    lines.push("", busy ? "Working…  q cancels the pending download" : "q  Quit");
    io.output.write(`\x1b[H\x1b[2J${lines.map(safe).join("\n")}\n`);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    done();
  };
  const requestClose = () => {
    leaving = true;
    manager.close();
    if (!busy) close();
  };
  const perform = (operation: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    message = "";
    render();
    void operation()
      .catch((error) => {
        message = error instanceof Error ? error.message : "Plugin action failed.";
      })
      .finally(() => {
        busy = false;
        if (leaving) close();
        else render();
      });
  };
  const keypress = (_text: string, key: { name?: string; ctrl?: boolean } = {}) => {
    if (key.name === "q" || (key.ctrl && ["c", "d"].includes(key.name ?? ""))) {
      requestClose();
      return;
    }
    if (busy) return;
    if (key.name === "escape") {
      details = false;
      pkg = undefined;
      message = "";
      render();
      return;
    }
    if (!details && ["up", "down", "left", "right", "j", "k"].includes(key.name ?? "")) {
      if (plugins.length)
        index =
          (index + (["up", "left", "k"].includes(key.name!) ? -1 : 1) + plugins.length) %
          plugins.length;
      message = "";
      render();
      return;
    }
    const p = plugins[index];
    if (!p) return;
    if (!details && ["return", "i", "u"].includes(key.name ?? "")) {
      details = true;
      pkg = undefined;
      perform(async () => {
        const info = await manager.info(p.id, fromDirectory);
        pkg = info.package;
      });
      return;
    }
    if (
      details &&
      ((p.installed && ["u", "return"].includes(key.name ?? "")) ||
        (!p.installed && ["i", "return"].includes(key.name ?? "")))
    ) {
      if (!p.installed && !pkg) {
        message = "The plugin package must load before installation. Press Esc and open it again.";
        render();
        return;
      }
      perform(async () => {
        if (p.installed) {
          await manager.uninstall(p.id);
          message = `${p.name} plugin removed. The application and its data remain installed.`;
        } else {
          const result = await manager.install(p.id, fromDirectory);
          message = `${p.name} plugin ${result.changed ? "installed" : "already installed"}. Open its page from your paired phone.`;
        }
        plugins = await manager.list();
      });
    }
  };
  const wasRaw = io.input.isRaw === true,
    wasFlowing = io.input.readableFlowing === true;
  const signals = io.signals ?? process;
  let rawAttempted = false,
    presentationAttempted = false;
  try {
    emitKeypressEvents(io.input);
    rawAttempted = true;
    io.input.setRawMode(true);
    io.input.resume();
    presentationAttempted = true;
    io.output.write("\x1b[?1049h\x1b[?25l");
    io.input.on("keypress", keypress);
    io.input.once("end", requestClose);
    io.input.once("error", requestClose);
    signals.on("SIGTERM", requestClose);
    signals.on("SIGHUP", requestClose);
    render();
    await finished;
  } finally {
    closed = true;
    manager.close();
    signals.off("SIGTERM", requestClose);
    signals.off("SIGHUP", requestClose);
    io.input.off("keypress", keypress);
    io.input.off("end", requestClose);
    io.input.off("error", requestClose);
    try {
      if (rawAttempted) io.input.setRawMode(wasRaw);
    } finally {
      if (!wasFlowing) io.input.pause();
      if (presentationAttempted) io.output.write("\x1b[?25h\x1b[?1049l");
    }
  }
}
