# Install the mobile app

Shellbell is publicly available on the [App Store](https://apps.apple.com/app/shellbell-remote-terminal/id6818906627)
and [Google Play](https://play.google.com/store/apps/details?id=sh.bilal.shellbell).
Public installation does not require an invitation, a source build or Expo Go.
Store updates can reach the platforms at different times; a testing release tag
is not evidence that the public store has approved an update.

## iPhone and iPad

1. Install Shellbell from the App Store on your device.
2. Open it and pair with your computer as described below.
3. Use normal App Store updates for public releases.

Apps/plugins and localhost previews are Android-only in version 1.2. iPhone and
iPad retain Agents and Terminals.

## Android

1. Install Shellbell from Google Play while signed into your normal store account.
2. Open it and pair with your computer.
3. Use Play Store updates; enabling automatic updates is optional.

Android 1.2 requires Android 9 or newer. Apps needs computer Shellbell 0.17 or
newer and a registered application; install the application separately before
its plugin. See [plugins](plugins.md) and [local previews](apps.md).

## Optional testing builds

TestFlight and Google Play internal testing are separate from the public apps.
For iPhone/iPad TestFlight access, use the [invitation form](https://shellbell.dev/beta/).
For Android internal testing, follow the maintainer-provided opt-in link with the
invited Google account. An invitation does not transfer between accounts.
Never send passwords, pairing QRs or tokens in an invitation request.

Install Apple's TestFlight app before accepting an iPhone/iPad testing invitation.
TestFlight builds expire after up to 90 days; automatic updates can install
available replacements. Android internal builds are not discoverable through
ordinary Play Store search. See [Apple's TestFlight guide](https://testflight.apple.com/)
and [Google's tester access guide](https://support.google.com/googleplay/android-developer/answer/9845334).

## Pair with your computer

Install and start the [Mac app](../apps/macos/README.md#install-the-published-mac-app)
or [headless computer service](install-agent.md) first. Linux has its own
[installation steps](../apps/linux/README.md#operator-workflow).

Show a new pairing QR on the computer (or run `shellbell pair` for headless
operation), scan it in Shellbell on the phone, and approve the request on the
computer. Allow camera access to scan; notifications are a separate permission
for alerts. If the pairing invitation expires, generate a fresh QR. The QR
contains a temporary secret: do not share it or include it in a bug report.

Keep the computer awake and its service running. Open a supported iTerm2, tmux
or Herdr session on macOS, or a tmux session on Linux. An ordinary terminal
window outside those integrations will not appear automatically. See
[terminal setup](install-agent.md#configure-terminal-access) and
[connection troubleshooting](how-shellbell-connects.md).

## If installation is blocked

- **No invitation or access denied:** confirm the invited email and store account.
  Changing accounts does not transfer access; contact [Bilal](https://bilal.sh)
  if the wrong account was invited.
- **No build offered or TestFlight build expired:** confirm that you accepted the
  invitation and ask whether a replacement is available. Do not reset pairings
  as an update workaround.
- **Device marked incompatible:** use the requirements shown by the testing store.
  Sideloading an APK is not an equivalent qualified installation path.
- **Installed but no computer appears:** installation and pairing are separate.
  Start the computer service and complete QR pairing; check local-network
  permissions if the direct connection cannot start.

For a report, include platform, OS version, app version/build, and the exact
non-sensitive error. The [support page](https://shellbell.dev/support/) links to
diagnostics and private security reporting. Native development and signing are
documented separately in [local mobile releases](local-mobile-releases.md).
