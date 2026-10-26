# Native WebRTC binary

The computer service's direct connection runs on `node_datachannel.node`, which Shellbell
builds itself rather than taking node-datachannel's prebuilt binaries. Those carried old
crypto (OpenSSL 1.1.1 on Linux) and lagged libdatachannel's fixes. Our build:

- compiles node-datachannel's bindings against a newer libdatachannel than its own pin;
- links OpenSSL 3.5 LTS statically, so the service never depends on the system's OpenSSL;
- leaves out media (libsrtp) and WebSocket support, which Shellbell never uses;
- targets macOS 13 and glibc 2.30 (Debian bullseye), the oldest systems Shellbell supports.

[`webrtc.json`](webrtc.json) pins every input by commit or SHA-256 (node-datachannel,
libdatachannel and its submodules, OpenSSL, CMake, the Linux build image) and pins each output
binary by SHA-256. The service loads the binary only through
[`runtime/webrtc-native.mjs`](../../runtime/webrtc-native.mjs) (`#webrtc-native`), from
`apps/agent/webrtc/<target>/`, which git ignores.

| Target | Ships in |
| --- | --- |
| `darwin-arm64` | Mac app, npm |
| `darwin-x64` | npm (Intel Macs) |
| `linux-arm64-gnu`, `linux-x64-gnu` | Linux download |

## Get the binaries

```sh
pnpm -F shellbell webrtc:fetch                   # this machine's, from the release assets
pnpm -F shellbell webrtc:fetch darwin-arm64 darwin-x64
node apps/agent/native/webrtc/fetch.mjs --from /abs/build/output linux-x64-gnu
```

Each copy must match its pin. Packaging installs only the target's binary and checks it again;
`npm publish` refuses to run unless exactly the two Mac binaries are present.

## Update a library

1. Change the pins in `webrtc.json` (commit SHAs, not tags) and bump `version`
   (`<node-datachannel>-sb.<n>`) and `release` to match.
2. Build on an Apple silicon Mac with Docker running (about 15 minutes; Linux x64 is emulated):

   ```sh
   node apps/agent/native/webrtc/build.mjs --target all --output /abs/new/dir
   ```

   The builds are not bit-for-bit reproducible, so the pins record this build.
3. Copy `binaries.json` from the output into `webrtc.json`'s `binaries`, then fetch with `--from`.
4. Check each binary's contents: `strings` should show the expected OpenSSL and libdatachannel
   versions, and nothing from libsrtp.
5. Update the licence record `webrtc-native@<version>` in
   [`DependencyLicenses`](../../../macos/Resources/DependencyLicenses/index.json) with the
   licence of every library compiled in, at the exact commits built. Packaging fails until it
   matches.
6. Qualify: the Linux archive checks in [apps/linux](../../../linux/README.md) (native WebRTC on
   both architectures), the Mac bundle and signed-candidate checks, and a phone connection.
7. Publish the four binaries as the `webrtc-native-<version>` GitHub release assets named
   `node_datachannel-<target>.node`, before any release that needs them.
