/** Run with a Playwright Page against serve-terminal-fixture.mjs.
 * Exercises the generated shipping HTML, not a mocked terminal. No OS clipboard,
 * real service connection or customer terminal content is used.
 */
export async function qualifyTerminal(page, url = "http://127.0.0.1:8767", renderer = "webgl") {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.addInitScript((renderer) => {
    window.__events = [];
    window.ReactNativeWebView = { postMessage: (value) => window.__events.push(JSON.parse(value)) };
    if (renderer === "dom") {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        return type.startsWith("webgl") ? null : original.call(this, type, ...args);
      };
    }
  }, renderer);
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto(url);
  await page.waitForFunction(() => window.__events.some((event) => event.type === "ready"));
  check(
    (await page.locator("#terminal").getAttribute("data-renderer")) === renderer,
    `Expected ${renderer} renderer`,
  );
  const documentId = await page.evaluate(
    () => window.__events.find((event) => event.type === "ready").document,
  );
  let revision = 0;
  const model = {
    cols: 223,
    fontSize: 14,
    fitWidth: false,
    cursor: { key: "r:999", x: 5, accent: "#10b981", blinking: false },
  };
  const send = async (patch) => {
    const next = ++revision;
    await page.evaluate((frame) => window.shellbellReceive(frame), {
      document: documentId,
      revision: next,
      ...model,
      ...patch,
    });
    await page.waitForFunction(
      (value) => window.__events.some((event) => event.type === "ack" && event.revision === value),
      next,
    );
  };
  const viewport = () =>
    page.evaluate(() => ({
      top: document.getElementById("scroll").scrollTop,
      key: window.__events.filter((event) => event.type === "viewport").at(-1)?.topKey,
    }));
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    key: `r:${index}`,
    absoluteRow: index,
    history: index < 970,
    line: {
      r: [
        {
          t: `row ${String(index).padStart(5, "0")} 漢字 é 👩‍💻 <script>literal</script> `,
          fg: index % 16,
        },
      ],
    },
  }));
  await send({ order: rows.map((row) => row.key), upsert: rows });
  const checkVisibleBounds = async () => {
    const bounds = await page.evaluate(() => {
      const scroller = document.getElementById("scroll");
      const height = Number(document.getElementById("terminal").dataset.cellHeight);
      const event = window.__events.filter((event) => event.type === "viewport").at(-1);
      return {
        top: event.topKey,
        bottom: event.bottomKey,
        expectedTop: `r:${Math.floor(scroller.scrollTop / height)}`,
        expectedBottom: `r:${Math.min(999, Math.ceil((scroller.scrollTop + scroller.clientHeight) / height) - 1)}`,
      };
    });
    check(
      bounds.top === bounds.expectedTop && bounds.bottom === bounds.expectedBottom,
      `Selection bounds include an overscan row or miss a partially visible row: ${JSON.stringify(bounds)}`,
    );
  };
  await checkVisibleBounds();
  await page.mouse.move(250, 300);
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(() =>
    window.__events.some((event) => event.type === "viewport" && !event.following),
  );
  const before = await viewport();
  await checkVisibleBounds();
  const prefix = Array.from({ length: 20 }, (_, index) => ({
    key: `p:${index}`,
    history: true,
    line: { r: [{ t: `earlier ${index}` }] },
  }));
  await send({ order: [...prefix, ...rows].map((row) => row.key), upsert: prefix });
  const prepended = await viewport();
  check(
    prepended.key === before.key && prepended.top > before.top,
    "Prepending history lost the source anchor",
  );
  await page.setViewportSize({ width: 800, height: 390 });
  await page.waitForFunction(() => document.getElementById("scroll").clientWidth === 800);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  check((await viewport()).key === before.key, "Rotation lost the source anchor");
  model.fontSize = 24;
  await send({ upsert: [] });
  check((await viewport()).key === before.key, "Font resize lost the source anchor");

  const copy = () =>
    page.evaluate(() => {
      const data = new DataTransfer();
      document
        .querySelector(".xterm-helper-textarea")
        .dispatchEvent(
          new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      return data.getData("text/plain");
    });
  // Align the first row before selecting; preserve the same source key.
  await page.evaluate(() => {
    const scroll = document.getElementById("scroll");
    const surface = document.getElementById("terminal");
    scroll.scrollTop = Number.parseFloat(surface.style.top);
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.mouse.move(2, 12);
  await page.mouse.down();
  await page.mouse.move(145, 12, { steps: 10 });
  await page.mouse.up();
  const selected = await copy();
  check(selected.length > 0, "Synthetic text selection did not start");
  await send({ upsert: [{ ...rows[999], line: { r: [{ t: "unrelated live update" }] } }] });
  check((await copy()) === selected, "Unrelated live output cleared a copy selection");
  const selectedKey = (await viewport()).key;
  await send({
    upsert: [{ key: selectedKey, history: true, line: { r: [{ t: "changed source text" }] } }],
  });
  check((await copy()) === "", "A stale selection copied changed source text");

  const times = [];
  for (let index = 0; index < 120; index++) {
    const started = Date.now();
    await send({ upsert: [{ ...rows[999], line: { r: [{ t: `update ${index}` }] } }] });
    times.push(Date.now() - started);
  }
  check((await viewport()).key === selectedKey, "Repeated output moved a reader away from history");
  // Widen xterm's asynchronous write window to expose a reset that renders a
  // blank frame before replacement text is parsed. Observe actual DOM frames,
  // not just the final ACK (which would hide flicker on slower WebViews).
  let transient = null;
  if (renderer === "dom") {
    await page.waitForFunction(() => document.querySelector(".xterm-rows").textContent.trim());
    transient = await page.evaluate(
      async (frame) => {
        const nativeTimeout = window.setTimeout;
        let empty = 0;
        let samples = 0;
        let observing = true;
        window.setTimeout = (fn, ms, ...args) =>
          nativeTimeout(fn, ms === undefined || ms === 0 ? 80 : ms, ...args);
        const observe = () => {
          if (!observing) return;
          samples++;
          if (!document.querySelector(".xterm-rows").textContent.trim()) empty++;
          requestAnimationFrame(observe);
        };
        try {
          requestAnimationFrame(observe);
          window.shellbellReceive(frame);
          await new Promise((resolve, reject) => {
            const deadline = Date.now() + 3000;
            const poll = () => {
              if (
                window.__events.some(
                  (event) => event.type === "ack" && event.revision === frame.revision,
                )
              )
                resolve();
              else if (Date.now() > deadline)
                reject(new Error("Delayed paint did not acknowledge"));
              else nativeTimeout(poll, 10);
            };
            poll();
          });
          await new Promise(requestAnimationFrame);
          return { empty, samples };
        } finally {
          observing = false;
          window.setTimeout = nativeTimeout;
        }
      },
      { document: documentId, revision: ++revision, ...model, upsert: [] },
    );
    check(transient.samples > 1, "Delayed paint did not span observable frames");
    check(transient.empty === 0, `Snapshot redraw exposed ${transient.empty} blank frames`);
  }
  model.cursor.key = "r:0";
  await send({ upsert: [] });
  const oldTop = (await viewport()).top;
  await page.mouse.move(250, 150);
  await page.mouse.wheel(0, -100);
  await page.waitForFunction((top) => document.getElementById("scroll").scrollTop < top, oldTop);
  const olderBefore = await page.evaluate(
    () => window.__events.filter((event) => event.type === "older").length,
  );
  await page.evaluate(() => window.shellbellJumpToLive());
  await page.waitForFunction(
    () => window.__events.filter((event) => event.type === "viewport").at(-1)?.following === true,
  );
  await page.evaluate(() => new Promise(requestAnimationFrame));
  check(
    (await page.evaluate(
      () => window.__events.filter((event) => event.type === "older").length,
    )) === olderBefore,
    "Jump to live consumed a stale history gesture",
  );
  // Erasing cells must not leave selection coordinates pointing at replacement
  // text when the selected source key disappears from bounded history.
  await page.evaluate(() => {
    document.getElementById("scroll").scrollTop = Number.parseFloat(
      document.getElementById("terminal").style.top,
    );
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.mouse.move(2, 12);
  await page.mouse.down();
  await page.mouse.move(145, 12, { steps: 10 });
  await page.mouse.up();
  check((await copy()).length > 0, "Eviction selection did not start");
  const evictedKey = (await viewport()).key;
  await send({
    order: [...prefix, ...rows].map((row) => row.key).filter((key) => key !== evictedKey),
    upsert: [],
  });
  check((await copy()) === "", "Evicted selection copied unrelated replacement text");

  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => /^https?:/.test(entry.name))
      .map((entry) => entry.name),
  );
  check(resources.length === 0, "Offline terminal unexpectedly requested a network resource");
  times.sort((a, b) => a - b);
  return {
    renderer,
    sourceAnchor: before.key,
    prependOffset: [before.top, prepended.top],
    selected,
    frames: times.length,
    transient,
    medianMs: times[60],
    p95Ms: times[114],
    networkResources: resources,
  };
}

/** Real addon activation, trusted link click and mid-session GPU context loss. */
export async function qualifyTerminalAddons(page, url = "http://127.0.0.1:8767") {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.addInitScript(() => {
    window.__events = [];
    window.ReactNativeWebView = { postMessage: (value) => window.__events.push(JSON.parse(value)) };
  });
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto(url);
  await page.waitForFunction(() => window.__events.some((event) => event.type === "ready"));
  check(
    (await page.locator("#terminal").getAttribute("data-renderer")) === "webgl",
    "GPU did not activate",
  );
  const documentId = await page.evaluate(
    () => window.__events.find((event) => event.type === "ready").document,
  );
  const frame = {
    document: documentId,
    revision: 1,
    cols: 80,
    fontSize: 14,
    fitWidth: false,
    cursor: null,
    order: ["link", "unsafe", "text"],
    upsert: [
      { key: "link", line: { r: [{ t: "https://example.com/terminal-qa" }] } },
      { key: "unsafe", line: { r: [{ t: "javascript:alert(1)" }] } },
      { key: "text", line: { r: [{ t: "漢字 é 👩‍💻 GPU context-loss fixture", fg: 2 }] } },
    ],
  };
  await page.evaluate((frame) => window.shellbellReceive(frame), frame);
  await page.waitForFunction(() =>
    window.__events.some((event) => event.type === "ack" && event.revision === 1),
  );
  // WebLinks resolves asynchronously on hover before accepting a click.
  const height = await page.locator("#terminal").getAttribute("data-cell-height");
  await page.mouse.move(60, Number(height) / 2);
  await page.waitForFunction(
    () => getComputedStyle(document.elementFromPoint(60, 9)).cursor === "pointer",
  );
  await page.evaluate((height) => {
    const target = document.elementFromPoint(60, height / 2);
    for (const type of ["mousedown", "mouseup", "click"]) {
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: 60, clientY: height / 2 }),
      );
    }
  }, Number(height));
  check(
    await page.evaluate(() => !window.__events.some((event) => event.type === "link")),
    "Synthetic activation opened a link",
  );
  await page.mouse.click(60, Number(height) / 2);
  await page.waitForFunction(() => window.__events.some((event) => event.type === "link"));
  const link = await page.evaluate(() => window.__events.find((event) => event.type === "link"));
  check(
    link.document === documentId && link.url === "https://example.com/terminal-qa",
    "Link bridge payload was wrong",
  );
  check(page.url() === `${url}/`, "Terminal navigated instead of posting to native");
  const copySelection = () =>
    page.evaluate(() => {
      const data = new DataTransfer();
      document
        .querySelector(".xterm")
        .dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true }));
      return data.getData("text/plain");
    });
  await page.mouse.move(2, Number(height) * 2.5);
  await page.mouse.down();
  await page.mouse.move(145, Number(height) * 2.5, { steps: 10 });
  await page.mouse.up();
  const selected = await copySelection();
  check(selected.length > 0, "Context-loss fixture has no selection");
  const before = await page.evaluate(() => ({
    top: document.getElementById("scroll").scrollTop,
    viewport: window.__events.filter((event) => event.type === "viewport").at(-1),
  }));
  await page.evaluate(() => {
    const context = Array.from(document.querySelectorAll(".xterm-screen canvas"))
      .map((canvas) => canvas.getContext("webgl2"))
      .find(Boolean);
    const extension = context.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("Cannot exercise WebGL context loss");
    extension.loseContext();
  });
  await page.waitForFunction(() => document.getElementById("terminal").dataset.renderer === "dom");
  await page.waitForFunction(() =>
    document.querySelector(".xterm-rows")?.textContent.includes("GPU context-loss fixture"),
  );
  const after = await page.evaluate(() => ({
    top: document.getElementById("scroll").scrollTop,
    viewport: window.__events.filter((event) => event.type === "viewport").at(-1),
  }));
  check(JSON.stringify(before) === JSON.stringify(after), "GPU loss changed source viewport");
  check((await copySelection()) === selected, "GPU loss discarded copy selection");
  await page.evaluate((frame) => window.shellbellReceive(frame), {
    ...frame,
    revision: 2,
    upsert: [{ key: "text", line: { r: [{ t: "DOM fallback still updates", fg: 3 }] } }],
  });
  await page.waitForFunction(() =>
    window.__events.some((event) => event.type === "ack" && event.revision === 2),
  );
  await page.waitForFunction(() =>
    document.querySelector(".xterm-rows").textContent.includes("DOM fallback still updates"),
  );
  return {
    link: link.url,
    rendererBefore: "webgl",
    rendererAfter: "dom",
    updatesAfterLoss: true,
    selectionAfterLoss: selected,
  };
}

