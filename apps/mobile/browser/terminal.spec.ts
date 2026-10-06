import { expect, type Page, test } from "@playwright/test";
import type { TerminalFrame } from "../src/terminal/bridge";
import type { TerminalCommand } from "../src/terminal/controls";

type Event = {
  type: string;
  document: string;
  revision?: number;
  data?: string;
  submit?: boolean;
  text?: string;
  html?: string;
  resultCount?: number;
  following?: boolean;
  topKey?: string;
};
declare global {
  interface Window {
    __terminalEvents: Event[];
  }
}

async function open(page: Page, dom = false) {
  await page.addInitScript((forceDom) => {
    window.__terminalEvents = [];
    window.ReactNativeWebView = {
      postMessage: (text) => window.__terminalEvents.push(JSON.parse(text)),
    };
    if (forceDom) {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...args: unknown[]
      ) {
        return type.startsWith("webgl") ? null : original.call(this, type as "2d", ...args);
      } as typeof original;
    }
  }, dom);
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(() => window.__terminalEvents.some((event) => event.type === "ready")),
    )
    .toBe(true);
}
async function frame(page: Page, patch: Partial<TerminalFrame>) {
  const state = await page.evaluate(() => ({
    document: window.__terminalEvents.find((event) => event.type === "ready")!.document,
    revision:
      (window.__terminalEvents.filter((event) => event.type === "ack").at(-1)?.revision ?? 0) + 1,
  }));
  await page.evaluate((value) => window.shellbellReceive(value), {
    cols: 80,
    liveRows: 3,
    fontSize: 14,
    fitWidth: true,
    cursor: { key: "live:0", x: 3, accent: "#10B981", blinking: false },
    upsert: [],
    inputReady: true,
    ...patch,
    ...state,
  });
  await expect
    .poll(() =>
      page.evaluate(
        (revision) =>
          window.__terminalEvents.some(
            (event) => event.type === "ack" && event.revision === revision,
          ),
        state.revision,
      ),
    )
    .toBe(true);
}
async function command(page: Page, value: TerminalCommand) {
  await page.evaluate(
    (command) =>
      window.shellbellCommand({
        ...command,
        document: window.__terminalEvents.find((event) => event.type === "ready")!.document,
      }),
    value,
  );
}
const historical = Array.from({ length: 1000 }, (_, index) => ({
  key: `history:${index}`,
  history: true,
  absoluteRow: index,
  line: {
    r: [{ t: `row-${String(index).padStart(5, "0")} 漢字 é 👩‍💻 <literal>`, fg: index % 16 }],
  },
}));
const live = (text = "live prompt") =>
  [0, 1, 2].map((index) => ({
    key: `live:${index}`,
    history: false,
    liveRow: index,
    absoluteRow: 1000 + index,
    line: { r: [{ t: index === 0 ? text : "" }] },
  }));

