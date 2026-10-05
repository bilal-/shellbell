# Frozen control-v2 compatibility parser

Frozen on 2026-09-21 from commit `d96b143`:

- `apps/agent/src/control-v2-protocol.ts`: strict status, runtime, nested phone/backend, hello and capability schemas.
- `apps/agent/src/local-status.ts`: ordered backend/readiness validation (inlined).
- `apps/agent/src/backends/registry.ts`: order iterm2, tmux, herdr.
- `packages/protocol/src/ctrl.ts`: MAX_PAIRINGS = 10.
- `packages/protocol/src/envelope.ts` and `inner.ts`: fingerprint and backend name schemas (inlined).

Only Node's stable path predicate and Zod are imported. No current Shellbell production schema is imported: status/hello growth must fail the old strict parser. Non-semantic names/formatting were simplified; readiness validation is equivalent to the historical LocalStatus refinement.
