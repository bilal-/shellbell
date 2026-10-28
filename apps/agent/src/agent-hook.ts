import { AGENT_HOOK_FORMAT, type HookAgent } from "./conversation/agent-sessions.js";

/** How each agent's own process looks to `ps`: Codex by name, Gemini as `node …/gemini`. */
const PROCESS: Record<HookAgent, string> = {
  codex: `case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
    codex | */codex) agent=$pid; break ;;
  esac`,
  gemini: `case "$(ps -o args= -p "$pid" 2>/dev/null)" in
    gemini | "gemini "* | */gemini | */gemini\\ * | */gemini.js | */gemini.js\\ *) agent=$pid; break ;;
  esac`,
};

/**
 * The hook Shellbell adds to an agent during setup. It records which terminal pane runs which of
 * the agent's sessions, so the phone can show that session's full history in tmux, iTerm2 and
 * Herdr. It keeps only the session ID and transcript path from its input, which for some hooks
 * also carries the prompt, and never writes the input anywhere. It prints nothing, since a hook's
 * output can become context for the model, and always exits successfully so it can never stop
 * the agent.
 */
export function agentHookScript(agent: HookAgent, recordDir: string): string {
  const quoted = `'${recordDir.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh
# Installed by Shellbell. Records which terminal pane runs which ${agent} session, so your phone
# can show its full history. Remove it with: shellbell agents remove ${agent}
umask 077
dir=${quoted}
clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9_.:/%,@=+-' | cut -c1-512; }
# Only these two values are read from the input; the input itself is never saved.
input=$(head -c 65536 | tr '\\n' ' ')
session=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([0-9A-Fa-f-]\\{36\\}\\)".*/\\1/p')
transcript=$(printf '%s' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')
input=
[ -n "$session" ] || exit 0
case "$transcript" in /*) ;; *) transcript= ;; esac
printf '%s' "$transcript" | LC_ALL=C grep -q '[^A-Za-z0-9 _./@+,%=-]' && transcript=
now=$(date +%s)
tmp="$dir/.$now-$$.tmp"
# The agent process that ran this hook and the terminal it runs in. A record counts only while
# that process runs, and only for an agent with its own terminal: a shared background agent has
# none, and the pane markers it inherited may name another pane, so it records nothing.
pid=$PPID
agent=
i=0
while [ "$i" -lt 8 ] && [ "$pid" -gt 1 ] 2>/dev/null; do
  ${PROCESS[agent]}
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  i=$((i + 1))
done
[ -n "$agent" ] || exit 0
tty=$(ps -o tty= -p "$agent" 2>/dev/null | tr -d ' ')
case "$tty" in '' | '?' | '??') exit 0 ;; esac
mkdir -p "$dir" 2>/dev/null || exit 0
{
  echo '${AGENT_HOOK_FORMAT}'
  echo "agent=${agent}"
  echo "time=$now"
  echo "pid=$agent"
  echo "start=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$agent" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//')"
  echo "tty=$(clean "$tty")"
  echo "tmux=$(clean "\${TMUX:-}")"
  echo "tmux_pane=$(clean "\${TMUX_PANE:-}")"
  echo "iterm=$(clean "\${ITERM_SESSION_ID:-}")"
  echo "herdr_pane=$(clean "\${HERDR_PANE_ID:-}")"
  echo "session=$session"
  echo "transcript=$transcript"
} >"$tmp" 2>/dev/null && mv -f "$tmp" "$dir/$now-$$.rec" 2>/dev/null
rm -f "$tmp" 2>/dev/null
exit 0
`;
}
