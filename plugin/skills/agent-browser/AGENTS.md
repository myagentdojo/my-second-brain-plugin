# Agent Browser Source Guidance

- Keep `SKILL.md` as the Agent Browser workflow owner. Keep deterministic
  browser mechanics and repair guidance with Warm Browser.
- Keep exactly two future Modules: Warm Browser and Private Delivery. Warm
  Browser owns the future Command Vocabulary and Result Vocabulary; Browser
  Session, Controlled Page, Snapshot Generation, and Snapshot Reference
  validity remain internal to Warm Browser.
- Keep the production Adapter fixed and every mock internal. Do not introduce
  a public or general seam.
- Use the canonical terms in `CONTEXT.md` across the skill, package, CLI, tests,
  and Formation Packet. Update the glossary and `CONTEXT-MAP.md` together when
  domain language changes.
- Preserve the clean-sheet boundary. Browser Use, Browser Connect, Warm Chrome,
  and `browser-use-prototyper` are evidence or excluded predecessors, not
  dependencies or fallback paths.
- Preserve the single Browser Session, single Controlled Page, exact-origin
  Credential Match, field-by-field Private Delivery, and explicit human
  approval boundaries.
- Keep the scaffold truthful. Do not claim implementation, native discovery,
  installation, activation, release, or credential safety without proof at the
  owning seam.
- Use the Agent Plugin Kit only as the pattern for one domain owner of Command
  Vocabulary and Result Vocabulary. Do not add its facade, Branch Station,
  Station Map, LogTape, events, telemetry, or audit machinery.
- Keep browser runtime, Playwright dependencies, CLI implementation, catalog
  activation, installation regeneration, and profile changes outside this
  documentation-only Architecture Shell.
- Keep `CODING_STANDARDS.md` absent until the accepted Architecture Shell and
  Test Design evidence support the separate Coding Standards checkpoint.
