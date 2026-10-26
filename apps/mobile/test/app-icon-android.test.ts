import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Text: "Text" }));

it("names the same icons on Android as on iOS", async () => {
  const ios = readFileSync(join(__dirname, "../src/ui/AppIcon.tsx"), "utf8");
  const android = readFileSync(join(__dirname, "../src/ui/AppIcon.android.tsx"), "utf8");
  const names = (source: string, pattern: RegExp) =>
    [...source.matchAll(pattern)].map((match) => match[1]).sort();
  expect(names(android, /^ {2}(\w+): "\\u\{F[0-9A-F]{4}\}",$/gm)).toEqual(
    names(ios, /^ {2}(\w+): \{ ios:/gm),
  );
});

it("draws icons from the Nerd Font glyphs the app already ships", async () => {
  const { FONT } = await import("../src/theme/tokens");
  const { AppIcon } = await import("../src/ui/AppIcon.android");
  const icon = AppIcon({ name: "settings", size: 18, color: "#fff" });
  expect(icon.props.children).toBe("\u{F0493}");
  expect(icon.props.style).toMatchObject({ fontFamily: FONT.regular, fontSize: 18, width: 18 });
  expect(icon.props.accessible).toBe(false);
});
