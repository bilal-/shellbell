/**
 * The iOS bridge converts sdpMLineIndex directly to an integer in release builds.
 * Supply concrete locators from the accepted, authenticated answer rather than
 * passing JSON null to native code. Never guess a media section.
 */
export function candidateForNative(
  candidate: string,
  mid: string | null,
  mlineIndex: number | null,
  remoteSdp: string,
): { candidate: string; sdpMid?: string; sdpMLineIndex: number } {
  const mids: (string | undefined)[] = [];
  for (const line of remoteSdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) mids.push(undefined);
    else if (line.startsWith("a=mid:") && mids.length) {
      if (mids[mids.length - 1] !== undefined) throw new Error("ambiguous ICE media section");
      mids[mids.length - 1] = line.slice(6);
    }
  }
  const index = mlineIndex ?? (mid === null ? -1 : mids.indexOf(mid));
  if (!Number.isInteger(index) || index < 0 || index >= mids.length)
    throw new Error("ICE media section unavailable");
  const resolvedMid = mids[index];
  if (
    (mid !== null && mid !== resolvedMid) ||
    (resolvedMid !== undefined && mids.filter((value) => value === resolvedMid).length !== 1)
  )
    throw new Error("ICE media section mismatch");
  return {
    candidate,
    sdpMLineIndex: index,
    ...(resolvedMid === undefined ? {} : { sdpMid: resolvedMid }),
  };
}
