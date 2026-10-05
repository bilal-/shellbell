import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/cli.ts", "src/server.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  dts: false,
  fixedExtension: false,
  deps: {
    neverBundle: ["ws"],
    alwaysBundle: [/^@shellbell\//, "cborg", /^@noble\//, "zod"],
    onlyBundle: ["cborg", "@noble/hashes", "@noble/curves", "zod"],
  },
});
