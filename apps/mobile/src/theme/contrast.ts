/** WCAG relative luminance of a `#RRGGBB` colour. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contrast of a `#RRGGBB` colour against black, the chat's background. */
export function contrastOnBlack(hex: string): number {
  return (luminance(hex) + 0.05) / 0.05;
}

/**
 * The colour itself when text in it reads at WCAG AA (4.5:1) on black, else the same hue
 * mixed toward white until it does. Anything that isn't `#RRGGBB` is returned as it is.
 */
export function readableOnBlack(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  for (let mix = 0; mix <= 1; mix += 0.05) {
    const blended = `#${[1, 3, 5]
      .map((offset) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16);
        return Math.round(value + (255 - value) * mix)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")}`;
    if (contrastOnBlack(blended) >= 4.5) return mix === 0 ? hex : blended.toUpperCase();
  }
  return "#FFFFFF";
}
