# @shellbell/relay

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
