# Third-party credits and notices

Shellbell's own code is covered by [LICENSE](LICENSE). Dependencies and bundled
assets retain their upstream licenses; this index is not a replacement for those
license texts or a complete software bill of materials.

## Mobile terminal

- **xterm.js and its contributors:** the terminal renderer and associated addons.
  Upstream packages are consumed without editing their source. Their original MIT
  license texts are included in the mobile app's Open-source credits screen.
- **JetBrains Mono / Nerd Fonts:** bundled font notices are retained separately.

See the [mobile notices](apps/mobile/THIRD_PARTY_NOTICES.md),
[font licenses](apps/mobile/assets/fonts/LICENSE.md), and
[terminal upgrade guide](docs/mobile-terminal-renderer.md).

## Direct transport

`react-native-webrtc` (MIT; native WebRTC components retain their upstream
notices) provides the mobile WebRTC connection. `node-datachannel` (MPL-2.0)
provides the computer's native WebRTC runtime and is included in packaged
distributions. Its platform binaries retain the upstream MPL license. See the
[direct transport and qualification](docs/architecture/direct-transport.md).
The experimental KKpsk2 tests use hexadecimal known-answer data from
[Sendspin's](https://github.com/Sendspin/sendspin-js) Apache-2.0 vector fixture;
its [license](packages/protocol/test/fixtures/SENDSPIN-LICENSE.txt) is retained.

## Desktop and headless bundles

Packaged distributions include a private Node.js runtime and production
dependencies. Packaging retains the runtime LICENSE and inventories dependency
license/notice files; retain these when redistributing an archive or app.
Additional protobuf notices are maintained under
[DependencyLicenses](apps/macos/Resources/DependencyLicenses).

Consult the exact artifact's included notices and the pinned dependency versions,
not only this summary. Do not remove upstream copyright comments or replace
dependency licenses with Shellbell's license.
