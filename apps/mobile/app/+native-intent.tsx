/** Computer links belong to the root layout's pairing/session-checked handler. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    const url = new URL(path, "shellbell:///");
    const route = /^https?:$/.test(url.protocol) ? url.pathname : `${url.host}${url.pathname}`;
    const firstSegment = decodeURIComponent(route).replace(/^\/+/, "").split("/")[0];
    // null suppresses automatic navigation, including warm-link navigation. A
    // redirect to "/" would race openTarget. Linking still delivers the raw URL.
    return firstSegment === "c" ? null : path;
  } catch {
    return null;
  }
}
