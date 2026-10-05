# Shellbell protocol

Wire schemas, cryptography and shared terminal models live here. Apps depend on
this package, not on each other. The relay forwards encrypted terminal and signaling
frames; paired endpoints own their decryption keys.

- [Generated wire reference](../../docs/protocol.md)
- [Connection and pairing guide](../../docs/how-shellbell-connects.md)
- [Direct transport profile](../../docs/architecture/direct-transport-wire-v2.md)
- [Version and compatibility rules](../../docs/versioning.md)

Regenerate the wire reference with `pnpm -F @shellbell/protocol gen:protocol-doc`
after schema changes. Keep native notification vectors synchronized. This private
workspace version is an implementation version; it is not the wire protocol number
or an independently released SDK.
