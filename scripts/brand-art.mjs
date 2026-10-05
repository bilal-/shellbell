// Geometry authority for every Shellbell mark. No font is used for the symbol.
export const AMBER = "#F59E0B";
export const INK = "#17191D";
export const PAPER = "#F8F7F4";
// Rounded terminal chevron, cursor, and two attention rays. Bounds: 0..360 x 0..280.
const PATHS = [
  "M31 4Q36 -1 41 4L166 129Q177 140 166 151L41 276Q36 281 31 276L3 248Q-2 243 3 238L101 140L3 42Q-2 37 3 32Z",
  "M190 220H344Q360 220 360 236V256Q360 272 344 272H190Q174 272 174 256V236Q174 220 190 220Z",
  "M242 40Q258 39 259 55L264 121Q265 138 249 139Q232 140 231 124L226 58Q225 41 242 40Z",
  "M338 77Q352 85 344 100L311 157Q303 172 289 164Q274 156 282 141L315 84Q323 69 338 77Z",
];
// Small-size optical correction: slightly thicker rays.
const SMALL_PATHS = [
  PATHS[0],
  PATHS[1],
  "M243 36Q261 35 262 54L267 119Q268 138 249 139Q230 140 229 121L224 56Q223 37 243 36Z",
  "M340 75Q357 85 347 102L314 159Q304 176 287 166Q270 156 280 139L313 82Q323 65 340 75Z",
];
export function mark(fill = AMBER, small = false) {
  return (small ? SMALL_PATHS : PATHS).map((d) => `<path d="${d}" fill="${fill}"/>`).join("\n");
}
export function svg(title, body, box = "0 0 1024 1024") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"><title>${title}</title>${body}</svg>\n`;
}
export function centeredMark(fill = AMBER, width = 650, small = false) {
  const scale = width / 360;
  return `<g transform="translate(${(1024 - width) / 2} ${(1024 - 280 * scale) / 2}) scale(${scale})">${mark(fill, small)}</g>`;
}
export const glossDefs = `<defs>
  <linearGradient id="plate" x1="0" y1="0" x2="0.85" y2="1">
    <stop stop-color="#353942"/><stop offset="0.48" stop-color="#17191D"/><stop offset="1" stop-color="#090B0E"/>
  </linearGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0.3" y2="1">
    <stop stop-color="#FFFFFF" stop-opacity="0.22"/><stop offset="0.65" stop-color="#FFFFFF" stop-opacity="0.035"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="rim" x1="0" y1="0" x2="0.7" y2="1">
    <stop stop-color="#FFFFFF" stop-opacity="0.35"/><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.04"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.09"/>
  </linearGradient>
</defs>`;
export function plate({ rounded = false, light = false, flat = false } = {}) {
  return `<rect width="1024" height="1024" rx="${rounded ? 224 : 0}" fill="${light ? PAPER : flat ? INK : "url(#plate)"}"/>`;
}
export function gloss(rounded = false) {
  return `<clipPath id="tileClip"><rect width="1024" height="1024" rx="${rounded ? 224 : 0}"/></clipPath>
  <g clip-path="url(#tileClip)"><path d="M0 0H1024V340Q530 540 0 455Z" fill="url(#glass)"/>
  <rect x="2" y="2" width="1020" height="1020" rx="${rounded ? 222 : 0}" fill="none" stroke="url(#rim)" stroke-width="3"/></g>`;
}
export function icon({
  service = false,
  rounded = false,
  light = false,
  flat = false,
  small = false,
} = {}) {
  const fill = light ? INK : service ? PAPER : AMBER;
  return svg(
    `Shellbell${service ? " Service" : ""} app icon`,
    glossDefs +
      plate({ rounded, light, flat }) +
      centeredMark(fill, 650, small) +
      (flat || light ? "" : gloss(rounded)),
  );
}
export const adaptive = (fill = AMBER) =>
  svg("Shellbell adaptive foreground", centeredMark(fill, 500));
export const background = () => svg("Shellbell adaptive background", glossDefs + plate() + gloss());
export const template = (fill = "#FFFFFF") =>
  svg("Shellbell menu bar template", centeredMark(fill, 850, true));
