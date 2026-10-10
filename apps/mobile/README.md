# Shellbell mobile

<picture><source media="(prefers-color-scheme: dark)" srcset="../../brand/svg/mark-on-dark.svg"><img src="../../brand/svg/mark-on-light.svg" alt="" width="18" height="18"></picture> [Native build guide](../../docs/local-mobile-releases.md) · [Device QA](QA.md)

Android and iOS clients use React Native and Expo libraries with an offline xterm.js
terminal renderer. Shellbell requires a native build, not Expo Go. Notifications
register native FCM/APNs tokens; Expo Push Service is not used.

Pair by scanning the computer's QR and approving the phone on that computer. Each
paired computer has a **Relay URL** setting. Both devices must use the same relay;
changing the URL preserves local keys but an empty relay may require pairing again.
See [connection behavior](../../docs/how-shellbell-connects.md).

On first launch, the app links to the Terms of Use and Privacy notice and asks for agreement before starting connections. Declining keeps the app on that screen. Agreement is saved locally for that terms version. A separate Agree / Decline dialog appears before pairing through or saving a custom relay address that this device has not accepted. The app remembers the choice for that address.

Normal mobile connections negotiate secure v2 and native WebRTC through encrypted
relay signaling. Terminal input and subscriptions wait for a verified direct route,
including after direct loss. The app shows connection progress and offers an
explicit temporary encrypted relay fallback; successful direct recovery ends that
exception. The v2 floor persists across reconnects. The owner reports Fold 7 and TestFlight iPad direct use across Wi-Fi/cellular
changes; broader physical-device and network qualification remain open. `EXPO_PUBLIC_SHELLBELL_DIRECT=1` exposes owner diagnostics
and fault-injection drills; it is no longer the activation switch.

From the repository root:

```sh
pnpm -F @shellbell/mobile test
pnpm -F @shellbell/mobile typecheck
pnpm -F @shellbell/mobile doctor
```

After installing a native development build, `pnpm -F @shellbell/mobile start`
runs Metro. The standalone local test APK bundles JavaScript and does not need it.

Android and iOS share the mobile package's marketing version; native build numbers
are explicit per platform. Read [versioning](../../docs/versioning.md) before
preparing artifacts. A custom push deployment needs matching app identities and
server credentials. Neither those credentials nor signing keys belong in Git.

## Settings and new sessions

Open Settings with the gear at the top right of Computers. The screen shows the
installed app version and native build number. **Scale terminal to fit** adjusts
the font to show the computer's existing columns; it does not wrap or resize the
computer terminal. Font controls show **Auto** while scaling is enabled. Turn it
off to choose a font size, or use **Read** in a session for wrapped text.

The **+** picker lists iTerm2, tmux and Herdr with availability guidance. A current
computer service can start installed backends even when no session is open. iTerm2
needs its Python API enabled; tmux starts a detached first session; Herdr starts its
headless server and creates a first workspace if needed. An older service can only
advertise already connected backends. See [computer startup](../../docs/architecture/computer-agent.md#starting-a-terminal-from-the-phone).

## Pairing and custom relays

The scanner frames the QR code and highlights its detected bounds when the
camera provides them. After capture, confirm the computer name and fingerprint.
The app shows connection progress, then asks you to approve the device on the
computer. Leaving the screen or choosing **Stop waiting** closes this phone's pairing
connection. It does not withdraw the computer's approval prompt. Decline that
prompt before retrying; if it was already approved, remove the device on the
computer before pairing again.

A custom relay notice appears before pairing through a QR code that names another
operator's relay, and before saving a changed custom relay in settings. The
operator can see connection and routing metadata, but does not receive terminal
decryption keys. Changing relay does not delete records from the previous relay;
see [privacy](../../PRIVACY.md).
