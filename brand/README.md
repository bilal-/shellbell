# Shellbell brand kit

The terminal-attention mark: a prompt, cursor, and two rays.

**[Open the visual guide](index.html)** · [Export inventory](asset-manifest.json)

<picture><source media="(prefers-color-scheme: dark)" srcset="svg/mark-on-dark.svg"><img src="svg/mark-on-light.svg" alt="" width="20" height="20"></picture>

## Pick an asset

| Need | Use |
| --- | --- |
| Main logo | `svg/horizontal-on-dark.svg` or `svg/horizontal-on-light.svg` |
| Standalone symbol / wordmark / stacked logo | `svg/`; 4 compositions × 4 colorways |
| Transparent PNG logos | `png/`; `@1x` = 128px high, `@2x` = 256px high |
| Glossy app icon | `icons/png/app-gloss-rounded-1024.png` |
| Glossy host/service icon | `icons/png/service-gloss-rounded-1024.png` |
| iOS app | `ios/app-1024.png`; opaque, no pre-rounded corners |
| Android native integration | `android/mipmap-*/`, `mipmap-anydpi-v26/`, `mipmap-anydpi-v33/` |
| Android store listing | `android/play-store-512.png` |
| macOS app / service | `macos/shellbell-app.icns`, `macos/shellbell-service.icns` |
| Xcode asset catalog | `macos/app.appiconset/`, `macos/service.appiconset/` |
| **Little white macOS menu-bar icon** | **`macos/menu-bar/18/ShellbellWhite.png` + `ShellbellWhite@2x.png`** |
| Recommended automatic macOS tinting | `macos/menu-bar/18/ShellbellTemplate.png` + `ShellbellTemplate@2x.png` |
| Compact menu-bar variant | Same files in `macos/menu-bar/16/` |
| Windows app / service | `windows/shellbell-app.ico`, `windows/shellbell-service.ico` |
| Windows tray | `windows/tray-white.ico`, `tray-black.ico`, `tray-amber.ico` |
| Linux launchers | `linux/hicolor/`; app and service variants, PNG and SVG |
| Linux symbolic status mark | `linux/hicolor/symbolic/apps/shellbell-symbolic.svg` |
| Web icons | `web/`; favicon, touch icon, PWA icon sizes and maskable icon |
| Future Apple Icon Composer input | `apple-layers/`; editable layers, not a compiled `.icon` package |

The current mobile app already points at the regenerated files in `apps/mobile/assets/`. Desktop files are ready for future application packaging; this kit does not create a running desktop app or service UI.

## Appearance and role

Use amber on glossy charcoal for **Shellbell**, the client. Use warm white on the same glossy charcoal for **Shellbell Service**, the host. Always pair role-specific artwork with the application name where ambiguity is possible. Menu-bar/tray marks remain flat; use explicit white only on a dark background and black on light. Template tinting is preferred on macOS.

The light icon is a brand alternative for light contexts, not a separate role. The iOS `tinted` file is a grayscale source candidate for future appearance-aware integration; it is not currently configured in Expo. Glossy, flat, light, square, and rounded source variants are in `icons/svg/`. Flat vector logos have transparent backgrounds. Never place the pale on-dark wordmark on white.

## Menu-bar integration

Use the 18×18 image at **18 points**, with its 36×36 Retina companion. In AppKit, set `image.isTemplate = true` and `image.size = NSSize(width: 18, height: 18)`. Load from a named asset with both resolutions, or add both bitmap representations. macOS tints the alpha silhouette appropriately for the current menu-bar appearance. In Electron, preserve the `Template.png` and `Template@2x.png` names and use the template-image API when constructing a native image. There is no plate or gloss in a status icon.

## Regenerate and verify

```sh
pnpm brand
pnpm brand:check
pnpm -F @shellbell/mobile test
```

`scripts/brand-art.mjs` is the symbol/material source of truth. The wordmark is outlined from the committed JetBrains Mono Bold font. `scripts/render-platform-icons.mjs` generates native containers and platform assets; `scripts/render-brand-preview.mjs` renders the contact sheet from those actual exports. No generation API, new dependency, or installed design app is needed to reproduce the production kit.

The imagegen studies under `reference/` capture the approved direction. They are not store icons and must not be sliced up as production assets. Production exports deliberately use simpler, reproducible gloss. See [reference provenance](reference/README.md) for the generation prompt.

Use [Apple Icon Composer](https://developer.apple.com/icon-composer/) with the unlit foreground/background layers if a future app adopts native Liquid Glass. Do not add baked gloss on top of system-rendered material. Android layers follow the [adaptive-icon contract](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive), and Windows containers include the [required icon sizes](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction). On-device visual QA still belongs in each platform's integration work.

## Documentation usage

Keep branding quiet: the root project README may show the full logo once.
Elsewhere use occasional 18-20 px marks, or just the Shellbell name. The
[documentation index](../docs/README.md) owns navigation; do not repeat a banner
on every guide. Reference [shellbell.dev](https://shellbell.dev) as **coming soon**
until the site launches. `TRADEMARK.md` governs reuse of the name and assets.
