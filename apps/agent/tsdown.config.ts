import { defineConfig } from "tsdown";
import bundledDependencies from "./bundled-dependencies.json" with { type: "json" };

export default defineConfig({
  entry: ["src/cli.ts", "src/native-controller.ts", "src/native-service.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // This is a CLI bin, not a library -- nobody imports types from `dist/cli.js`. Declarations
  // also trip up tsdown's dts bundler on @shellbell/protocol's re-exports (SessionInfo,
  // BackendName, Capabilities, CreateWhere resolve fine for `tsc --noEmit` but not through
  // rolldown's separate dts-rollup pass), so skip dts generation entirely rather than fight it.
  dts: false,
  deps: {
    // Bundle the workspace package AND its own deps: cborg / @noble/* are NOT runtime deps of
    // the published `shellbell` tarball, so leaving them external produces a dist/cli.js that
    // imports packages nobody installs. `zod` stays external because it IS a declared runtime
    // dep. (`neverBundle`/`alwaysBundle` replace tsdown's deprecated top-level `external` /
    // `noExternal`.)
    neverBundle: [
      "#terminal-plugin-loader",
      "ws",
      "@bufbuild/protobuf",
      "commander",
      "qrcode-terminal",
      "zod",
      "node-datachannel",
    ],
    alwaysBundle: [/^@shellbell\//, "cborg", /^@noble\//],
    // Keep tsdown's bundled-dependency check active and make the intentionally bundled
    // package set explicit. This must track alwaysBundle and the produced CLI bundle.
    onlyBundle: bundledDependencies,
  },
  // tsdown 0.23's default `fixedExtension: true` (for platform: "node") always emits `.mjs`
  // regardless of the package's `"type": "module"`; the package's bin field is `dist/cli.js`
  // (matching this repo's other packages), so force the extension tsdown would otherwise pick
  // for an ESM package with fixedExtension off.
  fixedExtension: false,
  // Bundled deps (cborg, @noble/*) ship JSDoc `@example`s like `import { decode } from 'cborg'`
  // in their own source. Unminified, those comments survive into dist/cli.js verbatim and trip
  // `scripts/check-bundle.mjs`'s bare-import scan (it has no comment awareness, by design — it
  // must also catch a real leaked import inside a string). Minifying strips comments, which is
  // what actually resolves the false positive; it also shrinks the published tarball.
  minify: true,
  // Tried `sourcemap: true` (R66b): the .map came out ~1.09 MB against a 207 KB bundle (it
  // embeds `sourcesContent` for every bundled dep, incl. cborg/@noble/*) -- over 5x tarball
  // bloat for a `npx shellbell` CLI that should stay small, so left off. A crash still prints
  // a full (if minified) stack via cli.ts's top-level `console.error(err)`.
  sourcemap: false,
});
