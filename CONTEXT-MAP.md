# Context Map

This repo is multi-context. Each context owns its own vocabulary; this map says where to read.

Consumer rules for these files: `docs/agents/domain.md`.

## Contexts

| Context | Glossary | Context ADRs | Scope |
| --- | --- | --- | --- |
| **System-wide** | [`CONTEXT.md`](./CONTEXT.md) | [`docs/adr/`](./docs/adr/) | Plugin distribution across Harnesses: Plugin Payload, Harness Adapter, Portable Runtime, Marketplace, Release, Capability Tour, and the capability boundaries. |
| **New Skill Formation** | [`plugin/skills/new-skill/CONTEXT.md`](./plugin/skills/new-skill/CONTEXT.md) | None. | `plugin/skills/new-skill/**`: Formation Run, Formation Packet, Mandatory Skill Scaffold, Complexity Gate, Architecture Shell, approval checkpoints, maturity, and the implementation frontier. |
| **Decision View** | [`plugin/skills/decision-view/CONTEXT.md`](./plugin/skills/decision-view/CONTEXT.md) | None. | `plugin/skills/decision-view/**`: Decision View, Decision Input, Decision Result, Response Map, and Wait What Disclosure. |
| **Frontier Runner** | [`plugin/skills/frontier-runner/CONTEXT.md`](./plugin/skills/frontier-runner/CONTEXT.md) | None. | `plugin/skills/frontier-runner/**` and `packages/frontier-runner/**`: Frontier Runner V0, Bounded run, and their shared vocabulary. |

## Which glossary governs

- A term describing distribution, packaging, harness behavior, runtime custody, or release uses the **system-wide** `CONTEXT.md`.
- One canonical glossary governs shared vocabulary by default. Choose it by vocabulary owner and consumer, not adjacency, execution architecture, or portability.
- A skill-local glossary may govern both `plugin/skills/<id>/**` and `packages/<id>/**` when their vocabulary is shared and installed agents need it.
- A second package glossary is valid only for distinct resolved package-scoped project vocabulary with a distinct consumer. Create it and its map row lazily.
- A direct package-file entry reads root `AGENTS.md`, then this map, then the mapped canonical glossary.
- A decision affecting more than one context belongs in root `docs/adr/`.

## Non-contexts

The `plugin/` root is not one context. `runtime/` and `scripts/` remain under
the system-wide glossary. Glossaries contain vocabulary only; workflow belongs
in `SKILL.md`, and implementation truth belongs in code and package docs.
Editing ownership lives in [`AGENTS.md`](./AGENTS.md).
