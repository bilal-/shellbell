import { type Line, type Run, stringCells } from "@shellbell/protocol";

/** Set `n` only when it differs from the code-point count, exactly as the agent does. */
function run(t: string, extra: Omit<Run, "t" | "n"> = {}): Run {
  const cells = stringCells(t);
  const points = Array.from(t).length;
  return cells === points ? { t, ...extra } : { t, ...extra, n: cells };
}

export function htopScreen(rows = 60, cols = 160): Line[] {
  const out: Line[] = [];
  for (let y = 0; y < rows; y++) {
    const r: Run[] = [];
    for (let x = 0; x < cols; x += 8) {
      const v = (x * 7 + y * 13) % 100;
      r.push(
        run(`${String(v).padStart(3, " ")}% ▇▇▇`, {
          fg: v > 80 ? 1 : v > 50 ? 3 : 2,
          bg: y % 2 ? 0 : 8,
          b: v > 80,
        }),
      );
    }
    out.push({ r });
  }
  return out;
}

/** A TUI footer below its cursor; no app-specific status parsing is needed. */
export function llmStatusScreen(rows = 60): Line[] {
  return Array.from({ length: rows }, (_, y) => ({
    r:
      y === rows - 1
        ? [run("ready | private fixture", { fg: 2 })]
        : y === rows - 2
          ? [run("model: example | context: 32%", { bg: 8 })]
          : y === 8
            ? [run("> draft on laptop")]
            : y < 8
              ? [run(`LLM output ${y}`)]
              : [],
  }));
}

export function cjkLines(): Line[] {
  return [
    { r: [run("漢字とカナ mixed with ascii")] },
    { r: [run("🚀 deploy ✅ done 👨‍💻")] },
    { r: [run("café naïve résumé")] },
    { r: [run("├── src/  "), run("main.rs", { fg: 4 })] },
    { r: [run("https://bilal.sh")] },
  ];
}

export function logLines(n: number): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < n; i++) {
    const err = i % 17 === 0;
    out.push({
      r: [
        run(`${String(i).padStart(5, "0")} `, { f: true }),
        run(err ? "ERROR" : "info", { fg: err ? 1 : 2, b: err }),
        run(` request ${i} handled in ${(i * 37) % 900}ms`),
      ],
    });
  }
  return out;
}
