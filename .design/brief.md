# Brief

**Subject.** Shadow Run sits between an AI agent and production. Every risky plan is frozen, hashed and run first on a
full clone of prod inside a microVM with no network card. Postgres measures what the plan really did. A different
person approves that exact plan, and the same plan runs on prod in one transaction that rolls back on any surprise.

**Audience.** Hackathon judges (Vultr Agent Rush, lablab), then engineers and the person who answers for a production
database. They give each project a few minutes, skim first, and click one thing if the first screen earns it.

**The one job.** Make a judge believe, inside 30 seconds, that the agent broke a real clone and prod did not move, and
that every number on the page was measured. Then get them to press one button and watch it happen live.

**Primary CTA.** "Race the agent" (the same task, agent alone against agent through Shadow Run, live). Secondary: "Continue as guest".

**The subject's world.** Test chambers and crash-test sleds. Blast radius rings. Sealed specimen jars. Forensic
evidence bags and chain-of-custody tags. Flight recorders. Oscilloscope traces. Lab notebooks with measured values,
units and timestamps. Hash stamps, signatures, receipts. Two identical rooms: one gets wrecked, one stays still.
Materials: matte instrument panels, phosphor, graph paper, carbon-copy receipts, red tamper tape.
Motion in this world: mechanical, metered, a needle settling; a hard cut when something breaks; prod never moves.
Sounds (not used): relay clicks, a shutter, a stamp.

**Dials.** CRAZINESS 7 · MOTION 7 · DENSITY 6. Evidence has to stay readable, so the wild part is one signature moment,
not every section.

**Hard constraints.**
- React 18 + Vite + TypeScript, Lenis already in. No new heavy runtime unless the signature needs it.
- Every number comes from bench/*.json or the live API at render time. Real UI, never a mockup.
- Pages: landing (chapters), Race, Results, Run page, Who pays, Red team, Guardrails, Receipts, Audit.
- Works at 360 px, keyboard, reduced motion, both themes (dark default, light).
- Deadline: submission on 8 Nov 2026. Nothing may break the live demo.
