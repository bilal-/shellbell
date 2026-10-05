// Drift guard between committed SVG sources and what the generators produce from shared geometry
// today. Mirrors scripts/sync-vectors.mjs --check.
//
// Two independent checks:
//   1. The app icon's SVG sources (apps/mobile/assets/brand/*.svg) against
//      apps/mobile/scripts/extract-glyphs.mjs.
//   2. The logo family (brand/svg/*.svg, for the website/README/press -- separate from the app
//      icon) against scripts/extract-brand-family.mjs at the repo root.
//
// Each re-runs its generator into a scratch directory (via an env var the generator reads to
// redirect its output) and byte-compares the result against the committed SVGs -- extraction is
// deterministic, so any difference means the symbol, wordmark font, or framing changed without
// regenerating and committing the output.
//
// Deliberately SVG-only: PNGs are NOT byte-compared here, for either check. Raster output depends
// on the installed libvips version, so comparing rendered PNGs across machines/CI images would
// flake.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Re-run `generator` (with `envVar` pointed at a scratch directory) and byte-compare its output
 * against the committed `files` in `committedDir`. Exits the process with `remedy` printed if
 * anything is stale.
 */
function checkDrift({ label, generator, envVar, committedDir, files, remedy }) {
  const scratch = mkdtempSync(join(tmpdir(), "shellbell-brand-check-"));
  try {
    execFileSync(process.execPath, [generator], {
      env: { ...process.env, [envVar]: scratch },
      stdio: "inherit",
    });

    const stale = files.filter(
      (f) => !readFileSync(join(committedDir, f)).equals(readFileSync(join(scratch, f))),
    );

    if (stale.length > 0) {
      console.error(`brand: stale ${label} SVG source(s): ${stale.join(", ")}`);
      console.error(`brand: ${remedy}`);
      process.exit(1);
    }
    console.log(`brand: ${label} SVG sources match the generator (no drift)`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- 1. App icon sources ---
checkDrift({
  label: "app icon",
  generator: join(here, "extract-glyphs.mjs"),
  envVar: "SHELLBELL_BRAND_OUT",
  committedDir: join(here, "../assets/brand"),
  files: ["monogram.svg", "lockup.svg"],
  remedy: "run `pnpm -F @shellbell/mobile run brand:extract` and commit the result",
});

// --- 2. Logo family (website/README/press) ---
const FAMILY_VARIANTS = ["mark", "wordmark", "horizontal", "stacked"];
checkDrift({
  label: "family",
  generator: join(here, "../../../scripts/extract-brand-family.mjs"),
  envVar: "SHELLBELL_BRAND_FAMILY_SVG_OUT",
  committedDir: join(here, "../../../brand/svg"),
  files: FAMILY_VARIANTS.flatMap((v) =>
    ["on-dark", "on-light", "black", "white"].map((c) => `${v}-${c}.svg`),
  ),
  remedy: "run `pnpm brand:family` from the repo root and commit the result",
});
