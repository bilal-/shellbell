import type { MobileStreamSnapshot } from "../net/mobile-screen-stream";
import { VtReplayLog } from "../terminal/vt-replay-log";
import type { VtStatus } from "../terminal/XtermView";
import {
  cursorRowAsksForSecret,
  lineText,
  type PromptScreen,
  textAsksForSecret,
} from "./secretPrompt";

/** Only source-backed facts may suggest input; secret masking remains conservative. */
export function terminalInputFacts(
  backend: string,
  stream: MobileStreamSnapshot | undefined,
  rawStatus: VtStatus | null,
  snapshot: PromptScreen | undefined,
  alternateScreen: boolean | undefined,
  previousSecret = false,
) {
  const log = stream?.vt?.log;
  const ready =
    (!stream || stream.status === "live") &&
    stream?.output?.state !== "paused" &&
    stream?.output?.state !== "ended";
  const parsed = !(log instanceof VtReplayLog) || !log.isRestoring;
  const observed = log ? rawStatus !== null : snapshot !== undefined;
  const cursorReal =
    ready &&
    parsed &&
    observed &&
    (log instanceof VtReplayLog
      ? log.meta.cursor === "real"
      : backend === "tmux" || backend === "iterm2");
  const alternateReal =
    ready &&
    parsed &&
    (!log || rawStatus !== null) &&
    (log instanceof VtReplayLog
      ? log.meta.alternate === "real"
      : backend === "tmux" && alternateScreen !== undefined);
  const secret = !observed
    ? stream?.output?.state === "ended"
      ? false
      : previousSecret
    : log
      ? textAsksForSecret(rawStatus?.cursorLine) ||
        ((!cursorReal || (rawStatus?.cursorY ?? -1) < 0) &&
          (rawStatus?.rows.some(textAsksForSecret) ?? false))
      : cursorRowAsksForSecret(snapshot) ||
        ((!cursorReal || (snapshot?.cursor.y ?? -1) < 0) &&
          (snapshot?.lines.some((line) => textAsksForSecret(lineText(line))) ?? false));
  return { cursorReal, alternateReal, secret };
}
