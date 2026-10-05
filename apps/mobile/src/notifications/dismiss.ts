interface PresentedNotification {
  request: { identifier: string; content: { data?: unknown } };
}

/** Provider-generated identifiers are opaque: match routing metadata, never a string prefix. */
export function matchingNotificationIds(
  notifications: readonly PresentedNotification[],
  computerFp: string,
  sessionId?: string,
): string[] {
  return notifications
    .filter(({ request }) => {
      const data = request.content.data;
      if (typeof data !== "object" || data === null) return false;
      const route = data as Record<string, unknown>;
      return (
        route.computerFp === computerFp &&
        (sessionId === undefined || route.sessionId === sessionId)
      );
    })
    .map(({ request }) => request.identifier);
}
