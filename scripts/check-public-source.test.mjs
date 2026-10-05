import assert from "node:assert/strict";
import { test } from "node:test";

const implementation = await import("./check-public-source.mjs").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
test("reports private owner references without repeating matched content", () => {
  assert.equal(typeof implementation.scanFiles, "function");
  assert.deepEqual(
    implementation.scanFiles(
      [{ path: "package.json", content: "public\nhttps://example.invalid/HiddenOwner/app" }],
      [{ name: "private-owner", pattern: /hiddenowner/i }],
    ),
    [{ path: "package.json", line: 2, rule: "private-owner" }],
  );
});
test("allows public branding and catches every occurrence with global expressions", () => {
  assert.equal(typeof implementation.scanFiles, "function");
  assert.deepEqual(
    implementation.scanFiles(
      [
        { path: "README.md", content: "Shellbell" },
        { path: "config.json", content: "hiddenowner\nhiddenowner" },
      ],
      [{ name: "owner", pattern: /hiddenowner/gi }],
    ),
    [
      { path: "config.json", line: 1, rule: "owner" },
      { path: "config.json", line: 2, rule: "owner" },
    ],
  );
});
test("rejects credentials and identifying local paths with built-in rules", () => {
  assert.equal(typeof implementation.scanFiles, "function");
  assert.deepEqual(
    implementation.scanFiles([
      {
        path: "config.txt",
        content:
          ["", "Users", "private-user", "workspace", "project"].join("/") +
          "\n" +
          ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      },
    ]),
    [
      { path: "config.txt", line: 1, rule: "local-home" },
      { path: "config.txt", line: 2, rule: "private-key" },
    ],
  );
});
