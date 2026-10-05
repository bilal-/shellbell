/** Exercise bottom status rows in the generated offline terminal document.
 * Takes a Playwright Page; never connects to a computer or uses its terminal.
 */
export async function qualifyTerminalStatusBars(
  page,
  url = "http://127.0.0.1:8767",
  renderer = "webgl",
) {
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
    cols: 80,
    fontSize: 14,
    fitWidth: false,
    cursor: { key: "live:8", x: 2, accent: "#10b981", blinking: false },
  };
  const send = async (patch) => {
    const next = ++revision;
    await page.evaluate(
      (frame) => {
        if (frame.order) window.__order = frame.order;
        window.shellbellReceive(frame);
      },
      {
        document: documentId,
        revision: next,
        ...model,
        ...patch,
      },
    );
    await page.waitForFunction(
      (value) => window.__events.some((event) => event.type === "ack" && event.revision === value),
      next,
    );
  };
  const viewport = () =>
    page.evaluate(() => {
      const scroll = document.getElementById("scroll");
      const surface = document.getElementById("terminal");
      return {
        ...window.__events.filter((event) => event.type === "viewport").at(-1),
        offset: scroll.scrollTop,
        height: scroll.clientHeight,
        cellHeight: Number(surface.dataset.cellHeight),
        surfaceTop: Number.parseFloat(surface.style.top),
      };
    });
  const expectBottom = async (key) => {
    await page.waitForFunction(
      (key) => {
        const event = window.__events.filter((event) => event.type === "viewport").at(-1);
        if (!event?.following || event.bottomKey !== key) return false;
        const scroll = document.getElementById("scroll");
        const surface = document.getElementById("terminal");
        const count = window.__order.indexOf(key) - window.__order.indexOf(event.topKey) + 1;
        const bottom =
          Number.parseFloat(surface.style.top) +
          count * Number(surface.dataset.cellHeight) -
          scroll.scrollTop;
        return Math.abs(bottom - scroll.clientHeight) < 1;
      },
      key,
      { timeout: 3000 },
    );
    const state = await viewport();
    check(state.following, "Status rows lost Live following");
    return state;
  };
  const history = Array.from({ length: 100 }, (_, i) => ({
    key: `history:${i}`,
    history: true,
    absoluteRow: i,
    line: { r: [{ t: `Earlier output ${i}` }] },
  }));
  const live = Array.from({ length: 60 }, (_, i) => ({
    key: `live:${i}`,
    history: false,
    absoluteRow: 100 + i,
    line: { r: i < 20 ? [{ t: i === 8 ? "> draft on laptop" : `LLM output ${i}` }] : [] },
  }));
  live[58].line = { r: [{ t: "model: example | context: 32%", bg: 8 }] };
  live[59].line = { r: [{ t: "ready | private fixture", fg: 2 }] };
  await send({ order: [...history, ...live].map((row) => row.key), upsert: [...history, ...live] });
  const initial = await expectBottom("live:59");
  if (renderer === "dom") {
    check(
      await page
        .locator(".xterm-rows")
        .innerText()
        .then((text) => text.includes("private fixture")),
      "Visible status text was not painted",
    );
  }

  // The phone keyboard/system insets reduce the document's available height.
  for (const size of [
    { width: 390, height: 310 },
    { width: 800, height: 390 },
    { width: 390, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForFunction(
      (height) => document.getElementById("scroll").clientHeight === height,
      size.height,
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expectBottom("live:59");
  }
  // Same-order updates and cursor moves must not hide an unchanged footer.
  model.cursor.key = "live:2";
  await send({
    upsert: [{ ...live[59], line: { r: [{ t: "working | private fixture", fg: 3 }] } }],
  });
  await expectBottom("live:59");
  await page.mouse.move(250, 300);
  await page.mouse.wheel(0, -1200);
  await page.waitForFunction(
    () => window.__events.filter((event) => event.type === "viewport").at(-1)?.following === false,
  );
  const reading = await viewport();
  await send({ upsert: [{ ...live[59], line: { r: [{ t: "done | private fixture", fg: 2 }] } }] });
  check(
    (await viewport()).offset === reading.offset,
    "A status update interrupted history reading",
  );
  const prefix = Array.from({ length: 20 }, (_, i) => ({
    key: `older:${i}`,
    history: true,
    absoluteRow: i - 20,
    line: { r: [{ t: `Older output ${i}` }] },
  }));
  await send({ order: [...prefix, ...history, ...live].map((row) => row.key), upsert: prefix });
  check((await viewport()).topKey === reading.topKey, "History prepend lost its source anchor");
  model.fontSize = 24;
  await send({ upsert: [] });
  check((await viewport()).topKey === reading.topKey, "Font change lost its source anchor");
  await page.evaluate(() => window.shellbellJumpToLive());
  await expectBottom("live:59");
  model.fitWidth = true;
  await send({ upsert: [] });
  await expectBottom("live:59");

  // A source grid smaller than the phone still puts its last row at the bottom,
  // with empty space above the grid, not a duplicated/fabricated status overlay.
  model.cols = 40;
  model.fontSize = 14;
  model.fitWidth = false;
  const short = live.slice(0, 8).map((row, i) => ({
    ...row,
    absoluteRow: i,
    line: { r: i === 7 ? [{ t: "short status", bg: 8 }] : [{ t: `short ${i}` }] },
  }));
  await send({ order: short.map((row) => row.key), upsert: short });
  const shortState = await expectBottom("live:7");
  const scrollHeight = await page.locator("#scroll").evaluate((node) => node.scrollHeight);
  check(
    scrollHeight === shortState.height,
    "Renderer overscan created blank scroll space below the footer",
  );
  check(shortState.topKey === "live:0", "Padding produced a synthetic source row");
  check(
    Math.abs(shortState.surfaceTop + short.length * shortState.cellHeight - shortState.height) < 1,
    "Small-grid status row did not meet the viewport bottom",
  );
  // Even a blank status strip has visible background cells.
  await send({ upsert: [{ ...short[7], line: { r: [{ t: "", n: 40, bg: 8 }] } }] });
  await expectBottom("live:7");
  // Ordinary shells with blank trailing rows continue following their prompt.
  await send({ upsert: short.slice(3).map((row) => ({ ...row, line: { r: [] } })) });
  const prompt = await viewport();
  check(
    prompt.surfaceTop === 0 && prompt.offset === 0,
    "Blank source rows pushed a short prompt down",
  );
  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => /^https?:/.test(entry.name))
      .map((entry) => entry.name),
  );
  check(resources.length === 0, "Offline terminal requested a network resource");
  return {
    renderer,
    initialBottom: initial.bottomKey,
    historyAnchor: reading.topKey,
    shortGridPadding: shortState.surfaceTop,
    networkResources: resources,
  };
}
