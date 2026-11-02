import type { ConversationQueued } from "@shellbell/protocol";
import { Text, View } from "react-native";
import { agentName } from "../input/agentPrompt";
import { tokens } from "../theme/tokens";
import { Fade } from "./motion";

/** How many queued messages show before the rest are counted. */
export const QUEUED_VISIBLE = 3;

/** One queued message as a line: its text, or that it is an attachment. */
export function queuedLine(item: Readonly<ConversationQueued>): string {
  if (!item.text) return "Queued attachment";
  return item.attachment ? `${item.text} · with attachment` : item.text;
}

/**
 * Above the composer in Chat: messages seen queued for the agent recently. Shown only when the
 * computer reports some; it never says the queue is empty, since it can't know that.
 */
export function QueuedList({
  queued,
  agent,
}: {
  queued: readonly Readonly<ConversationQueued>[] | undefined;
  agent: string | undefined;
}) {
  if (!queued?.length) return null;
  const shown = queued.slice(0, QUEUED_VISIBLE);
  const more = queued.length - shown.length;
  const title = `Queued for ${agentName(agent) ?? "the agent"}`;
  return (
    <Fade>
      <View
        testID="queued-list"
        accessible
        accessibilityLabel={`${title}: ${queued.map(queuedLine).join(". ")}`}
        style={{
          paddingHorizontal: 14,
          paddingVertical: 6,
          gap: 2,
          borderTopWidth: 1,
          borderTopColor: tokens.border,
          backgroundColor: tokens.surface,
        }}
      >
        <Text style={{ color: tokens.textMuted, fontSize: 12, fontWeight: "600" }}>{title}</Text>
        {shown.map((item, index) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: the queue is positional
            key={`${index}`}
            numberOfLines={1}
            style={{
              color: item.text ? tokens.text : tokens.textMuted,
              fontSize: 13,
              fontStyle: item.text ? "normal" : "italic",
            }}
          >
            {queuedLine(item)}
          </Text>
        ))}
        {more > 0 ? (
          <Text style={{ color: tokens.textMuted, fontSize: 12 }}>+{more} more</Text>
        ) : null}
      </View>
    </Fade>
  );
}
