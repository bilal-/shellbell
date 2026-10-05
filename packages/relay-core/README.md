# Shellbell relay core

Shared authentication, pairing, revocation, ciphertext routing, bounded resource
accounting and direct push policy. Runtime sockets, SQL, timers and provider
transport are behind ports. Core source imports no Workers API, Node builtin,
SQL driver or application module.

The supplied [Cloudflare](../../apps/relay/README.md) and [Node](../../apps/relay-node/README.md)
runtimes implement those ports. See [adapter contracts](../../docs/relay-adapters.md)
for another host and [test support](test-support/README.md) for conformance.

This is a private workspace package, not a published stable SDK. The production
export is the package root; repository test support is not a runtime dependency.
The core and both adapters share one [relay release version](../../docs/versioning.md).
