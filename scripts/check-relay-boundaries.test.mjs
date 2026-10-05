import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-relay-boundaries.mjs", import.meta.url));

function fixture(t, files = {}, config = {}, manifest = {}) {
  const root = mkdtempSync(join(tmpdir(), "shellbell-relay-boundaries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contents = {
    "packages/relay-core/package.json": JSON.stringify({
      name: "@shellbell/relay-core",
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      ...manifest,
    }),
    "packages/relay-core/tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        lib: ["ES2022", "DOM"],
        types: [],
        ...config,
      },
      include: ["src"],
    }),
    "packages/relay-core/src/index.ts": "export const portable = true;",
    "packages/protocol/src/index.ts": "export const fingerprint = 'synthetic';",
    "packages/relay-core/node_modules/@shellbell/protocol/package.json": JSON.stringify({
      name: "@shellbell/protocol",
      types: "../../../../protocol/src/index.ts",
    }),
    ...files,
  };
  for (const [name, contentsOfFile] of Object.entries(contents)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contentsOfFile);
  }
  return root;
}

function run(root) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [checker, root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const output = `${error.stdout}${error.stderr}`;
    assert.match(
      output,
      /Relay boundary check:/,
      "the checker must run before its rejection counts",
    );
    return { status: error.status, output };
  }
}

test("permits protocol imports, internal aliases and browser globals; ignores ordinary strings", (t) => {
  const root = fixture(
    t,
    {
      "packages/relay-core/src/index.ts": `
      import { fingerprint } from "@shellbell/protocol";
      export { local } from "@local";
      export const bytes = new TextEncoder().encode(fingerprint);
      export const documentation = "node:fs cloudflare:workers @cloudflare/workers-types";
      // import fs from "node:fs";
    `,
      "packages/relay-core/src/local.ts": "export const local = new Uint8Array(1);",
    },
    { paths: { "@local": ["./src/local.ts"] } },
  );
  const result = run(root);
  assert.equal(result.status, 0, result.output);
});

for (const specifier of [
  "cloudflare:workers",
  "node:fs",
  "fs/promises",
  "@cloudflare/workers-types",
  "@cloudflare/vitest-pool-workers",
  "better-sqlite3",
  "sqlite3",
  "postgres",
  "pg",
  "@libsql/client",
  "mysql2",
  "@shellbell/relay",
]) {
  test(`rejects runtime-specific import ${specifier}`, (t) => {
    const root = fixture(t, {
      "packages/relay-core/src/index.ts": `import provider from '${specifier}';`,
    });
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /forbidden-import/);
  });
}

for (const statement of [
  'export * from "node:fs";',
  'export type { Stats } from "node:fs";',
  'export * as platform from "cloudflare:workers";',
  'const platform = import("node:fs");',
  'type Platform = import("node:fs").Stats;',
  'import platform = require("node:fs");',
  'const platform = require("node:fs");',
  "const platform = import(provider);",
  "const platform = require(provider);",
  '/// <reference types="@cloudflare/workers-types" />',
]) {
  test(`rejects module reference ${statement}`, (t) => {
    const result = run(fixture(t, { "packages/relay-core/src/index.ts": statement }));
    assert.equal(result.status, 1, result.output);
  });
}

test("rejects a tsconfig alias that resolves into an app even if its name looks portable", (t) => {
  const result = run(
    fixture(
      t,
      {
        "packages/relay-core/src/index.ts": 'export { adapter } from "@portable";',
        "apps/relay/src/adapter.ts": "export const adapter = true;",
      },
      { paths: { "@portable": ["../../apps/relay/src/adapter.ts"] } },
    ),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /outside-core/);
});

test("checks local modules that are not exported by the entrypoint", (t) => {
  const result = run(
    fixture(t, {
      "packages/relay-core/src/unreferenced.ts": 'import "node:net";',
    }),
  );
  assert.equal(result.status, 1, result.output);
});

test("rejects protocol transitive imports into runtime-specific code", (t) => {
  const result = run(
    fixture(t, {
      "packages/relay-core/src/index.ts": 'export { fingerprint } from "@shellbell/protocol";',
      "packages/protocol/src/index.ts": 'export { fingerprint } from "./provider.js";',
      "packages/protocol/src/provider.ts":
        'import "node:crypto"; export const fingerprint = "synthetic";',
    }),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /forbidden-import/);
});

