#!/usr/bin/env python3
"""Frame raw app captures as branded store screenshots, and render the closing brand panel.

Usage: frame.py RAW_DIR FAMILY
  RAW_DIR holds the unframed captures, named like the store files (`01_agents.png`).
  FAMILY is a target family from listing.json; output goes where the store expects it.

Every panel is drawn at the slot's exact size as 8-bit RGB without alpha. The screens inside
are real captures of the running app; only the background, caption and frame are added.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
REPO = APP.parent.parent
PLAN = json.loads((APP / ".listing-kit/listing.json").read_text())
BOLD = str(APP / "assets/fonts/JetBrainsMonoNerdFont-Bold.ttf")
REGULAR = str(APP / "assets/fonts/JetBrainsMonoNerdFont-Regular.ttf")
LOGO = str(REPO / "brand/png/horizontal-black@2x.png")
GRADIENT = "gradient:#F6BC4A-#E79B19"
INK = "#17191D"
DETAIL = "#493416"


def magick(*args):
    subprocess.run(["magick", *map(str, args)], check=True)


def text_block(path, width, font, size, color, text, align="center"):
    """Wrapped text on a transparent canvas, `width` wide and as tall as it needs."""
    magick(
        "-background", "none", "-fill", color, "-font", font, "-pointsize", size,
        "-size", f"{width}x", "-gravity", {"center": "center", "left": "west"}[align],
        "-interline-spacing", round(size * 0.12), f"caption:{text}", path,
    )


def device(raw, path, width, radius, bezel):
    """The capture scaled to `width`, with rounded corners inside a thin ink bezel."""
    tmp = Path(path).with_suffix(".inner.png")
    inner = width - 2 * bezel
    magick(
        raw, "-resize", f"{inner}x", "(", "+clone", "-alpha", "extract", "-fill", "black",
        "-colorize", "100", "-fill", "white", "-draw",
        f"roundrectangle 0,0 %[fx:w-1],%[fx:h-1] {radius - bezel},{radius - bezel}", ")",
        "-alpha", "off", "-compose", "CopyOpacity", "-composite", tmp,
    )
    magick(
        tmp, "-bordercolor", "none", "-border", bezel, "(", "+clone", "-alpha", "extract",
        "-fill", "black", "-colorize", "100", "-fill", "white", "-draw",
        f"roundrectangle 0,0 %[fx:w-1],%[fx:h-1] {radius},{radius}", ")", "-alpha", "off",
        "(", "+clone", "-fill", INK, "-colorize", "100", ")", "-delete", "0", "+swap",
        "-compose", "CopyOpacity", "-composite", tmp, "-compose", "over",
        "-gravity", "center", "-composite", path,
    )
    tmp.unlink()


def shadow(path):
    """A soft drop shadow under the device, merged into the same image."""
    magick(
        path, "(", "+clone", "-background", "#3d2a0a", "-shadow", "45x40+0+30", ")",
        "+swap", "-background", "none", "-layers", "merge", "+repage", path,
    )


def frame(raw, out, width, height, caption, detail, work):
    landscape = width > height
    unit = min(width, height)
    margin = round(unit * 0.07)
    title = work / "title.png"
    sub = work / "sub.png"
    shot = work / "shot.png"
    text_width = width - 2 * margin
    # Monospace glyphs are about 0.6 em wide; keep each caption and detail on one line.
    fit = lambda text, size: min(size, int(text_width / (0.62 * len(text))))
    text_block(title, text_width, BOLD, fit(caption, round(unit * (0.064 if landscape else 0.07))), INK, caption)
    text_block(sub, text_width, REGULAR, fit(detail, round(unit * (0.03 if landscape else 0.036))), DETAIL, detail)
    title_h = int(subprocess.check_output(["magick", "identify", "-format", "%h", title]))
    sub_h = int(subprocess.check_output(["magick", "identify", "-format", "%h", sub]))
    top = round(height * (0.06 if landscape else 0.065))
    sub_y = top + title_h + round(unit * 0.02)
    device_y = sub_y + sub_h + round(unit * (0.05 if landscape else 0.06))
    device_w = round(width * (0.74 if landscape else 0.84))
    device(raw, shot, device_w, round(device_w * 0.06), max(6, round(device_w * 0.014)))
    shadow(shot)
    magick(
        "-size", f"{width}x{height}", GRADIENT,
        title, "-gravity", "north", "-geometry", f"+0+{top}", "-composite",
        sub, "-gravity", "north", "-geometry", f"+0+{sub_y}", "-composite",
        shot, "-gravity", "north", "-geometry", f"+0+{device_y - round(unit * 0.03)}", "-composite",
        "-strip", "-alpha", "off", "-depth", "8", f"PNG24:{out}",
    )


def brand_panel(out, width, height, panel, work):
    """The closing panel: what Shellbell does, with no app capture. Shrinks until it fits."""
    unit = min(width, height)
    while not brand_layout(out, width, height, panel, work, unit):
        unit = round(unit * 0.92)


def brand_layout(out, width, height, panel, work, unit):
    landscape = width > height
    margin = round(unit * 0.09)
    logo = work / "logo.png"
    magick(LOGO, "-resize", f"{round(unit * (0.5 if landscape else 0.62))}x", logo)
    headline = work / "headline.png"
    text_block(headline, width - 2 * margin, BOLD, round(unit * 0.075), INK, panel["headline"])
    layers = [(logo, round(height * 0.08)), (headline, None)]
    rows = []
    for index, (label, text) in enumerate(panel["rows"]):
        label_png = work / f"label{index}.png"
        text_png = work / f"text{index}.png"
        text_block(label_png, width - 2 * margin, BOLD, round(unit * 0.028), "#6b4a12", label.upper(), "left")
        text_block(text_png, width - 2 * margin, REGULAR, round(unit * 0.038), INK, text, "left")
        rows.append((label_png, text_png))
    height_of = lambda p: int(subprocess.check_output(["magick", "identify", "-format", "%h", p]))
    args = ["-size", f"{width}x{height}", GRADIENT]
    y = round(height * (0.07 if landscape else 0.08))
    args += [logo, "-gravity", "north", "-geometry", f"+0+{y}", "-composite"]
    y += height_of(logo) + round(unit * 0.08)
    args += [headline, "-gravity", "north", "-geometry", f"+0+{y}", "-composite"]
    y += height_of(headline) + round(unit * 0.09)
    gap = round(unit * (0.035 if landscape else 0.055))
    for label_png, text_png in rows:
        args += [label_png, "-gravity", "northwest", "-geometry", f"+{margin}+{y}", "-composite"]
        y += height_of(label_png) + round(unit * 0.008)
        args += [text_png, "-gravity", "northwest", "-geometry", f"+{margin}+{y}", "-composite"]
        y += height_of(text_png) + gap
    if y > height:
        return False
    magick(*args, "-strip", "-alpha", "off", "-depth", "8", f"PNG24:{out}")
    return True


def destination(target, screen):
    family = target["family"]
    name = f"{screen['order']:02d}_{screen['id']}"
    if family.startswith("iphone") or family == "ipad":
        return APP / "fastlane/screenshots/en-US" / f"{name}_{target.get('filenameSuffix', family)}.png"
    folder = {"android-phone": "phoneScreenshots", "android-tablet": "tenInchScreenshots"}[family]
    return APP / "fastlane/metadata/android/en-US/images" / folder / f"{name}.png"


def main():
    raw_dir, family = Path(sys.argv[1]), sys.argv[2]
    target = next(t for t in PLAN["targets"] if t["family"] == family)
    width, height = target["width"], target["height"]
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for screen in PLAN["screens"]:
            out = destination(target, screen)
            out.parent.mkdir(parents=True, exist_ok=True)
            if screen.get("panel"):
                brand_panel(out, width, height, screen["panel"], work)
            else:
                raw = raw_dir / f"{screen['order']:02d}_{screen['id']}.png"
                frame(raw, out, width, height, screen["caption"], screen["detail"], work)
            print(out.relative_to(APP))


if __name__ == "__main__":
    main()
