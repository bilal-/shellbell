# Shellbell brand design

Status: **terminal-attention identity approved by Bilal, 2026-09-20; glossy and platform variants implemented.**

**Brand errata 2026-09-20: source: Bilal's approval of the new terminal-prompt concept and request for glossy icons, mobile/desktop/service variants, and a white macOS menu-bar mark.** This revision supersedes the earlier `$/backslash/a` escape-sequence identity, muted lettering, top-left anchoring, and rejection of a custom chevron. Historical execution records describe the previous design; this document is the current authority. The product's functional specification and release gates are unchanged.

## 1. The idea

Shellbell brings a terminal to you when it needs attention. Its symbol is a bold custom `>` prompt, a horizontal cursor, and two short attention rays above that cursor. Four simple shapes communicate terminal + notification without a literal bell or knowledge of shell escape syntax. BEL (`\a`, Ctrl-G) remains the origin of the name, not the visual mark.

Use the same symbol for the mobile client, future desktop clients, and computer service. It is drawn once in `scripts/brand-art.mjs`; all vector and raster assets derive from that geometry. The design must survive monochrome, small sizes, circular masks, and dark or light surroundings.

## 2. Logo family and composition

- **Mark:** terminal-attention symbol, amber by default.
- **Wordmark:** lowercase `shellbell`, one high-contrast color throughout. No faded `shell` or differently colored `bell`.
- **Horizontal:** mark followed by wordmark; preferred website, README, and press lockup.
- **Stacked:** centered mark above wordmark; compact promotional layouts.
- Each composition ships **on-dark, on-light, black, and white**, as outlined SVG and transparent PNG at 128px and 256px height.

The approved imagegen concept is a visual reference. Production uses custom vector geometry and the existing licensed JetBrains Mono Bold outlines for a deterministic wordmark. The generated concept's exact lettering is not a font source. Exported SVG logos contain no live text, external images, or font dependencies.

Clear space: keep at least one cursor thickness around the standalone symbol and one lowercase letter height around lockups. Do not stretch, rotate, mirror, rearrange the rays, add a bell, or place the logo on a similarly colored background. On light surfaces use the provided on-light lockup; use black for small single-color marks that require stronger contrast than amber.

## 3. Color and typography

| Role | Value | Use |
| --- | --- | --- |
| Amber | `#F59E0B` | Primary app and brand symbol |
| Ink | `#17191D` | Light-background wordmark and dark icon plate |
| Paper | `#F8F7F4` | Dark-background wordmark and service symbol |
| Pure white / black | `#FFFFFF` / `#000000` | Template masks and monochrome exports |
| Gloss plate | `#353942` → `#17191D` → `#090B0E` | App-icon depth only |

JetBrains Mono remains the product typeface and production wordmark source. Brand typography is lowercase and readable; a tagline is optional copy, never part of the symbol. The concept's “Terminal, within reach.” is exploratory; the existing product line “Your terminal rings. You answer.” remains valid.

Brand colors do not replace the app's eight per-computer accents or the current notification accent. Light brand assets support light external surfaces; they do not introduce light mode to the mobile product.

## 4. Gloss and role variants

**App / client:** amber mark on glossy charcoal. Use for iOS, Android, and future macOS, Windows, and Linux apps connecting to another computer's terminals.

**Service / host:** warm-white mark on the same glossy charcoal plate. Use the visible name **Shellbell Service** in packaging and launchers. This is a visual role distinction, not a rename of the existing `shellbell` CLI or a claim that a desktop service GUI already exists. Color alone must never be the only role label.

Gloss is a restrained broad reflection from the upper left, with a thin rim. It must not reduce the symbol's contrast. The app icon gets gloss; logos, splash marks, menu-bar/tray icons, and themed masks stay flat. Flat dark and light icon alternatives are included for environments that need them. The imagegen gloss study is retained under `brand/reference/`; deterministic exports use a quieter vector gloss that remains clean at small sizes.

## 5. Platform exports

