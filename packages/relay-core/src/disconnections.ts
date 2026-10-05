import type { TransitionContext } from "./computer.js";
import type { SessionRecord } from "./session.js";

/** Drain retired generations under the transition coordinator, including failed broadcasts. */
export async function drainDisconnections(
  context: TransitionContext,
  disconnected: SessionRecord[],
): Promise<void> {
  const { identity, runtime, sessions } = context;
  while (disconnected.length) {
    const session = disconnected.shift();
    if (!session) break;
    if (session.state === "agent" && !context.agent()) {
      await identity.markSeen(runtime.now());
      if (!context.agent()) {
        await identity.closeWindow();
        const computer = await identity.computer();
        for (const phone of sessions().filter((s) => s.state === "phone"))
          context.send(phone, {
            type: "presence",
            agentOnline: false,
            computerName: computer?.name ?? null,
          });
      }
    } else if (session.state === "phone" && session.fp) {
      const agent = context.agent();
      if (agent)
        context.send(agent, {
          type: "phone-disconnected",
          phoneFp: session.fp,
          connId: session.connId,
        });
    }
  }
}
