# How Shellbell connects your phone and computer

Both devices connect outward to a relay over WebSockets. The relay authenticates
connections, coordinates pairing and forwards end-to-end encrypted messages.
It cannot read terminal screens, history, titles, commands or typed input.

Normal mobile connections negotiate secure v2 and a native WebRTC data channel.
Terminal updates, history and input wait for the verified direct connection. If
direct fails, the terminal pauses while Shellbell retries; the phone offers an
explicit temporary encrypted relay fallback. The visible connection status reports
the committed route and negotiation/retry progress. Same-network S22/Mac tests passed; the owner also reports Fold 7 and TestFlight
iPad direct use across Wi-Fi/cellular changes. Broader device/network qualification
remains open in the
[release checklist](before-first-release.md).

## WebSockets and WebRTC

The relay carries pairing and encrypted coordination while both devices can
reach it. Terminal traffic uses it only after explicit temporary fallback:

~~~mermaid
flowchart LR
    C[Computer service] <-->|Encrypted terminal and control messages<br/>outbound WebSocket| R[Relay]
    P[Phone] <-->|Encrypted terminal and control messages<br/>outbound WebSocket| R
~~~

The encrypted relay connection carries WebRTC offers, answers and ICE candidates.
The endpoints bind the live DTLS certificates to paired identities and fresh Noise
keys before committing the transport change. Once that succeeds, terminal updates,
history and input use the data channel:

~~~mermaid
flowchart LR
    C[Computer service] <-->|Encrypted signaling and control<br/>WebSocket stays connected| R[Relay]
    P[Phone] <-->|Encrypted signaling and control<br/>WebSocket stays connected| R
    C <-->|End-to-end encrypted terminal traffic<br/>WebRTC data channel| P
~~~

The current native adapters use local ICE candidates and
[Cloudflare STUN](https://developers.cloudflare.com/realtime/turn/) to discover
public addresses. STUN sees address-discovery packets and source addresses; it
carries no terminal traffic. No TURN server is configured. Networks that prevent
a direct connection leave the terminal paused until direct succeeds or the user
chooses temporary encrypted WebSocket fallback. Changing the relay URL does not
change the native STUN configuration.

## Fallback and retries

If direct transport fails, Shellbell establishes a fresh encrypted relay session
for coordination. Terminal access stays paused unless the user explicitly allows
temporary encrypted relay fallback. That relay session also carries signaling
for a new direct attempt. Successful direct recovery ends the temporary exception. Retries use jittered exponential backoff,
starting at roughly five seconds and capped at sixty seconds. They wait for
outstanding input acknowledgements so a transport switch cannot replay input.
After thirty-two attempts, the phone refreshes its relay connection to bound
attempt tracking.

Closing the app stops retries. Explicitly disabling direct mode stops attempts
until a new endpoint is opened. A working relay helps the devices try WebRTC
again; it cannot make an incompatible network support a direct path.

Direct traffic reduces terminal bytes routed through the relay. Both WebSockets,
authentication, pairing and push coordination still need relay resources. See
[capacity planning](architecture/relay-capacity.md) for the assumptions and
measurements behind that distinction.

## Pairing

A pairing QR contains the relay address, computer name, public computer identity,
a random temporary gate token and a separate random pairing secret. The default
invitation lasts five minutes. The computer sends the relay only the gate hash
and expiry. The phone presents the gate token during admission; the relay never
receives the separate pairing secret.

~~~mermaid
sequenceDiagram
    participant C as Computer
    participant R as Relay
    participant P as Phone
    C->>C: Create gate token and separate pairing secret
    C->>R: Open pairing window with gate hash and expiry
    C-->>P: Show QR for the phone to scan
    P->>R: Connect using the QR relay address and gate
    R->>R: Check gate, expiry and live computer connection
    P->>C: Encrypted pairing request through relay
    C->>C: Ask the owner to approve the phone
    C->>R: Authorize the phone's public identity
    C-->>P: Encrypted pairing response through relay
    C->>R: Close the temporary pairing window
~~~

The phone checks that the QR public key matches its fingerprint; the encrypted
exchange confirms knowledge of the pairing secret. Normal interactive pairing
asks for approval on the computer. The CLI's auto-accept option skips that prompt
and is unsafe on a shared screen. Treat the QR as a temporary credential and
check the phone identity before approving.

Both devices save their pairing keys locally. The relay stores public pairing
metadata for admission and routing. Routine reconnection and network changes do
not require another QR. Secure v2 records a protocol floor; disabling direct
mode does not authorize a downgrade to v1.

## Terminal use and notifications

1. The phone requests sessions or subscribes to a screen over the active encrypted transport.
2. The computer sends screen changes. History is requested in bounded chunks.
3. The active path forwards ciphertext to the paired recipient. The relay neither interprets terminal content nor keeps an offline screen replay queue.
4. Input follows the active path back to the computer, which checks the pairing and applies it to the selected terminal backend.

The service operates on terminal sessions owned by the computer's OS user.
Closing the phone app does not stop that service. Notifications use direct FCM
or APNs through the relay, with separate policy, routing metadata and encrypted
private context. See [private notifications](private-notifications.md).

## Choosing or changing the relay

Set the same base WSS origin at both ends:

- Headless service: `shellbell config set relay wss://relay.example.com`.
- Mac app: **Relay address** in settings.
- Phone: **Relay URL** in that computer's settings.

The computer service must restart to apply a saved URL; the phone reconnects when
you save. These edits preserve local identities and pairing keys. A new relay
with no existing pairing metadata may require pairing again. There is no
automatic state migration between deployments. Follow the
[self-hosting guide](self-hosting.md#connect-your-devices) for the full procedure.

## What each party can see

The computer and paired phone decrypt terminal content. The relay sees source
addresses, public identities, pairing relationships, timing, frame sizes and
notification routing metadata. Push providers see their delivery metadata and
generic notification fields; private context remains recipient-encrypted.

Revocation differs by protocol: v1 relies on the relay's pairing authority and
legacy notices; secure v2 adds signed, epoch-bound revocation. These are current
implementation contracts, not a completed independent cryptographic audit.
[PRIVACY.md](../PRIVACY.md) owns the data inventory;
[the protocol reference](protocol.md) and [secure v2 contract](architecture/direct-transport-wire-v2.md)
define the wire behavior.
