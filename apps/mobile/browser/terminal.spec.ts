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
  /** The copy request a copy event answers. */
  request?: string;
  resultCount?: number;
  following?: boolean;
  topKey?: string;
  sequence?: number;
  alternate?: boolean;
  cursorLine?: string;
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
async function touchDriver(page: Page, browserName: string) {
  const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
  return {
    async send(type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) {
      if (cdp)
        await cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
        });
      else
        await page.evaluate(
          ({ type, x, y }) => {
            const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
            Object.defineProperty(event, "touches", {
              value: type === "touchEnd" ? [] : [{ identifier: 1, clientX: x, clientY: y }],
            });
            document.querySelector(".xterm-screen")!.dispatchEvent(event);
          },
          { type, x, y },
        );
    },
    async dispose() {
      await cdp?.detach();
    },
  };
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
  test(`${renderer}: the initial history anchor survives automatic sizing`, async ({ page }) => {
    await open(page, renderer === "dom");
    const rows = [...historical, ...live()];
    await frame(page, {
      order: rows.map((row) => row.key),
      upsert: rows,
      initialAnchor: "history:500",
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)?.topKey,
        ),
      )
      .toBe("history:500");
  });

  test(`${renderer}: paints a frame sent before the session reports its screen size`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    await frame(page, { liveRows: 0, cursor: null, order: [], upsert: [] });
    const rows = live();
    await frame(page, { order: rows.map((row) => row.key), upsert: rows });
    expect(
      await page.evaluate(() => window.__terminalEvents.some((event) => event.type === "error")),
    ).toBe(false);
  });

  test(`${renderer}: automatic font sizing stays stable across unchanged geometry`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const rows = live();
    await frame(page, { order: rows.map((row) => row.key), upsert: rows });
    await page.evaluate(() => document.fonts.ready);
    const widths: number[] = [];
    for (let index = 0; index < 6; index++) {
      await frame(page, { upsert: [{ ...rows[0]!, line: { r: [{ t: `live ${index}` }] } }] });
      widths.push(
        await page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              requestAnimationFrame(() =>
                resolve(document.querySelector(".xterm-screen")!.getBoundingClientRect().width),
              );
            }),
        ),
      );
    }
    expect(new Set(widths).size, `Grid widths across identical settings: ${widths}`).toBe(1);
  });

  test(`${renderer}: phone swipes scroll xterm history without typing or hijacking selection`, async ({
    page,
    browserName,
  }) => {
    await open(page, renderer === "dom");
    const liveRows = Array.from({ length: 24 }, (_, index) => ({
      key: `live:${index}`,
      history: false,
      liveRow: index,
      line: { r: [{ t: `live ${index}` }] },
    }));
    const rows = [...historical, ...liveRows];
    await frame(page, {
      order: rows.map((row) => row.key),
      upsert: rows,
      liveRows: 24,
      initialAnchor: "history:500",
    });
    const screen = (await page.locator(".xterm-screen").boundingBox())!;
    const x = screen.x + screen.width / 2;
    const y = screen.y + 30;
    const driver = await touchDriver(page, browserName);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", offset: number) =>
      driver.send(type, x, y + offset);
    try {
      await touch("touchStart", 0);
      await touch("touchMove", 20);
      await page.evaluate(
        ({ x, y }) => {
          window.shellbellReceive({
            document: window.__terminalEvents.find((event) => event.type === "ready")!.document,
            revision: 2,
            cols: 80,
            liveRows: 24,
            fontSize: 14,
            fitWidth: true,
            inputReady: true,
            cursor: null,
            upsert: [
              {
                key: "live:0",
                history: false,
                liveRow: 0,
                line: { r: [{ t: "updated during swipe" }] },
              },
            ],
          });
          // Force the reachable overlap while xterm's asynchronous write is pending.
          const event = new Event("touchmove", { bubbles: true, cancelable: true });
          Object.defineProperty(event, "touches", {
            value: [{ identifier: 1, clientX: x, clientY: y + 50 }],
          });
          document.querySelector(".xterm-screen")!.dispatchEvent(event);
        },
        { x, y },
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__terminalEvents.filter((event) => event.type === "ack").at(-1)?.revision,
          ),
        )
        .toBe(2);
      const retained = await page.evaluate(() =>
        Number(
          window.__terminalEvents
            .filter((event) => event.type === "viewport")
            .at(-1)!
            .topKey!.split(":")[1],
        ),
      );
      await touch("touchMove", 180);
      await expect
        .poll(() =>
          page.evaluate(() =>
            Number(
              window.__terminalEvents
                .filter((event) => event.type === "viewport")
                .at(-1)!
                .topKey!.split(":")[1],
            ),
          ),
        )
        .toBeLessThan(retained);
      await touch("touchEnd", 180);
      await command(page, { type: "select", enabled: true });
      const before = await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)!.topKey,
      );
      await touch("touchStart", 0);
      await touch("touchMove", 180);
      await touch("touchEnd", 180);
      expect(
        await page.evaluate(
          () => window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)!.topKey,
        ),
      ).toBe(before);
      expect(
        await page.evaluate(() =>
          window.__terminalEvents.filter(
            (event) => event.type === "input" || event.type === "mouse",
          ),
        ),
      ).toHaveLength(0);
    } finally {
      await driver.dispose();
    }
  });
  test(`${renderer}: phone history scrolling survives zooming in and out`, async ({
    page,
    browserName,
  }) => {
    await open(page, renderer === "dom");
    const rows = [
      ...historical,
      ...Array.from({ length: 24 }, (_, index) => ({
        key: `live:${index}`,
        history: false,
        liveRow: index,
        line: { r: [{ t: index === 0 ? "prompt" : "" }] },
      })),
    ];
    await frame(page, {
      order: rows.map((row) => row.key),
      upsert: rows,
      initialAnchor: "history:500",
      liveRows: 24,
      fitWidth: false,
    });
    const top = () =>
      page.evaluate(() =>
        Number(
          window.__terminalEvents
            .filter((event) => event.type === "viewport")
            .at(-1)!
            .topKey!.split(":")[1],
        ),
      );
    const driver = await touchDriver(page, browserName);
    const touch = async (type: "touchStart" | "touchMove" | "touchEnd", y: number) => {
      if (browserName === "chromium") {
        await driver.send(type, 150, y);
      } else {
        await page.evaluate(
          ({ type, y }) => {
            const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
            Object.defineProperty(event, "touches", {
              value: type === "touchEnd" ? [] : [{ identifier: 1, clientX: 150, clientY: y }],
            });
            document.elementFromPoint(150, y)!.dispatchEvent(event);
          },
          { type, y },
        );
      }
    };
    try {
      for (const fontSize of [22, 8, 16]) {
        await frame(page, { fontSize, fitWidth: false, liveRows: 24 });
        if (fontSize === 8) {
          expect(await page.evaluate(() => document.elementFromPoint(150, 400)?.id)).toBe(
            "container",
          );
        }
        await touch("touchStart", 400);
        const before = await top();
        await touch("touchMove", 500);
        await expect
          .poll(top, { message: `font ${fontSize}: scroll toward older history` })
          .toBeLessThan(before);
        await touch("touchEnd", 500);
        await touch("touchStart", 500);
        const older = await top();
        await touch("touchMove", 400);
        await expect
          .poll(top, { message: `font ${fontSize}: scroll toward live output` })
          .toBeGreaterThan(older);
        await touch("touchEnd", 400);
      }
    } finally {
      await driver.dispose();
    }
  });

  test(`${renderer}: phone gestures pan a large live grid before entering history`, async ({
    page,
    browserName,
  }) => {
    await open(page, renderer === "dom");
    const liveRows = Array.from({ length: 80 }, (_, index) => ({
      key: `live:${index}`,
      history: false,
      liveRow: index,
      line: { r: [{ t: `live ${index}` }] },
    }));
    const rows = [...historical, ...liveRows];
    await frame(page, {
      order: rows.map((row) => row.key),
      upsert: rows,
      liveRows: 80,
      fitWidth: false,
    });
    const driver = await touchDriver(page, browserName);
    try {
      const before = await page.locator("#container").evaluate((element) => element.scrollTop);
      await driver.send("touchStart", 100, 100);
      await driver.send("touchMove", 100, 350);
      const after = await page.locator("#container").evaluate((element) => element.scrollTop);
      expect(after).toBeLessThan(before);
      expect(after).toBeGreaterThan(0);
      expect(
        await page.evaluate(
          () => window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)!.topKey,
        ),
      ).toMatch(/^live:/);
      await driver.send("touchEnd", 100, 350);
      for (let index = 0; index < 2; index++) {
        await driver.send("touchStart", 100, 100);
        await driver.send("touchMove", 100, 550);
        await driver.send("touchEnd", 100, 550);
      }
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)!.topKey,
          ),
        )
        .toMatch(/^history:/);
      await driver.send("touchStart", 300, 200);
      const top = await page.locator("#container").evaluate((element) => element.scrollTop);
      const anchor = await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)!.topKey,
      );
      await driver.send("touchMove", 100, 200);
      await driver.send("touchEnd", 100, 200);
      if (browserName === "chromium")
        await expect
          .poll(() => page.locator("#container").evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0);
      expect(await page.locator("#container").evaluate((element) => element.scrollTop)).toBe(top);
      expect(
        await page.evaluate(
          () => window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)!.topKey,
        ),
      ).toBe(anchor);
    } finally {
      await driver.dispose();
    }
  });
  test(`${renderer}: history paging survives a live frame during scrollbar drag`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const liveRows = Array.from({ length: 24 }, (_, index) => ({
      key: `live:${index}`,
      liveRow: index,
      history: false,
      line: { r: [{ t: `live ${index}` }] },
    }));
    const rows = [...historical, ...liveRows];
    await frame(page, {
      order: rows.map((row) => row.key),
      upsert: rows,
      liveRows: 24,
      initialAnchor: "history:500",
      fitWidth: true,
    });
    const slider = page.locator(".xterm-scrollable-element > .scrollbar.vertical > .slider");
    await page.locator("#container").evaluate((element) => {
      element.scrollLeft = element.scrollWidth - element.clientWidth;
    });
    const handle = (await slider.boundingBox())!;
    const screen = (await page.locator(".xterm-screen").boundingBox())!;
    // Fractional font metrics can leave part of a wide grid's handle outside the phone viewport.
    // Grab its visible portion rather than sending a pointer event outside the browser.
    const visibleRight = Math.min(handle.x + handle.width, page.viewportSize()!.width);
    expect(visibleRight).toBeGreaterThan(handle.x);
    const grabX = (handle.x + visibleRight) / 2;
    await page.mouse.move(grabX, handle.y + handle.height / 2);
    await page.mouse.down();
    await expect(slider).toHaveClass(/\bactive\b/);
    await frame(page, {
      upsert: [{ ...liveRows[0]!, line: { r: [{ t: "updated while dragging" }] } }],
      liveRows: 24,
      fitWidth: true,
    });
    expect(
      await page.evaluate(() => window.__terminalEvents.filter((event) => event.type === "older")),
    ).toHaveLength(0);
    await page.mouse.move(grabX, screen.y + 1);
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)?.topKey,
        ),
      )
      .toBe("history:0");
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__terminalEvents.filter((event) => event.type === "older").length,
        ),
      )
      .toBe(1);
  });
  for (const change of ["prepend", "evict"] as const) {
    test(`${renderer}: a held selection drag follows retained rows after history ${change}`, async ({
      page,
    }) => {
      await open(page, renderer === "dom");
      const historyRows = Array.from({ length: 50 }, (_, index) => ({
        key: `h:${index}`,
        history: true,
        absoluteRow: index + 100,
        line: { r: [{ t: `history-${index}:`.padEnd(80, String(index % 10)) }] },
      }));
      const liveRows = live();
      const rows = [...historyRows, ...liveRows];
      await frame(page, {
        order: rows.map((row) => row.key),
        upsert: rows,
        initialAnchor: "h:20",
        fitWidth: false,
      });
      await command(page, {
        type: "search",
        text: "history-20:",
        direction: "next",
        caseSensitive: false,
        wholeWord: false,
        regex: false,
      });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)?.topKey,
          ),
        )
        .toMatch(/^h:(19|20)$/);
      const top = await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "viewport").at(-1)!.topKey!,
      );
      const relativeRow = 20 - historyRows.findIndex((row) => row.key === top);
      await command(page, { type: "select", enabled: true });
      const screen = (await page.locator(".xterm-screen").boundingBox())!;
      await page.locator("#terminal").dispatchEvent("pointerdown", {
        pointerType: "touch",
        clientX: screen.x + 2,
        clientY: screen.y + (screen.height * (relativeRow + 0.5)) / 3,
      });
      await command(page, { type: "copy", format: "text", request: "before-drag" });
      expect(
        await page.evaluate(
          () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
        ),
      ).toBe(historyRows[20]!.line.r[0]!.t);
      const handle = (await page
        .getByRole("button", { name: "End of terminal selection" })
        .boundingBox())!;
      const pointer = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      await page.mouse.move(pointer.x, pointer.y);
      await page.mouse.down();
      const older = Array.from({ length: 10 }, (_, index) => ({
        key: `older:${index}`,
        history: true,
        absoluteRow: index + 90,
        line: { r: [{ t: `older-${index}:`.padEnd(80, "o") }] },
      }));
      const retained =
        change === "prepend" ? [...older, ...rows] : [...historyRows.slice(10), ...liveRows];
      await frame(page, {
        order: retained.map((row) => row.key),
        upsert: change === "prepend" ? older : [],
        fitWidth: false,
      });
      await page.mouse.move(pointer.x - (8 * screen.width) / 80, pointer.y);
      await page.mouse.up();
      await command(page, { type: "copy", format: "text", request: "after-shift" });
      expect(
        await page.evaluate(
          () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
        ),
      ).toBe(historyRows[20]!.line.r[0]!.t.slice(0, 72));
    });
  }

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
    // Copying the whole buffer can finish after the command returns; read this request's answer.
    const ownCopy = () =>
      page.evaluate(() =>
        window.__terminalEvents.find((event) => event.type === "copy" && event.request === "all"),
      );
    await expect.poll(async () => (await ownCopy()) !== undefined).toBe(true);
    const copied = (await ownCopy())!;
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
  test(`${renderer}: tapping the terminal never opens the phone keyboard`, async ({ page }) => {
    await open(page, renderer === "dom");
    const rows = live();
    await frame(page, { order: rows.map((row) => row.key), upsert: rows });
    const focused = () =>
      page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"));
    await page.locator(".xterm-screen").click();
    expect(await focused()).toBe(false);
    // Even a focus request only reaches xterm with a hardware keyboard attached.
    await command(page, { type: "focus" });
    expect(await focused()).toBe(false);
    await page.keyboard.type("autocorrected words");
    expect(
      await page.evaluate(() => window.__terminalEvents.filter((event) => event.type === "input")),
    ).toHaveLength(0);
    await frame(page, { hardwareKeyboard: true });
    await command(page, { type: "focus" });
    expect(await focused()).toBe(true);
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
  test(`${renderer}: a still long press starts selection on the pressed line; a moving one does not`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    const rows = live();
    await frame(page, { order: rows.map((row) => row.key), upsert: rows });
    await page.clock.install();
    const screen = (await page.locator(".xterm-screen").boundingBox())!;
    const at = { clientX: screen.x + 2, clientY: screen.y + screen.height / 6 };
    const press = (type: string, init: object = {}) =>
      page
        .locator("#terminal")
        .dispatchEvent(type, { pointerType: "touch", pointerId: 7, ...at, ...init });
    const starts = () =>
      page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "select-start").length,
      );
    // A finger that travels is a scroll, and a quick tap is a tap.
    await press("pointerdown");
    await press("pointermove", { clientY: at.clientY + 30 });
    await page.clock.runFor(1_000);
    await press("pointerup");
    await press("pointerdown");
    await page.clock.runFor(200);
    await press("pointerup");
    await page.clock.runFor(1_000);
    expect(await starts()).toBe(0);
    await expect(page.locator(".selection-handle:not([hidden])")).toHaveCount(0);
    // A held, still finger turns selection on and selects that line.
    await press("pointerdown");
    await page.clock.runFor(500);
    expect(await starts()).toBe(1);
    await press("pointerup");
    await expect(page.locator(".selection-handle:not([hidden])")).toHaveCount(2);
    await command(page, { type: "copy", format: "text", request: "held" });
    expect(
      await page.evaluate(
        () => window.__terminalEvents.filter((event) => event.type === "copy").at(-1)?.text,
      ),
    ).toBe("live prompt");
    // While selecting, another hold adjusts the selection rather than starting again.
    await press("pointerdown");
    await page.clock.runFor(1_000);
    await press("pointerup");
    expect(await starts()).toBe(1);
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
      // xterm only takes input from a hardware keyboard; its IME still composes there.
      hardwareKeyboard: true,
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
  test(`${renderer}: a reply queued in raw mode is not typed after switching to snapshots`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    await frame(page, { vt: true, cursor: null, hardwareKeyboard: true });
    const rows = live();
    await page.evaluate(
      ({ rows }) => {
        const ready = window.__terminalEvents.find((event) => event.type === "ready")!;
        const ack = window.__terminalEvents.filter((event) => event.type === "ack").at(-1)!;
        // A cursor-position query, then the switch back to snapshots before xterm parses it.
        window.shellbellVt({
          document: ready.document,
          sequence: 1,
          data: btoa(`${"x".repeat(200_000)}\x1b[6n`),
          reset: { cols: 80, rows: 3 },
        });
        window.shellbellReceive({
          cols: 80,
          liveRows: 3,
          fontSize: 14,
          fitWidth: true,
          cursor: null,
          inputReady: true,
          order: rows.map((row) => row.key),
          upsert: rows,
          document: ready.document,
          revision: (ack.revision ?? 0) + 1,
        });
      },
      { rows },
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__terminalEvents.some((e) => e.type === "vt-ack" && e.sequence === 1),
        ),
      )
      .toBe(true);
    const inputs = await page.evaluate(() =>
      window.__terminalEvents.filter((e) => e.type === "input").map((e) => e.data),
    );
    expect(inputs).toEqual([]);
  });

  test(`${renderer}: raw mode keeps history after a snapshot that had none`, async ({ page }) => {
    // Only the DOM renderer has rows to read; history is the same for both.
    test.skip(renderer !== "dom", "the canvas renderer has no row text to read");
    await open(page, renderer === "dom");
    // A snapshot with no history shrinks xterm's scrollback to nothing.
    const rows = live();
    await frame(page, { order: rows.map((row) => row.key), upsert: rows });
    await frame(page, { vt: true, cursor: null, hardwareKeyboard: true });
    const document = await page.evaluate(
      () => window.__terminalEvents.find((event) => event.type === "ready")!.document,
    );
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\r\n");
    await page.evaluate((message) => window.shellbellVt(message), {
      document,
      sequence: 1,
      data: Buffer.from(lines, "utf8").toString("base64"),
      reset: { cols: 40, rows: 10 },
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__terminalEvents.some((e) => e.type === "vt-ack" && e.sequence === 1),
        ),
      )
      .toBe(true);
    // Scrolled to the top, the first line is still there.
    await page.locator(".xterm-screen").hover();
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -2000);
          return page.locator(".xterm-rows").innerText();
        },
        { timeout: 30_000 },
      )
      .toMatch(/^line 1\n/);
  });

  test(`${renderer}: raw output that rewrites a selected row drops the selection before Copy`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    await frame(page, { vt: true, cursor: null });
    const document = await page.evaluate(
      () => window.__terminalEvents.find((event) => event.type === "ready")!.document,
    );
    const send = async (sequence: number, text: string, reset?: { cols: number; rows: number }) => {
      await page.evaluate((message) => window.shellbellVt(message), {
        document,
        sequence,
        data: Buffer.from(text, "utf8").toString("base64"),
        ...(reset ? { reset } : {}),
      });
      await expect
        .poll(() =>
          page.evaluate(
            (n) => window.__terminalEvents.some((e) => e.type === "vt-ack" && e.sequence === n),
            sequence,
          ),
        )
        .toBe(true);
    };
    const copied = async (request: string) => {
      await command(page, { type: "copy", format: "text", request });
      return page.evaluate(() => {
        const last = window.__terminalEvents.at(-1);
        return last?.type === "copy" ? last.text : last?.type;
      });
    };
    await send(1, "alpha\r\nother", { cols: 40, rows: 10 });
    await command(page, { type: "select", enabled: true });
    const screen = await page.locator(".xterm-screen").boundingBox();
    await page.locator("#terminal").dispatchEvent("pointerdown", {
      pointerType: "touch",
      clientX: screen!.x + 2,
      clientY: screen!.y + screen!.height / 20,
    });
    expect(await copied("selected")).toBe("alpha");
    // Output elsewhere leaves the selection alone.
    await send(2, "\x1b[2;1H\x1b[2Kchanged");
    expect(await copied("unrelated")).toBe("alpha");
    // A redraw of the selected row would otherwise copy text the user never selected.
    await send(3, "\x1b[1;1H\x1b[2Kbravo");
    expect(await copied("rewritten")).toBe("copy-empty");
  });
  test(`${renderer}: raw mode writes the terminal's own bytes and never types its answers`, async ({
    page,
  }) => {
    await open(page, renderer === "dom");
    await frame(page, { vt: true, cursor: null, hardwareKeyboard: true });
    const document = await page.evaluate(
      () => window.__terminalEvents.find((event) => event.type === "ready")!.document,
    );
    const send = async (sequence: number, text: string, reset?: { cols: number; rows: number }) => {
      await page.evaluate((message) => window.shellbellVt(message), {
        document,
        sequence,
        data: Buffer.from(text, "utf8").toString("base64"),
        ...(reset ? { reset } : {}),
      });
      await expect
        .poll(() =>
          page.evaluate(
            (n) => window.__terminalEvents.some((e) => e.type === "vt-ack" && e.sequence === n),
            sequence,
          ),
        )
        .toBe(true);
    };
    // Device attributes, cursor position, a colour query, focus and mouse reporting: xterm would
    // answer each through its data event. The real terminal already did.
    await send(1, "\x1b[2J\x1b[Hprompt$ \x1b[c\x1b[6n\x1b]11;?\x07\x1b[?1004h\x1b[?1000h", {
      cols: 60,
      rows: 10,
    });
    await send(2, "\x1b[1;31mred\x1b[0m");
    const screen = await page.evaluate(() => {
      const text = window.__terminalEvents.filter((e) => e.type === "vt-status").at(-1)?.cursorLine;
      return text;
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.__terminalEvents.filter((e) => e.type === "vt-status").at(-1)),
      )
      .toMatchObject({ alternate: false, cursorLine: expect.stringContaining("prompt$ red") });
    expect(screen === undefined || typeof screen === "string").toBe(true);
    await page.locator(".xterm-screen").click();
    await command(page, { type: "focus" });
    await page.locator(".xterm-helper-textarea").press("ArrowUp");
    await page.locator(".xterm-helper-textarea").press("x");
    const inputs = await page.evaluate(() =>
      window.__terminalEvents.filter((e) => e.type === "input").map((e) => e.data),
    );
    // Only the keys pressed; no `\x1b[?…c`, `\x1b[1;9R`, colour, focus or mouse report.
    expect(inputs).toEqual(["\x1b[A", "x"]);
    // A full-screen program switches the reported screen.
    await send(3, "\x1b[?1049h\x1b[Hvim");
    await expect
      .poll(() =>
        page.evaluate(() => window.__terminalEvents.filter((e) => e.type === "vt-status").at(-1)),
      )
      .toMatchObject({ alternate: true });
    // A gap in the sequence is refused, so the app replays from the starting point.
    await page.evaluate(
      (doc) => window.shellbellVt({ document: doc, sequence: 9, data: "" }),
      document,
    );
    expect(
      await page.evaluate(() => window.__terminalEvents.some((e) => e.type === "vt-error")),
    ).toBe(true);
  });
}
