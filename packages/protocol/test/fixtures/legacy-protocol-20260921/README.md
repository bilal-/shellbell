# Frozen pre-stream protocol parsers

These six files are byte-for-byte copies of the local parser dependency closure at source revision `a32ac78` (2026-09-21), before the bounded-stream wire schemas were added. Their relative imports resolve only inside this directory (besides the unchanged external `zod` and `cborg` packages). They are an immutable compatibility test fixture, not production code; do not regenerate them from current sources.

| Source file | Git blob ID |
| --- | --- |
| `src/inner.ts` | `16758172090b98f955821ae9f99ebdb9feb26829` |
| `src/loose.ts` | `eca0f5cb85f12867076f84ed321692dd8667060e` |
| `src/ctrl.ts` | `063b31df6222c56d73775f7cbf90e08d58318b78` |
| `src/envelope.ts` | `76f38236a99d0e645b2b9317a3747f0c47703446` |
| `src/codec.ts` | `fd304fdf46d2ea8a7e682f2024e411b6ddd7a6a8` |
| `src/keys.ts` | `c142db652f403b4357b8f88447999316e9b813f0` |