for (const renderer of ["normal", "dom"] as const) {
  test(`${renderer}: programmatic search does not request older history after an earlier tap`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const rows = [...historical, ...live()];
    await frame(page, { order: rows.map((row) => row.key), upsert: rows });
    const screen = (await page.locator(".xterm-screen").boundingBox())!;
    await page.mouse.click(screen.x + 5, screen.y + screen.height / 6);
    await command(page, {
      type: "search",
      text: "row-00000",
      direction: "next",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__terminalEvents.filter((event) => event.type === "search-result").at(-1)
              ?.resultCount,
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(() => window.__terminalEvents.filter((event) => event.type === "older")),
    ).toHaveLength(0);
  });

  test(`${renderer}: touch selection handles stay reachable at both viewport edges`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const selectedText = "0123456789".repeat(8);
    const nextText = "next!repeat".repeat(8).slice(0, 80);
    const rows = Array.from({ length: 24 }, (_, index) => ({
      key: `live:${index}`,
      history: false,
      liveRow: index,
      absoluteRow: index,
      line: { r: [{ t: index === 2 ? selectedText : index === 3 ? nextText : "" }] },
    }));
    await frame(page, {
      order: rows.map((row) => row.key),
      upsert: rows,
      liveRows: 24,
      fontSize: 16,
    });
    await command(page, { type: "select", enabled: true });
    const screen = (await page.locator(".xterm-screen").boundingBox())!;
    await page.locator("#terminal").dispatchEvent("pointerdown", {
      pointerType: "touch",
      clientX: screen.x + 2,
      clientY: screen.y + (screen.height * 2.5) / 24,
    });
    await expect(page.locator(".selection-handle:not([hidden])")).toHaveCount(2);
    const viewport = (await page.locator("#container").boundingBox())!;
    for (const handle of await page.locator(".selection-handle:not([hidden])").all()) {
      const box = (await handle.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(viewport.x);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.x + viewport.width);
      expect(box.y).toBeGreaterThanOrEqual(viewport.y);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.y + viewport.height);
    }
    const start = (await page
      .getByRole("button", { name: "Start of terminal selection" })
      .boundingBox())!;
    const pointer = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    const cell = { width: screen.width / 80, height: screen.height / 24 };
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    await page.mouse.move(pointer.x + 5 * cell.width, pointer.y);
    await command(page, { type: "copy", format: "text", request: "edge-drag" });
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
      ),
    ).toBe(selectedText.slice(5));
    // Crossing the other endpoint keeps the original fixed endpoint throughout the gesture.
    await page.mouse.move(pointer.x + 7 * cell.width, pointer.y + cell.height);
    await command(page, { type: "copy", format: "text", request: "crossed" });
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
      ),
    ).toBe(nextText.slice(0, 7));
    await page.mouse.move(pointer.x + 9 * cell.width, pointer.y + cell.height);
    await command(page, { type: "copy", format: "text", request: "crossed-again" });
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
      ),
    ).toBe(nextText.slice(0, 9));
    await page.mouse.up();
  });

  test(`${renderer}: copy and search retain soft wraps across the history/live boundary`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const history = {
      key: "wrapped-history",
      history: true,
      absoluteRow: 0,
      line: { r: [{ t: "abcde" }], w: true },
    };
    const current = {
      key: "wrapped-live",
      history: false,
      liveRow: 0,
      absoluteRow: 1,
      line: { r: [{ t: "fgh" }] },
    };
    await frame(page, {
      cols: 5,
      liveRows: 2,
      fitWidth: false,
      order: [history.key, current.key],
      upsert: [history, current],
      cursor: null,
    });
    await frame(page, {
      cols: 5,
      liveRows: 2,
      fitWidth: false,
      upsert: [{ ...current, line: { r: [{ t: "xyz" }] } }],
      cursor: null,
    });
    await command(page, {
      type: "search",
      text: "abcdexyz",
      direction: "next",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__terminalEvents.filter((event) => event.type === "search-result").at(-1)
              ?.resultCount,
        ),
      )
      .toBe(1);
    await command(page, { type: "copy", format: "text", request: "wrapped" });
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
      ),
    ).toBe("abcdexyz");
  });

  test(`${renderer}: search and select the real retained scrollback, including off-screen history`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const rows = [...historical, ...live()];
    await frame(page, { order: rows.map((row) => row.key), upsert: rows });
    await command(page, {
      type: "search",
      text: "row-00000",
      direction: "next",
      caseSensitive: true,
      wholeWord: false,
      regex: false,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__terminalEvents.filter((event) => event.type === "search-result").at(-1)
              ?.resultCount,
        ),
      )
      .toBe(1);
    await command(page, { type: "copy", format: "text", request: "first" });
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
      ),
    ).toBe("row-00000");
    await frame(page, { upsert: live("changed live prompt") });
    await command(page, { type: "copy", format: "text", request: "second" });
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
      ),
    ).toBe("row-00000");
    await command(page, { type: "clear-search" });
    await command(page, { type: "select-all" });
    await command(page, { type: "copy", format: "html", request: "all" });
    const copied = await page.evaluate(
      () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)!,
    );
    expect(copied.text).toContain("row-00000");
    expect(copied.text).toContain("row-00999");
    expect(copied.text).toContain("changed live prompt");
    const parsed = await page.evaluate((html) => {
      const doc = new DOMParser().parseFromString(html!, "text/html");
      return {
        text: doc.body.textContent,
        executableTags: doc.querySelectorAll("literal,script").length,
      };
    }, copied.html);
    expect(parsed.text).toContain("<literal>");
    expect(parsed.executableTags).toBe(0);
  });
  test(`${renderer}: xterm handles hardware keys and stops input while paused`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const rows = live();
    await frame(page, { order: rows.map((row) => row.key), upsert: rows, hardwareKeyboard: true });
    await command(page, { type: "focus" });
    await page.locator(".xterm-helper-textarea").press("Shift+ArrowLeft");
    await page.locator(".xterm-helper-textarea").press("Control+c");
    const inputs = await page.evaluate(() =>
      window.__terminalEvents.filter((event) => event.type === "input").map((event) => event.data),
    );
    expect(inputs).toContain("\x1b[1;2D");
    expect(inputs).toContain("\x03");
    await frame(page, { inputReady: false });
    await page.locator(".xterm-helper-textarea").press("ArrowLeft");
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "input").length,
      ),
    ).toBe(inputs.length);
  });
  test(`${renderer}: pasted commands use one input event with their submit key`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const rows = live();
    await frame(page, { order: rows.map((row) => row.key), upsert: rows });
    await command(page, { type: "paste", text: "first\nsecond", submit: true });
    const inputs = await page.evaluate(() =>
      window.__terminalEvents.filter((event) => event.type === "input").map((event) => event.data),
    );
    expect(inputs).toEqual(["first\rsecond\r"]);
  });
  test(`${renderer}: native paste stays one request and oversized input never sends Enter`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const rows = live();
    await frame(page, { order: rows.map((row) => row.key), upsert: rows, hostPaste: true });
    await command(page, { type: "paste", text: "first\nsecond", submit: true });
    expect(
      await page.evaluate(() => window.__terminalEvents.filter((event) => event.type === "paste")),
    ).toMatchObject([{ data: "first\rsecond", submit: true }]);
    await command(page, { type: "paste", text: "x".repeat(60_000), submit: true });
    expect(
      await page.evaluate(() => window.__terminalEvents.filter((event) => event.type === "input")),
    ).toHaveLength(0);
    expect(
      await page.evaluate(() => window.__terminalEvents.filter((event) => event.type === "paste")),
    ).toHaveLength(1);
    expect(
      await page.evaluate(() =>
        window.__terminalEvents.some((event) => event.type === "input-rejected"),
      ),
    ).toBe(true);
  });
  test(`${renderer}: touch selection uses xterm's buffer and survives unrelated live updates`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const rows = live();
    await frame(page, { order: rows.map((row) => row.key), upsert: rows });
    await command(page, { type: "select", enabled: true });
    const screen = await page.locator(".xterm-screen").boundingBox();
    await page.locator("#terminal").dispatchEvent("pointerdown", {
      pointerType: "touch",
      clientX: screen!.x + 2,
      clientY: screen!.y + screen!.height / 6,
    });
    await command(page, { type: "copy", format: "text", request: "touch" });
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
      ),
    ).toBe("live prompt");
    await expect(page.locator(".selection-handle:not([hidden])")).toHaveCount(2);
    await frame(page, { upsert: [{ ...rows[1]!, line: { r: [{ t: "unrelated change" }] } }] });
    await command(page, { type: "copy", format: "text", request: "stable" });
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
      ),
    ).toBe("live prompt");
    await frame(page, { upsert: [{ ...rows[0]!, line: { r: [{ t: "replaced content" }] } }] });
    await command(page, { type: "copy", format: "text", request: "stale" });
    expect(await page.evaluate(() => window.__terminalEvents.at(-1)?.type)).toBe("copy-empty");
  });
  test(`${renderer}: a short viewport keeps the live footer visible and respects a user's pan`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    await page.setViewportSize({ width: 390, height: 250 });
    const rows = Array.from({ length: 24 }, (_, index) => ({
      key: `screen:${index}`,
      history: false,
      liveRow: index,
      absoluteRow: index,
      line: { r: [{ t: index === 23 ? "Footer status" : `line ${index}` }] },
    }));
    await frame(page, {
      order: rows.map((row) => row.key),
      upsert: rows,
      liveRows: 24,
      fontSize: 16,
      fitWidth: false,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector(".xterm-screen")!.getBoundingClientRect().bottom -
            document.querySelector("#container")!.getBoundingClientRect().bottom,
        ),
      )
      .toBeLessThan(2);
    await page.evaluate(() => {
      document.querySelector("#container")!.scrollTop = 0;
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)?.following,
        ),
      )
      .toBe(false);
    await frame(page, { upsert: [{ ...rows[23]!, line: { r: [{ t: "Updated footer" }] } }] });
    expect(await page.evaluate(() => document.querySelector("#container")!.scrollTop)).toBe(0);
    await page.evaluate(() => window.shellbellJumpToLive());
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)?.following,
        ),
      )
      .toBe(true);
  });
}

