import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function workflow(path) {
  return JSON.parse(
    execFileSync(
      "ruby",
      ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV[0]))", path],
      { encoding: "utf8" },
    ),
  );
}
const githubExpression = (body) => `\${{ ${body} }}`;
// Fail closed for expressions outside this deliberately narrow release contract.
function allowed(expression, variables) {
  if (expression === undefined) return true; // GitHub's unguarded-job behavior
  const parsed = /^\$\{\{ vars\.(\w+) == 'true' \}\}$/.exec(expression);
  assert.ok(parsed, "release job must use an explicit repository-variable opt-in");
  return variables[parsed[1]] === "true";
}
for (const [file, job, variable] of [
  ["release-agent.yml", "release", "SHELLBELL_ENABLE_NPM_RELEASE"],
  ["deploy-relay.yml", "deploy", "SHELLBELL_ENABLE_RELAY_DEPLOY"],
]) {
  test(`${file} disables release unless its own gate is explicitly enabled`, () => {
    const expression = workflow(`.github/workflows/${file}`).jobs[job].if;
    for (const value of [undefined, "", "false", "TRUE", "1", true]) {
      assert.equal(allowed(expression, { [variable]: value }), false);
    }
    assert.equal(allowed(expression, { [variable]: "true" }), true);
    assert.equal(allowed(expression, { UNRELATED_GATE: "true" }), false);
  });
}
test("normal CI does not require release opt-in", () => {
  for (const job of Object.values(workflow(".github/workflows/ci.yml").jobs)) {
    assert.equal(allowed(job.if, {}), true);
  }
});

test("source CI keeps portable and native gates while cancelling superseded runs", () => {
  const ci = workflow(".github/workflows/ci.yml");
  assert.equal(ci.concurrency.group, `ci-${githubExpression("github.ref")}`);
  assert.equal(ci.concurrency["cancel-in-progress"], true);
  assert.equal(ci.jobs.test["runs-on"], "ubuntu-latest");
  assert.equal(ci.jobs.native["runs-on"], "macos-15");
  const commands = (job) =>
    job.steps.flatMap((step) => step.run?.split(/\n|&&/).map((line) => line.trim()) ?? []);
  const portable = commands(ci.jobs.test);
  const native = commands(ci.jobs.native);
  for (const name of ["protocol", "mobile", "relay-core", "relay", "relay-node"]) {
    assert.ok(portable.includes(`pnpm -F @shellbell/${name} test`));
  }
  for (const gate of [
    "pnpm -F shellbell test",
    "pnpm native:test",
    "swift build --package-path apps/macos --configuration release",
    "pnpm -F shellbell check:bundle",
    "bash apps/agent/scripts/pack-smoke.sh",
  ]) {
    assert.ok(native.includes(gate), `missing native gate: ${gate}`);
  }
  for (const gate of [
    "pnpm lint",
    "pnpm typecheck",
    "pnpm check:release-tooling",
    "pnpm check:relay-conformance",
    "pnpm -F @shellbell/mobile doctor",
    "pnpm -F @shellbell/protocol gen:protocol-doc",
    "git diff --exit-code docs/protocol.md",
  ]) {
    assert.ok(portable.includes(gate), `missing portable gate: ${gate}`);
  }
});

test("internal mobile delivery requires an explicit main request and matching passing source CI", () => {
  const document = workflow(".github/workflows/mobile-internal.yml");
  const trigger = document.on ?? document.true;
  assert.equal(trigger.workflow_run, undefined);
  assert.ok(Object.hasOwn(trigger, "workflow_dispatch"));
  assert.equal(trigger.push, undefined);
  assert.equal(trigger.pull_request, undefined);
  assert.equal(document.concurrency["cancel-in-progress"], false);
  const jobs = document.jobs;
  assert.equal(
    jobs.prepare.if,
    githubExpression(
      "vars.SHELLBELL_ENABLE_MOBILE_RELEASE == 'true' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'",
    ),
  );
  for (const platform of ["android", "ios"]) {
    assert.equal(jobs[platform].needs, "prepare");
    assert.equal(jobs[platform].if, githubExpression("needs.prepare.outputs.release == 'true'"));
    assert.equal(jobs[platform].environment, "mobile-internal");
    assert.equal(jobs[platform].permissions, undefined);
    assert.ok(
      jobs[platform].steps.some(
        (step) => step.name?.startsWith("Remove") && step.if === githubExpression("always()"),
      ),
    );
  }
  assert.deepEqual(jobs.tag.needs, ["prepare", "android", "ios"]);
  assert.equal(document.permissions.contents, "read");
  assert.equal(jobs.tag.permissions.contents, "write");
});
