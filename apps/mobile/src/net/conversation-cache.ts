import type { MobileConversationSnapshot } from "./mobile-conversation";

/** How long a left session's conversation stays in memory, so going back is instant. */
export const CONVERSATION_KEEP_MS = 120_000;

export interface KeptConversation {
  readonly snapshot: Readonly<MobileConversationSnapshot>;
  /** The chat the rows belong to (`SessionInfo.chat.id`); they never show for another one. */
  readonly chat: string | undefined;
  readonly agent: string | undefined;
}

interface Entry extends KeptConversation {
  readonly timer: ReturnType<typeof setTimeout>;
}

const key = (fp: string, sessionId: string) => JSON.stringify([fp, sessionId]);

/**
 * The last rows of sessions you just left, held in memory only and never written to disk. They
 * show dimmed when you come back, until the computer's first page replaces them. Gone after two
 * minutes, on a memory warning, when chat is turned off, on unpair or revocation, when the
 * session leaves a complete list, and when the app ends.
 */
export class ConversationCache {
  private readonly kept = new Map<string, Entry>();

  keep(fp: string, sessionId: string, kept: KeptConversation): void {
    if (kept.snapshot.entries.length === 0) return;
    this.drop(key(fp, sessionId));
    const id = key(fp, sessionId);
    const timer = setTimeout(() => {
      if (this.kept.get(id)?.timer === timer) this.kept.delete(id);
    }, CONVERSATION_KEEP_MS);
    this.kept.set(id, { ...kept, timer });
  }

  peek(fp: string, sessionId: string): KeptConversation | null {
    return this.kept.get(key(fp, sessionId)) ?? null;
  }

  forgetSession(fp: string, sessionId: string): void {
    this.drop(key(fp, sessionId));
  }

  forgetComputer(fp: string): void {
    for (const id of [...this.kept.keys()])
      if ((JSON.parse(id) as [string, string])[0] === fp) this.drop(id);
  }

  /** Keeps only the computer's sessions a complete list still has. */
  keepListed(fp: string, sessionIds: readonly string[]): void {
    const listed = new Set(sessionIds.map((id) => key(fp, id)));
    for (const id of [...this.kept.keys()])
      if ((JSON.parse(id) as [string, string])[0] === fp && !listed.has(id)) this.drop(id);
  }

  clear(): void {
    for (const id of [...this.kept.keys()]) this.drop(id);
  }

  get size(): number {
    return this.kept.size;
  }

  private drop(id: string): void {
    const entry = this.kept.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.kept.delete(id);
  }
}

export const conversationCache = new ConversationCache();