test("rejects an approved package name symlinked to an app implementation", (t) => {
  const root = fixture(t, {
    "packages/relay-core/src/index.ts": 'export * from "@shellbell/protocol";',
    "apps/relay/src/index.ts": "export const adapter = true;",
  });
  rmSync(join(root, "packages/relay-core/node_modules/@shellbell/protocol"), { recursive: true });
  symlinkSync(
    join(root, "apps/relay"),
    join(root, "packages/relay-core/node_modules/@shellbell/protocol"),
  );
  writeFileSync(
    join(root, "apps/relay/package.json"),
    JSON.stringify({
      name: "@shellbell/protocol",
      types: "./src/index.ts",
    }),
  );
  const result = run(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /outside-core/);
});

test("permits an explicitly approved browser package", (t) => {
  const result = run(
    fixture(t, {
      "packages/relay-core/src/index.ts": 'export { browserSchema } from "zod";',
      "packages/relay-core/node_modules/zod/package.json": JSON.stringify({
        name: "zod",
        types: "./index.d.ts",
      }),
      "packages/relay-core/node_modules/zod/index.d.ts":
        "export declare const browserSchema: unknown;",
    }),
  );
  assert.equal(result.status, 0, result.output);
});

test("rejects an installed SQL driver hidden behind a paths alias", (t) => {
  const result = run(
    fixture(
      t,
      {
        "packages/relay-core/src/index.ts": 'export { Database } from "@portable";',
        "packages/relay-core/node_modules/better-sqlite3/package.json": JSON.stringify({
          name: "better-sqlite3",
          types: "./index.d.ts",
        }),
        "packages/relay-core/node_modules/better-sqlite3/index.d.ts":
          "export declare const Database: unknown;",
      },
      { paths: { "@portable": ["./node_modules/better-sqlite3/index.d.ts"] } },
    ),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /outside-core/);
});

test("rejects an approved-name alias that resolves to an installed SQL driver without packageId", (t) => {
  const result = run(
    fixture(
      t,
      {
        "packages/relay-core/src/index.ts": 'export { Database } from "zod";',
        "packages/relay-core/node_modules/better-sqlite3/package.json": JSON.stringify({
          name: "better-sqlite3",
        }),
        "packages/relay-core/node_modules/better-sqlite3/index.d.ts":
          "export declare const Database: unknown;",
      },
      { paths: { zod: ["./node_modules/better-sqlite3/index.d.ts"] } },
    ),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /forbidden-import/);
});

test("rejects an approved-name alias when the resolved package owner is unknown", (t) => {
  const result = run(
    fixture(
      t,
      {
        "packages/relay-core/src/index.ts": 'export { schema } from "zod";',
        "packages/relay-core/node_modules/unowned/index.d.ts":
          "export declare const schema: unknown;",
      },
      { paths: { zod: ["./node_modules/unowned/index.d.ts"] } },
    ),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /forbidden-import/);
});

test("permits an approved-name alias to a genuine browser subpath with an unnamed nested manifest", (t) => {
  const result = run(
    fixture(
      t,
      {
        "packages/relay-core/src/index.ts": 'export { schema } from "zod";',
        "packages/relay-core/node_modules/zod/package.json": JSON.stringify({ name: "zod" }),
        "packages/relay-core/node_modules/zod/v4/core/package.json": JSON.stringify({
          type: "module",
        }),
        "packages/relay-core/node_modules/zod/v4/core/index.d.ts":
          "export declare const schema: unknown;",
      },
      { paths: { zod: ["./node_modules/zod/v4/core/index.d.ts"] } },
    ),
  );
  assert.equal(result.status, 0, result.output);
});

test("permits a genuine approved browser package in a pnpm symlink layout", (t) => {
  const root = fixture(t, {
    "packages/relay-core/src/index.ts": 'export { schema } from "zod";',
    "node_modules/.pnpm/zod@1.0.0/node_modules/zod/package.json": JSON.stringify({
      name: "zod",
      types: "./index.d.ts",
    }),
    "node_modules/.pnpm/zod@1.0.0/node_modules/zod/index.d.ts":
      "export declare const schema: unknown;",
  });
  symlinkSync(
    join(root, "node_modules/.pnpm/zod@1.0.0/node_modules/zod"),
    join(root, "packages/relay-core/node_modules/zod"),
  );
  const result = run(root);
  assert.equal(result.status, 0, result.output);
});