for (const renderer of ["normal", "dom"] as const) {
  test(`${renderer}: xterm commits IME composition once and keeps ordinary prompts visible`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    await page.setViewportSize({ width: 390, height: 180 });
    const rows = Array.from({ length: 24 }, (_, index) => ({
      key: `ime:${index}`,
      history: false,
      liveRow: index,
      line: { r: [{ t: index === 0 ? "prompt" : "" }] },
    }));
    await frame(page, {
      order: rows.map((row) => row.key),
      upsert: rows,
      liveRows: 24,
      fitWidth: false,
      cursor: { key: "ime:0", x: 6, accent: "#10B981", blinking: false },
    });
    expect(await page.evaluate(() => document.querySelector("#container")!.scrollTop)).toBe(0);
    await command(page, { type: "focus" });
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.value = "日";
      input.dispatchEvent(new CompositionEvent("compositionupdate", { data: "日", bubbles: true }));
      input.dispatchEvent(
        new InputEvent("input", {
          data: "日",
          inputType: "insertCompositionText",
          isComposing: true,
          bubbles: true,
        }),
      );
      input.value = "日本";
      input.dispatchEvent(
        new CompositionEvent("compositionupdate", { data: "日本", bubbles: true }),
      );
      input.dispatchEvent(new CompositionEvent("compositionend", { data: "日本", bubbles: true }));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__terminalEvents
            .filter((event) => event.type === "input")
            .map((event) => event.data),
        ),
      )
      .toEqual(["日本"]);
  });
}
