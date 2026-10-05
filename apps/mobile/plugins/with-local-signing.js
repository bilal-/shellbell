const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function withLocalSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== "groovy")
      throw new Error("Local signing requires Groovy Gradle");
    const marker = "// Shellbell local signing (generated)";
    const original = mod.modResults.contents.split(marker)[0].trimEnd();
    mod.modResults.contents = `${original}\n\n${marker}
def shellbellKeys = ['SHELLBELL_ANDROID_KEYSTORE', 'SHELLBELL_ANDROID_KEY_ALIAS', 'SHELLBELL_ANDROID_STORE_PASSWORD', 'SHELLBELL_ANDROID_KEY_PASSWORD']
def shellbellSigningReady = shellbellKeys.every { System.getenv(it)?.trim() }
if (shellbellSigningReady) {
    android.signingConfigs.create('shellbellRelease') {
        storeFile file(System.getenv('SHELLBELL_ANDROID_KEYSTORE'))
        keyAlias System.getenv('SHELLBELL_ANDROID_KEY_ALIAS')
        storePassword System.getenv('SHELLBELL_ANDROID_STORE_PASSWORD')
        keyPassword System.getenv('SHELLBELL_ANDROID_KEY_PASSWORD')
    }
    android.buildTypes.release.signingConfig = android.signingConfigs.shellbellRelease
}
gradle.taskGraph.whenReady { graph ->
    if (!shellbellSigningReady && graph.allTasks.any { it.project == project && it.name.matches('(?i)(assemble|bundle|package|sign).*release.*') }) {
        throw new GradleException('Shellbell release signing requires private local keystore configuration; refusing debug signing')
    }
}
`;
    return mod;
  });
};