| Surface | Files | Contract |
| --- | --- | --- |
| Current Expo app | `apps/mobile/assets/*.png` | Existing config paths updated in place |
| iOS | `brand/ios/` | 1024px RGB, opaque, full square; OS applies corner mask |
| Android adaptive | `brand/android/`, mobile foreground/background/monochrome PNGs | Separate layers; symbol wholly inside the 66/108 safe circle; no tile in foreground |
| Android Play listing | `brand/android/play-store-512.png` | 512px opaque square |
| macOS Dock | `brand/macos/shellbell-{app,service}.icns`, `.iconset`, `.appiconset` | Transparent canvas around inset rounded tile; 16-1024px, normal and Retina |
| macOS menu bar | `brand/macos/menu-bar/{16,18}/` | Transparent template + explicit white fallback, each 1x and 2x |
| Windows | `brand/windows/` | App/service ICO with 16, 20, 24, 32, 40, 48, 64, 96, 128, 256px entries; flat at smallest sizes |
| Windows tray | `brand/windows/tray-{white,black,amber}.ico` | Transparent, no tile; select according to actual tray background |
| Linux | `brand/linux/hicolor/` | App/service PNG sizes 16-512, scalable SVG, symbolic monochrome SVG |
| Web | `brand/web/` | SVG/ICO favicon, 16-512px PNG, 180px touch icon, maskable 512px icon |
| Shared icon sources | `brand/icons/svg/` | Square and rounded glossy, flat, light variants; adaptive layers |
| Apple layers | `brand/apple-layers/` | Unlit background and separate foreground SVGs for future Icon Composer import |

These are artwork deliverables. Future desktop build systems must wire them into packaging; this change does not implement desktop apps, sign installers, or submit store builds. Apple layer SVGs are **not a compiled `.icon` asset**. When adopting Icon Composer, import the unlit layers and let the OS render material effects; do not bake the reference gloss into a second layer of Liquid Glass. The current Expo configuration continues to use its supported raster icon.

## 6. macOS menu-bar mark

Default: the **18-point template**. Use 16 points only when the surrounding application layout needs it. `ShellbellTemplate.png` is a black alpha mask; `ShellbellTemplate@2x.png` has identical geometry at twice the resolution. The small optical variant slightly strengthens the rays and uses more of its canvas.

For AppKit, load the image, set its logical size to 18×18 points, and set `NSImage.isTemplate = true`. macOS then supplies white/dark tint for the menu bar's appearance. For Electron, retain the `Template`/`Template@2x` naming and set the native image's template flag where appropriate. These instructions are integration guidance, not existing app implementation.

`ShellbellWhite.png` and `ShellbellWhite@2x.png` are the explicitly requested white versions for previews or toolkits without template tinting. Do not hard-code white for all macOS appearances: it disappears on a light menu bar. No gloss, plate, shadow, glow, wordmark, or status badge belongs in the base menu-bar image. Both client and service can use the same template; their menu titles identify their roles. Additional status states need their own behavior design.

## 7. Generation and validation

Run `pnpm brand` from the repository root to regenerate mobile assets, logo family, and platform exports. Run `pnpm brand:check` for deterministic SVG drift checks and `pnpm -F @shellbell/mobile test` for asset contracts. `brand/asset-manifest.json` inventories the platform exports. `brand/index.html` is the visual guide; `brand/README.md` is the integration reference.

Raster files are committed so app builds do not need graphics tooling. PNG byte equality across libvips versions is intentionally not a test. Tests cover layer transparency, mark parity, Android safe-circle containment, iOS dimensions and lack of alpha, menu-bar scale/alpha parity, vector portability, nonblank logo rasters, and decodable ICO/ICNS entries. Check previews at actual small sizes as well as enlarged sizes. Final on-device launcher/menu-bar QA remains part of platform integration.

## 8. Platform references

- [Android adaptive icon layers and safe area](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)
- [Apple Icon Composer](https://developer.apple.com/icon-composer/)
- [Apple template image behavior](https://developer.apple.com/documentation/appkit/nsimage/istemplate)
- [Windows icon construction and required sizes](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)

Checked 2026-09-20. Runtime and packaging requirements should be rechecked when the future desktop applications are built.
