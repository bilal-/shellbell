// Local, offline renderer qualification. No service connection or customer data.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const source = await readFile(new URL("../src/terminal/gen/document.ts", import.meta.url), "utf8");
const html = JSON.parse(source.match(/^export const terminalHtml: string = (.*);$/m)[1]);
createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}).listen(8767, "127.0.0.1", () => console.log("Offline terminal fixture: http://127.0.0.1:8767"));
