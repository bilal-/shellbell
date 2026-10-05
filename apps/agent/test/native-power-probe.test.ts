import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../macos/scripts/check-signed-power.mjs", import.meta.url),
);

describe("signed power probe authorization", () => {
  it("refuses before compilation or signing without explicit authorization", () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, SHELLBELL_SIGNED_POWER_TEST: "" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("explicit authorization required");
    expect(result.stdout).toBe("");
  });

  it("does not silently skip the foreign-publisher qualification", () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELLBELL_SIGNED_POWER_TEST: "1",
        SHELLBELL_POWER_SIGN_ID: "",
        SHELLBELL_FOREIGN_SIGN_ID: "",
        SHELLBELL_TEAM_ID: "",
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "both signing identities and the expected Team ID are required",
    );
    expect(result.stdout).toBe("");
  });
});
