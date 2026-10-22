# Install the mobile app

The iPhone, iPad and Android apps are **invite only** through TestFlight and Google
Play internal testing. Computer downloads are public. You do not need to build
from source or use Expo Go to install an invited mobile build.

## Request an invitation

Use the [invitation form](https://shellbell.dev/beta/) and choose your platform.
Provide the Apple Account you use for TestFlight or the Google account you use in
Google Play. For both platforms with different accounts, mention that in the
optional note. Never include passwords, pairing QRs or tokens.

A request does not itself grant access. Wait for the invitation and follow its
account-specific instructions. These builds have no public store listing.

## iPhone and iPad

1. Install Apple's TestFlight app on the device you want to use.
2. Open your invitation on that device and accept it with the invited account.
3. Install Shellbell from TestFlight. The listing shows device compatibility and
   the available build.
4. Open Shellbell and pair it with your computer as described below.

TestFlight builds expire after up to 90 days. Enable **Automatic Updates** on
Shellbell's TestFlight page to receive available replacements. An expired build
needs a newer available build; contact Bilal if none is offered. See
[Apple's TestFlight guide](https://testflight.apple.com/).

## Android

1. Open the invitation's testing link while signed in to the invited Google account.
2. Accept the invitation to become a tester, then follow its Google Play install link.
3. Check that the Play Store on your phone is using that same account.
4. Install and open Shellbell, then pair it with your computer.

Internal builds are not discoverable through normal Play Store search. Google
explains [tester access and opt-in links](https://support.google.com/googleplay/android-developer/answer/9845334).
Once enrolled, use Play Store updates; **Enable auto update** on Shellbell's store
page is optional. See [Google's update instructions](https://support.google.com/googleplay/answer/113412).

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
