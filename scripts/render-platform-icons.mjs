// Platform exports from the shared vector geometry. No image-generation call at build time.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  adaptive,
  background,
  centeredMark,
  gloss,
  glossDefs,
  icon,
  plate,
  svg,
  template,
} from "./brand-art.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../brand");
const outputs = [];
function save(file, content) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  outputs.push(file);
}
async function png(file, source, size, opaque = false) {
  let render = sharp(Buffer.from(source)).resize(size, size);
  if (opaque) render = render.removeAlpha();
  const data = await render.png().toBuffer();
  save(file, data);
  return data;
}

// Modern Windows ICO supports PNG-compressed image entries, including the 256px entry.
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (const [index, { size, data }] of images.entries()) {
    const p = 6 + index * 16;
    header[p] = header[p + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(data.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += data.length;
  }
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

// PNG-backed ICNS chunks used by modern macOS; generated portably, including on CI.
function icns(images) {
  const chunks = images.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const header = Buffer.alloc(8);
  header.write("icns");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

for (const [name, options] of [
  ["app-gloss", {}],
  ["service-gloss", { service: true }],
  ["app-flat", { flat: true }],
  ["service-flat", { flat: true, service: true }],
  ["light", { light: true }],
]) {
  save(`icons/svg/${name}.svg`, icon(options));
  save(`icons/svg/${name}-rounded.svg`, icon({ ...options, rounded: true }));
  await png(`icons/png/${name}-1024.png`, icon(options), 1024, true);
  await png(`icons/png/${name}-rounded-1024.png`, icon({ ...options, rounded: true }), 1024);
}
save("icons/svg/foreground.svg", adaptive());
save("icons/svg/background.svg", background());
save("icons/svg/monochrome.svg", adaptive("#FFFFFF"));

// iOS legacy raster catalog plus editable separated layers for future Icon Composer work.
for (const [name, opts] of [
  ["app", {}],
  ["service", { service: true }],
]) {
  await png(`ios/${name}-1024.png`, icon(opts), 1024, true);
}
await png("ios/light-1024.png", icon({ light: true }), 1024, true);
await png("ios/tinted-1024.png", icon({ service: true, flat: true }), 1024, true);
save("apple-layers/mark.svg", svg("Shellbell amber foreground", centeredMark()));
save("apple-layers/service-mark.svg", svg("Shellbell service foreground", centeredMark("#F8F7F4")));
save("apple-layers/background.svg", svg("Shellbell unlit background", plate({ flat: true })));
save(
  "apple-layers/gloss-reference.svg",
  svg("Shellbell gloss reference only", glossDefs + gloss()),
);

// Android source layers and native density exports. Expo uses the 1024px equivalents in assets/.
for (const [density, size] of [
  ["mdpi", 108],
  ["hdpi", 162],
  ["xhdpi", 216],
  ["xxhdpi", 324],
  ["xxxhdpi", 432],
]) {
  for (const [name, source] of [
    ["foreground", adaptive()],
    ["background", background()],
    ["monochrome", adaptive("#FFFFFF")],
  ]) {
    await png(
      `android/mipmap-${density}/ic_launcher_${name}.png`,
      source,
      size,
      name === "background",
    );
  }
  await png(
    `android/mipmap-${density}/ic_launcher.png`,
    icon({ rounded: true }),
    (size * 48) / 108,
  );
}
save(
  "android/mipmap-anydpi-v26/ic_launcher.xml",
  '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@mipmap/ic_launcher_background"/>\n  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n',
);
save(
  "android/mipmap-anydpi-v33/ic_launcher.xml",
  '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@mipmap/ic_launcher_background"/>\n  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n  <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n</adaptive-icon>\n',
);
await png("android/play-store-512.png", icon(), 512, true);

for (const role of ["app", "service"]) {
  const opts = { service: role === "service", rounded: true };
  const windows = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) {
    const data = await png(
      `windows/${role}-${size}.png`,
      icon({ ...opts, small: size <= 32, flat: size <= 24 }),
      size,
    );
    windows.push({ size, data });
  }
  save(`windows/shellbell-${role}.ico`, ico(windows));

  // Classic macOS Dock silhouette: 824px tile centred in a transparent 1024px canvas.
  const mac = svg(
    `Shellbell ${role} macOS icon`,
    `<g transform="translate(100 100) scale(0.8046875)">${icon(opts).replace(/^<svg[^>]*>|<\/svg>\s*$/g, "")}</g>`,
  );
  save(`macos/${role}.svg`, mac);
  const chunks = [];
  const catalog = [];
  for (const [size, scale, type] of [
    [16, 1, "icp4"],
    [16, 2, "ic11"],
    [32, 1, "icp5"],
    [32, 2, "ic12"],
    [128, 1, "ic07"],
    [128, 2, "ic13"],
    [256, 1, "ic08"],
    [256, 2, "ic14"],
    [512, 1, "ic09"],
    [512, 2, "ic10"],
  ]) {
    const filename = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
    const data = await png(`macos/${role}.iconset/${filename}`, mac, size * scale);
    chunks.push({ type, data });
    save(`macos/${role}.appiconset/${filename}`, data);
    catalog.push({ idiom: "mac", size: `${size}x${size}`, scale: `${scale}x`, filename });
  }
  save(`macos/shellbell-${role}.icns`, icns(chunks));
  save(
    `macos/${role}.appiconset/Contents.json`,
    `${JSON.stringify({ images: catalog, info: { author: "xcode", version: 1 } }, null, 2)}\n`,
  );

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    await png(
      `linux/hicolor/${size}x${size}/apps/shellbell-${role}.png`,
      icon({ ...opts, small: size <= 32, flat: size <= 24 }),
      size,
    );
  }
  save(`linux/hicolor/scalable/apps/shellbell-${role}.svg`, icon(opts));
}

// Status icons are transparent, flat, and optically strengthened. Never use a glossy tile here.
for (const [name, fill] of [
  ["white", "#FFFFFF"],
  ["black", "#000000"],
  ["amber", "#F59E0B"],
]) {
  save(`tray/${name}.svg`, template(fill));
  for (const size of [16, 18, 20, 22, 24, 32, 36, 40, 44, 48])
    await png(`tray/${name}-${size}.png`, template(fill), size);
}
for (const size of [16, 18]) {
  await png(`macos/menu-bar/${size}/ShellbellTemplate.png`, template("#000000"), size);
  await png(`macos/menu-bar/${size}/ShellbellTemplate@2x.png`, template("#000000"), size * 2);
  await png(`macos/menu-bar/${size}/ShellbellWhite.png`, template(), size);
  await png(`macos/menu-bar/${size}/ShellbellWhite@2x.png`, template(), size * 2);
}
save("linux/hicolor/symbolic/apps/shellbell-symbolic.svg", template("#000000"));
for (const [name, fill] of [
  ["white", "#FFFFFF"],
  ["black", "#000000"],
  ["amber", "#F59E0B"],
]) {
  const images = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 256]) {
    images.push({
      size,
      data: await sharp(Buffer.from(template(fill)))
        .resize(size, size)
        .png()
        .toBuffer(),
    });
  }
  save(`windows/tray-${name}.ico`, ico(images));
}

const favicons = [];
for (const size of [16, 32, 48, 192, 512]) {
  const data = await png(
    `web/icon-${size}.png`,
    icon({ rounded: true, flat: size <= 32, small: size <= 32 }),
    size,
  );
  if (size <= 48) favicons.push({ size, data });
}
save("web/favicon.ico", ico(favicons));
save("web/favicon.svg", icon({ rounded: true, flat: true, small: true }));
await png("web/apple-touch-icon.png", icon(), 180, true);
await png(
  "web/maskable-512.png",
  svg("Shellbell maskable icon", glossDefs + plate() + centeredMark(undefined, 500) + gloss()),
  512,
  true,
);
save(
  "asset-manifest.json",
  `${JSON.stringify({ version: 2, generator: "pnpm brand", files: outputs.sort() }, null, 2)}\n`,
);
console.log(`brand: wrote ${outputs.length} platform assets`);
