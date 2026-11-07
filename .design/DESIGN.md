# Shadow Run design system

## Taste (from .design/taste.md)
IS forensic, precise, unflinching. NEVER hacker cliché, hype SaaS, playful.
Motion is mechanical and metered: values settle, breakage snaps, prod never moves. Surfaces are matte instrument
panels, graph paper, receipts and red tamper tape. Lines not to cross: no number that isn't read from a file or the
API, no mockups, nothing essential behind hover or animation, and the red of "bad" is never decoration.

## Concept
Two rooms, one clock. The page is the experiment. The clone is wrecked in plain view and prod sits beside it, still.
Every verdict reads as an exhibit: a before-to-after eyebrow with units, one blunt figure, a source line.

## Tokens (web/src/styles/tokens.css is the source of truth)
- Ground `--bg #0a0c0b`, raised `--bg-1 #111413`, inset `--bg-inset #060807`. Ink `--ink #f1efe7`, `--ink-2`, `--ink-3`.
- Meaning only: `--good #3ddba9`, `--bad #ff5a45`, `--caution #eec84e`, each with `-bg` and `-line`.
- Light theme mirrors every token under `[data-theme="light"]`.
- Type: Archivo condensed for display (uppercase verdicts), Geist for text, Geist Mono for every number, Doto for
  instrument readouts only. Fluid sizes with clamp in type.css.
- Frames: 1 px hairlines `--line`, registration marks at frame corners, no radius above 2 px, no shadows.

## Motion
- Durations: `snap` 140 ms (breakage, stamps), `settle` 640 ms (needles, verdict figures), `reveal` 500 ms (opacity).
- Easings: settle `cubic-bezier(0.16, 1, 0.3, 1)`; reveal `cubic-bezier(0.33, 1, 0.68, 1)`; snap `steps(4)` or linear.
- Reveals are opacity only, once, at 80% of the viewport. No fade-up travel on text.
- Numbers never count up or roll (`ui/Measured.tsx`): only the changed digits swap.
- Reduced motion: no travel, no stamps animating, no needle motion; every final state is shown at once.

## Signature moments
1. Hero seam: clone and prod side by side, replayed at real speed from a recorded run; prod's ledger never changes,
   its hash is checked last. Fallback on phones: rooms stack, the seam runs horizontally.
2. The finding: the recorded attempts of a plan that got around a rule; the last one passes every guardrail and is
   then stamped "got around a rule" in tamper red, in four hard steps, once.

## Components
Verdict block (eyebrow `[ a → b unit ]`, figure, label, source line), exhibit rail (desktop landing only, a needle
naming the chapter in view), ladder (attempt list with a spine), tiles (hairline grid of figures), Figure with
`fig. n` source line, Notice, two-room frame.