/** Large source columns must fall back before allocating an oversized GPU canvas. */
export async function qualifyTerminalGpuLimit(page, url = "http://127.0.0.1:8767") {
  await page.addInitScript(() => {
    window.__events = [];
    window.ReactNativeWebView = { postMessage: (value) => window.__events.push(JSON.parse(value)) };
  });
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto(url);
  await page.waitForFunction(() => window.__events.some((event) => event.type === "ready"));
  if ((await page.locator("#terminal").getAttribute("data-renderer")) !== "webgl")
    throw new Error("GPU did not activate");
  const documentId = await page.evaluate(
    () => window.__events.find((event) => event.type === "ready").document,
  );
  await page.evaluate(
    (document) =>
      window.shellbellReceive({
        document,
        revision: 1,
        cols: 4096,
        fontSize: 72,
        fitWidth: false,
        cursor: null,
        order: ["wide"],
        upsert: [{ key: "wide", line: { r: [{ t: "Large source terminal still renders" }] } }],
      }),
    documentId,
  );
  await page.waitForFunction(() =>
    window.__events.some((event) => event.type === "ack" && event.revision === 1),
  );
  await page.waitForFunction(
    () =>
      document.getElementById("terminal").dataset.renderer === "dom" &&
      document
        .querySelector(".xterm-rows")
        ?.textContent.includes("Large source terminal still renders"),
  );
  return { cols: 4096, fontSize: 72, renderer: "dom", acknowledged: true };
}
