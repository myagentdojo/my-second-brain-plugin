# Agent Browser Source Guidance

- Keep `SKILL.md` as the Agent Browser workflow owner. Keep deterministic
  browser mechanics and repair guidance with Warm Browser.
- Keep exactly two Modules: Warm Browser and Private Delivery. Warm Browser
  owns the Command Vocabulary and Result Vocabulary; Browser
  Session, Controlled Page, Snapshot Generation, Snapshot Reference validity,
  and Screenshot ownership remain internal to Warm Browser.
- Keep the production Adapter fixed and every mock internal. Do not introduce
  a public or general seam, and do not give production code a test parameter;
  substitute a private internal seam from a test preload instead.
- Use the canonical terms in `CONTEXT.md` across the skill, package, CLI, tests,
  and Formation Packet. Update the glossary and `CONTEXT-MAP.md` together when
  domain language changes.
- Preserve the clean-sheet boundary. Browser Use, Browser Connect, Warm Chrome,
  and `browser-use-prototyper` are evidence or excluded predecessors, not
  dependencies or fallback paths.
- Preserve the single Browser Session, single Controlled Page, exact-origin
  Credential Match, field-by-field Private Delivery, and explicit human
  approval boundaries.
- Keep maturity truthful. Do not claim Profile Cutover, installation, release,
  or credential safety without proof at the owning seam.
- Use the Agent Plugin Kit only as the pattern for one domain owner of Command
  Vocabulary and Result Vocabulary. Do not add its facade, Branch Station,
  Station Map, LogTape, events, telemetry, or audit machinery.
- Keep browser runtime, Playwright dependencies, CLI implementation, catalog
  activation, and installation generation in their owning package, runtime
  sources, and build pipeline. Keep profile changes outside this skill source.
- Follow [`CODING_STANDARDS.md`](CODING_STANDARDS.md) for the accepted
  Agent-Plugin-Kit-derived CLI idioms and public-process proof boundary.
