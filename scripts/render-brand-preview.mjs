import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "../brand");
const embed = (file, x, y, width, height = width) =>
  `<image x="${x}" y="${y}" width="${width}" height="${height}" href="data:image/png;base64,${readFileSync(join(root, file)).toString("base64")}"/>`;
const text = (label, x, y, size = 20, fill = "#17191D") =>
  `<text x="${x}" y="${y}" font-family="Helvetica,Arial,sans-serif" font-size="${size}" fill="${fill}">${label}</text>`;
let body = '<rect width="1440" height="1080" fill="#F8F7F4"/>';
body +=
  text("shellbell", 72, 94, 48) +
  text("TERMINAL ATTENTION / PLATFORM IDENTITY", 73, 130, 14, "#666A70");
body += embed("icons/png/app-gloss-rounded-1024.png", 72, 188, 340);
body += embed("icons/png/service-gloss-rounded-1024.png", 475, 188, 340);
body += text("Shellbell", 72, 575, 26) + text("APP / CLIENT", 72, 606, 13, "#666A70");
body += text("Shellbell Service", 475, 575, 26) + text("COMPUTER / HOST", 475, 606, 13, "#666A70");
body += '<rect x="905" y="188" width="463" height="204" rx="22" fill="#17191D"/>';
body += text("MACOS MENU BAR", 937, 225, 13, "#C7C9CE");
body += embed("macos/menu-bar/18/ShellbellWhite@2x.png", 938, 269, 18);
body += text("18pt / actual size", 976, 284, 15, "#FFFFFF");
body += embed("tray/white-48.png", 1205, 257, 72);
body += text("Enlarged", 1210, 365, 12, "#C7C9CE");
body += '<rect x="905" y="416" width="463" height="190" rx="22" fill="#E8E7E3"/>';
body += text("TEMPLATE / AUTO TINT", 937, 454, 13, "#666A70");
body += embed("macos/menu-bar/18/ShellbellTemplate@2x.png", 938, 502, 18);
body += text("18pt / actual size", 976, 517, 15);
body += embed("tray/black-48.png", 1205, 485, 72);
body += '<path d="M72 661H1368" stroke="#D5D4D0"/>';
body += embed("png/horizontal-on-light@2x.png", 72, 710, 680, 112);
body += text("AMBER #F59E0B", 905, 730, 14, "#666A70");
body += text("INK #17191D / PAPER #F8F7F4", 905, 763, 14, "#666A70");
body += text("iOS · Android · macOS · Windows · Linux", 905, 806, 17);
body += text("SMALL-SIZE EXPORTS", 72, 890, 13, "#666A70");
let x = 72;
for (const size of [16, 24, 32, 48, 64, 128]) {
  body += embed(`windows/app-${size}.png`, x, 933 - size / 2, size);
  body += text(String(size), x, 1020, 12, "#666A70");
  x += size + 48;
}
body += text("Gloss for the app. A clean silhouette for the menu bar.", 905, 925, 16);
body += text("Actual production assets · September 2026", 905, 956, 13, "#666A70");
const source = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1080">${body}</svg>`;
writeFileSync(join(root, "preview.png"), await sharp(Buffer.from(source)).png().toBuffer());
console.log("brand: rendered production contact sheet");