test("rejects a source symlink that exposes test support", (t) => {
  const root = fixture(t, {
    "packages/relay-core/test-support/client.ts": "export const testClient = true;",
  });
  symlinkSync(
    join(root, "packages/relay-core/test-support/client.ts"),
    join(root, "packages/relay-core/src/leak.ts"),
  );
  const result = run(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /outside-core|test-support/);
});

test("rejects production re-exports of test support through a local barrel", (t) => {
  const result = run(
    fixture(t, {
      "packages/relay-core/src/index.ts": 'export * from "./barrel.js";',
      "packages/relay-core/src/barrel.ts": 'export * from "../test-support/client.js";',
      "packages/relay-core/test-support/client.ts": "export const testClient = true;",
    }),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /test-support/);
});

test("rejects test-support leaks through resolved aliases", (t) => {
  const result = run(
    fixture(
      t,
      {
        "packages/relay-core/src/index.ts": 'export * from "@support";',
        "packages/relay-core/test-support/client.ts": "export const testClient = true;",
      },
      { paths: { "@support": ["./test-support/client.ts"] } },
    ),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /test-support/);
});

for (const manifest of [
  { exports: { ".": { import: "./src/index.ts", types: "./test-support/client.ts" } } },
  { exports: { ".": "./src/index.ts", "./test-support/*": "./test-support/*.ts" } },
  { main: "./test-support/client.ts" },
  { types: "./test-support/client.ts" },
  { exports: { ".": "./entry.ts" } },
]) {
  test(`rejects a production manifest escape ${JSON.stringify(manifest)}`, (t) => {
    const result = run(
      fixture(
        t,
        {
          "packages/relay-core/test-support/client.ts": "export const testClient = true;",
          "packages/relay-core/entry.ts": 'export * from "./test-support/client.js";',
        },
        {},
        manifest,
      ),
    );
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /production-export/);
  });
}

test("rejects unresolved modules rather than silently skipping their dependency graph", (t) => {
  const result = run(
    fixture(t, { "packages/relay-core/src/index.ts": 'export * from "./missing.js";' }),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /unresolved-import/);
});

test("rejects Workers ambient types in the source compiler configuration", (t) => {
  const result = run(fixture(t, {}, { types: ["@cloudflare/workers-types"] }));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /source-types/);
});

for (const statement of [
  'import { claimJob } from "@shellbell/relay-core";',
  'import { DatabaseSync } from "node:sqlite";',
  'import { claimJob } from "./connection.js";',
  'export { claimJob } from "@shellbell/relay-core";',
  'const policy = import("@shellbell/relay-core");',
]) {
  test(`rejects Node composition policy/storage bypass: ${statement}`, (t) => {
    const result = run(fixture(t, { "apps/relay-node/src/server.ts": statement }));
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /composition-import/);
  });
}

test("allows the named Node connection binder in the composition root", (t) => {
  const result = run(
    fixture(t, {
      "apps/relay-node/src/server.ts": 'import { bindNodeConnection } from "./connection.js";',
    }),
  );
  assert.equal(result.status, 0, result.output);
});

test("rejects policy imports in the Cloudflare composition root", (t) => {
  const result = run(
    fixture(t, {
      "apps/relay/src/computer-do.ts": 'import { PushJobs } from "./push-jobs.js";',
    }),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /composition-import/);
});

test("rejects business SQL in the Cloudflare composition root", (t) => {
  const result = run(
    fixture(t, {
      "apps/relay/src/computer-do.ts":
        'class ComputerDO { alarm() { this.ctx.storage.sql.exec("DELETE FROM pairings"); } }',
    }),
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /composition-storage/);
});

test("allows only schema initialization SQL in the composition root", (t) => {
  const result = run(
    fixture(t, {
      "apps/relay/src/computer-do.ts":
        'import { SCHEMA_SQL, upgradePushContextSchema, upgradeRevocationProofSchema, upgradePairIdSchema } from "./schema.js"; class ComputerDO { constructor(ctx) { ctx.storage.sql.exec(SCHEMA_SQL); upgradePushContextSchema(ctx.storage.sql); upgradeRevocationProofSchema(ctx.storage.sql); upgradePairIdSchema(ctx.storage.sql); } }',
    }),
  );
  assert.equal(result.status, 0, result.output);
});

test("the repository passes its own boundary check", () => {
  const result = run(resolve(dirname(checker), ".."));
  assert.equal(result.status, 0, result.output);
});
