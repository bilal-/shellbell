import { editConfig, loadConfig, paths } from "../../src/config.js";

const [dir, op] = process.argv.slice(2);
if (!dir || !["edit", "load"].includes(op ?? ""))
  throw new Error("explicit fixture arguments required");
try {
  const p = paths(dir);
  console.log(
    JSON.stringify(
      op === "load" ? loadConfig(p) : editConfig(p, (c) => ({ ...c, idleQuietMs: 9876 })),
    ),
  );
} catch (error) {
  console.log(JSON.stringify({ code: (error as { code?: string }).code ?? "unexpected" }));
}
