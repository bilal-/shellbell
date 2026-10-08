import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mobile = fileURLToPath(new URL("..", import.meta.url));
const gradle = process.env.SHELLBELL_TEST_GRADLE || join(mobile, "android/gradlew");
const initializer = join(mobile, ".listing-kit/android.init.gradle");

// Run the real initializer through Gradle without downloading Android plugins or
// building an APK. The fixture exposes the Android/RN extension properties it uses.
function run(task, withLocalTest = true) {
  const dir = mkdtempSync(join(tmpdir(), "shellbell-listing-gradle-"));
  try {
    mkdirSync(join(dir, "app"));
    writeFileSync(
      join(dir, "settings.gradle"),
      "rootProject.name = 'listing-test'\ninclude ':app'\n",
    );
    writeFileSync(
      join(dir, "app/build.gradle"),
      `
class BuildType {
    String name
    String versionNameSuffix
    Object signingConfig
    List matchingFallbacks = []
    boolean debuggable = true
    BuildType(String name) { this.name = name }
    void signingConfig(Object value) { signingConfig = value }
    void debuggable(boolean value) { debuggable = value }
    void versionNameSuffix(String value) { versionNameSuffix = value }
    void initWith(BuildType other) {
        versionNameSuffix = other.versionNameSuffix
        signingConfig = other.signingConfig
        matchingFallbacks = other.matchingFallbacks
        debuggable = other.debuggable
    }
}
def types = container(BuildType) { new BuildType(it) }
types.create('release') { signingConfig = 'production'; debuggable = false }
${withLocalTest ? "types.create('localTest') { versionNameSuffix = '-local-test'; signingConfig = 'debug' }" : ""}
extensions.add('android', [buildTypes: types, signingConfigs: [debug: 'debug']])
def entry = objects.fileProperty()
entry.set(file('normal-entry.js'))
extensions.add('react', [entryFile: entry])
['assembleLocalTest', 'assembleListingCapture', 'assembleRelease'].each { name ->
    tasks.register(name) {
        doLast {
            def variants = types.collectEntries { t ->
                [(t.name): [suffix: t.versionNameSuffix, signing: t.signingConfig,
                    debuggable: t.debuggable, fallbacks: t.matchingFallbacks]]
            }
            file('result.json').text = groovy.json.JsonOutput.toJson(
                [variants: variants, entry: entry.get().asFile.name])
        }
    }
}
`,
    );
    const result = spawnSync(
      gradle,
      ["--offline", "--no-daemon", "--console=plain", "-p", dir, "-I", initializer, `:app:${task}`],
      { encoding: "utf8", timeout: 120_000 },
    );
    assert.ifError(result.error);
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      report: result.status === 0 ? JSON.parse(readFileSync(join(dir, "app/result.json"))) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const withLocalTest of [true, false]) {
  test(`capture has a dedicated marked variant (existing localTest: ${withLocalTest})`, () => {
    const result = run("assembleListingCapture", withLocalTest);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.report.variants.listingCapture, {
      suffix: "-listing-capture",
      signing: "debug",
      debuggable: false,
      fallbacks: ["release"],
    });
    assert.equal(result.report.entry, "entry.ts");
    assert.equal(
      result.report.variants.localTest?.suffix,
      withLocalTest ? "-local-test" : undefined,
    );
    assert.equal(result.report.variants.release.signing, "production");
    assert.equal(result.report.variants.release.suffix, null);
  });
}

for (const task of ["assembleLocalTest", "assembleRelease"]) {
  test(`the capture initializer rejects ${task}`, () => {
    const result = run(task);
    assert.notEqual(result.status, 0, `${result.output}\n${JSON.stringify(result.report)}`);
    assert.match(result.output, /Listing capture only supports/);
  });
}
