# Pair (vendored)

Pair, the OpenDash mark as an animated plush character, used by `packages/ui/src/components/pair.tsx`.

**Source.** [bot-avatars](https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/bot-avatars) 0.2.2 by
Jakub Antalik, MIT (see `LICENSE`), with OpenDash's own additions, which were unreleased when copied
(2026-10-18): the `opendash` type (the two-stone Pair) and the `thinking`, `listening`, `success` and `error` states.

**Trimmed to Pair alone.** Left out: the other 18 shapes, the accessories' renderer (`wear.ts` is a stub that draws
nothing, and `mesh.ts` is gone), the React Native and SwiftUI ports, the demos and the Studio.

**Changed here:**
- `ticker.ts` draws at most 30 times a second (each draw costs the same at any rate).
- `BotAvatar.tsx` defaults to the `opendash` type, the only one kept.
- Each file starts with `// @ts-nocheck`: the code predates this repo's `noUncheckedIndexedAccess`, so it's neither
  type-checked nor linted here (biome skips `packages/ui/vendor`).

Nothing outside `packages/ui/src/components/pair.tsx` imports from here.
