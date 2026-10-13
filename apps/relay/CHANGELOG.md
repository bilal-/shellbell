# @shellbell/relay

## 0.3.0

### Minor Changes

- fd747b5: TURN is now optional on each computer. It stays on by default; turning it off
  (Mac app Settings → General → **Allow TURN fallback**, or
  `shellbell config set turn off`) keeps terminal data off TURN servers:
  
  - The computer tells the relay when it signs in, and the relay gives none of
    that computer's phones TURN servers, clearing any a phone already holds before
    announcing the computer. The relay confirms this in `auth-ok`; with an older
    relay the computer logs a warning.
  - The computer requests no TURN servers and accepts a connection only when it
    can show the route is direct, rechecking while it stays open.
  
  Phones on networks that block direct connections, and some routes through
  strict NATs, cannot reach a computer with TURN off. Older clients and relays
  ignore the new fields.

### Patch Changes

- Updated dependencies [8a209ab]
- Updated dependencies [fd747b5]
  - @shellbell/relay-core@0.3.0
  - @shellbell/protocol@0.4.0

## 0.2.0

### Minor Changes

- ca05da9: Add a TURN fallback for networks that block direct WebRTC connections. A relay
  configured with TURN gives signed-in computers and phones short-lived TURN servers
  when they sign in and on request (`ice-refresh` / `ice-servers`), and each new
  WebRTC attempt uses them alongside STUN. The TURN server only forwards the
  encrypted data channel; terminal data stays end-to-end encrypted and never goes
  through the relay. The Cloudflare relay issues 24-hour Cloudflare TURN credentials
  when the `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets are set; without them, and
  on the Node relay, devices keep using STUN only. Older clients ignore the new
  sign-in fields.

### Patch Changes

- Fix reliability problems found in a whole-repository review:
  
  - The relay answers every sign-in: one waiting for TURN credentials could be left
    signed in without a reply, and an unanswered TURN provider held up later
    sign-ins; it now waits at most five seconds.
  - The Cloudflare and Node relays decode stored notification jobs the same way, so
    a corrupt saved job fails closed on both.
  - A pairing QR code allows five requests even across a computer reconnect, and a
    confirmation already waiting still completes.
  - A failed pairing save no longer erases a phone's notification enrollment.
  - Two first starts at once keep one computer identity instead of overwriting it.
  - A relay URL too long for a pairing code is refused when it is saved.
  - A tmux screen showing a line that looks like tmux's end-of-reply marker no
    longer cuts a capture short or disconnects tmux.
  - Concurrent iTerm2 reconnects share one connection, so a closing socket no longer
    fails requests on the healthy one.
  - During an interrupted conversion, Mac Settings reads and saves the service's
    actual state directory.
- Updated dependencies
- Updated dependencies [94ed8a4]
- Updated dependencies [ca05da9]
  - @shellbell/protocol@0.3.0
  - @shellbell/relay-core@0.2.0

## 0.1.0

### Patch Changes

- 78cbcfa: Refuse new connections to a computer with 503 while 64 of its sockets are not signed in, counting sockets that are still waiting for the peer to answer the close handshake, so peers that ignore close frames cannot pile up sockets on one computer.
- Updated dependencies [d44c29a]
- Updated dependencies [787ff5f]
- Updated dependencies [4f68d15]
  - @shellbell/relay-core@0.1.0

## 0.0.4

### Patch Changes

- Updated dependencies [5202bd4]
  - @shellbell/protocol@0.2.0
  - @shellbell/relay-core@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [3a94500]
- Updated dependencies [874b3ae]
- Updated dependencies [279b85f]
  - @shellbell/protocol@0.1.0
  - @shellbell/relay-core@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [93cba0f]
- Updated dependencies [9084eb1]
- Updated dependencies [9084eb1]
  - @shellbell/relay-core@0.0.2
  - @shellbell/protocol@0.0.2
