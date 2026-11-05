import { createContext } from "react";

/**
 * Handles a link that names the paired computer itself. Returns true when it did (asked first,
 * or explained why it can't); false leaves the link to the caller's own handling.
 */
export type LocalLinkHandler = (url: string) => boolean;

/** Set by a computer's screens; links outside them keep their usual handling. */
export const LocalLinkContext = createContext<LocalLinkHandler | null>(null);
