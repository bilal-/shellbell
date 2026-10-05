import type { NotificationPayload } from "@shellbell/protocol";

export function formatNotification(payload: NotificationPayload): {
  title: string;
  body: string;
  subtitle: string;
} {
  const c = payload.context;
  const title =
    c.customName ??
    (c.repository ? [c.repository, c.branch].filter(Boolean).join(" · ") : c.title) ??
    c.sessionLabel;
  const subtitle = [c.computerName, c.sessionLabel, c.shell].filter(Boolean).join(" · ");
  let body: string;
  switch (payload.reason) {
    case "agent-blocked":
      body = `${c.agentName ?? "Agent"} is waiting for your response`;
      break;
    case "agent-finished":
      body = `${c.agentName ?? "Agent"} finished`;
      break;
    case "quiet":
      body = "Session went quiet";
      break;
    case "prompt-returned":
      body = "Terminal returned to a prompt";
      break;
    case "command-finished":
      body =
        payload.exitCode !== undefined && payload.exitCode !== 0
          ? `Command exited with code ${payload.exitCode}`
          : "Command finished";
      if (payload.durationMs !== undefined) body += ` · ${Math.floor(payload.durationMs / 1000)}s`;
      break;
  }
  return { title, body, subtitle };
}
