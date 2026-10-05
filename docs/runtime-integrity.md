# Bundled Node runtime integrity

`apps/macos/runtime-manifest.json` pins official Node 22.23.1 archives for arm64 and
x64, their download URLs and SHA-256 hashes. Packaging requires an explicit archive
path and architecture and verifies the archive before extracting the runtime.
It does not silently bundle whichever Node executable is on the developer's PATH.

For an arm64 candidate, download the manifest's official nodejs.org URL, verify its
SHA-256, then run from the repository root:

```sh
node apps/macos/scripts/build.mjs --arch arm64 --output /absolute/new-candidate-directory --runtime-archive /absolute/node-v22.23.1-darwin-arm64.tar.xz --build-number RESERVED_MAC_BUILD_NUMBER
```

The output parent must exist and the candidate directory must not already exist.
This produces a development candidate, not a notarized public release. Preserve
the complete output manifest and verify it using the native packaging tools.
Follow [release signing](macos-release-signing.md) for distribution qualification.
Never replace hashes merely because a download fails verification.
