# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: `CONTEXT-MAP.md` at the root points at each context's `CONTEXT.md`.

## Before exploring, read these

- **`AGENTS.md`** at the repo root: read it first for a direct package-file entry.
- **`CONTEXT-MAP.md`** at the repo root: read it next to find the governing canonical glossary and its governed path scopes.
- **The mapped `CONTEXT.md`**: read it after the map. A direct package-file entry therefore reads root `AGENTS.md`, then `CONTEXT-MAP.md`, then the mapped skill-local glossary when that glossary governs the package.
- **`docs/adr/`**: read ADRs that touch the area. Read a mapped context ADR directory only when the map says one exists.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Context scope follows vocabulary ownership and consumers, not adjacency or
execution architecture. One skill-local glossary may govern both skill and
package paths. The map records the canonical glossary and every governed scope:

```text
/
├── CONTEXT-MAP.md
├── CONTEXT.md                         ← system-wide glossary
├── docs/adr/                          ← system-wide decisions
├── plugin/                            ← Plugin Payload root; not one context
│   └── skills/
│       ├── new-skill/
│           └── CONTEXT.md             ← mapped skill-local vocabulary context
│       └── frontier-runner/
│           └── CONTEXT.md             ← also governs packages/frontier-runner/**
├── runtime/                           ← portable runtime + skill catalog
├── scripts/                           ← authoring, release, and proof tooling
└── packages/
    └── frontier-runner/               ← uses the mapped skill-local glossary
```

Create context files lazily. One canonical glossary governs shared vocabulary
by default. A skill-local glossary may govern both `plugin/skills/<id>/**` and
`packages/<id>/**` when their vocabulary is shared and installed agents need it.
A second glossary is allowed only for distinct resolved package-scoped project
vocabulary with a distinct consumer. Do not duplicate definitions or add a
pointer-only payload glossary to a non-shipping package path.

`CONTEXT.md` never owns implementation details or workflow steps. `SKILL.md`
owns workflow. Code and package docs own implementation truth.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the governing `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

The root glossary is explicit about rejected synonyms — for example, prefer **Harness** over "host", **Plugin Payload** over "bundle" or "package", **Harness Adapter** over "host adapter", and **Portable Runtime** over "Bun runtime" or "generated script".

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (workspace authoring, bundled distribution) — but worth reopening because…_

Note that ADR 0002 and ADR 0004 are **superseded** (by 0006). Treat superseded ADRs as historical rationale only; reconcile proposals against the current accepted set.
