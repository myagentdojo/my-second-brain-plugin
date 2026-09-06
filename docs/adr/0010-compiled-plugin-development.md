# Compile the Portable Runtime during development builds

## Status

Accepted by Nathan on 6 September 2026, including the focused Test Design.
Use one plugin executable per target for the declared compiled skill set.
This scoped amendment preserves the remaining contracts of ADRs 0005, 0006
and 0007. Native usability confirmation remains unproved.

## Context and problem

The existing generated skill launcher selects a catalog identity through
`runtime-exec run <skill> -- <args>`. ADR 0005 owns verification and execution;
ADR 0006 requires a separately acquired Bun executable; ADR 0007 distributes
dependency-closed JavaScript bundles. The contributor build already admits
dependencies and records bundle identities.

The product direction now requires the runtime inside the Plugin Payload and
observable edit/build/refresh/use cycles. Downloaded-runtime construction no
longer satisfies that direction, even though users already avoid manual setup.
The first selected caller is the existing `skill-a`, whose ESM and CommonJS
dependency result can be exercised offline. Other skills remain separate proof
obligations, not implied coverage.

## Decision drivers

- Run the selected skill without external Bun, source or installed dependencies.
- Keep the ordinary skill invocation and native development workflow small.
- Preserve admitted identity, environment isolation and process semantics.
- Preserve unrelated skills and the unfinished Kit consumer adoption.
- Reach a real local demonstration before widening platforms or extraction.

## Options

| Construction | Runtime included | Development cost | Isolation and compatibility | Migration cost |
| --- | --- | --- | --- | --- |
| Existing JavaScript plus acquired Bun | No | Current build/refresh | Already established for its accepted scope | Low, but misses the new product requirement |
| One compiled executable per skill | Yes | Recompile affected executable; duplicate Bun per skill | Natural process separation; still needs installed proof | More executable identities and payload size |
| One compiled executable per plugin and target | Yes | Recompile admitted selected entries; one runtime copy | Explicit selected-entry dispatch; prove lazy loading and preserve separate process invocations | One executable identity per target; staged migration needed |

Recommend one plugin executable per target. Keep per-skill executables only as
a reconsideration option if real process or bundler evidence disproves shared
dispatch. Compilation does not move product code into the Kit.

## Decision

1. Compile at contributor build time with the repository's pinned Bun 1.4.0.
   First prove `darwin-arm64`; compile during neither login nor first skill use.
2. Emit `plugin/bin/<platform>-<arch>/<plugin-name>` from admitted skill code.
   One explicit, build-generated dispatch table selects the compiled skill.
   Import only that skill at invocation. Never evaluate unrelated entrypoints.
3. Keep generated `bin/<skill>` launchers and the existing `runtime-exec run`
   Interface. Extend that owner to select the included executable for a declared
   compiled skill before consulting the acquired-runtime cache. Reuse its
   platform, hash, diagnostic and environment machinery; add no second installer.
4. Extend the catalog and generated inventory in their current owners to bind
   the compiled skill set, target, compiler version, executable path, size and
   digest. The installed launcher verifies the declared artifact before exec.
   Packaging includes executable permissions and target bytes in payload identity.
5. For a compiled skill, missing, corrupt, unsupported or non-executable payload
   returns structured reinstall/rebuild guidance. It neither repairs nor falls
   back to a downloaded runtime. Ordinary skill stdout/stderr/exit pass through.
6. Retain the accepted hostile-environment guarantee. Disable compiled `.env`
   and `bunfig.toml` autoload; keep tsconfig/package autoload disabled. Remove
   ambient Bun control variables, including standalone interpreter mode, before
   exec. Preserve ordinary application environment, cwd, arguments and umask.
7. Keep compilation in the existing build owner. Retain dependency admission,
   notices and generated drift checks. Publish inventory only for successfully
   produced bytes. A failed build cannot qualify yesterday's executable.
8. Reuse `bun run dev -- codex install` preview and candidate-bound apply.
   Include compiled bytes in staged payload/version identity. Keep production
   and development identities separate and report the actual fresh-task reload
   boundary. No new watcher, daemon, Marketplace protocol or manual version bump.

### First-slice migration

Declare only `skill-a` compiled on the first target. Other runtime skills keep
their accepted JavaScript/custody route. This is a migration state, not the final
product: it proves the selected path only. Unqualified targets refuse the
compiled skill instead of silently taking its old runtime path.

The implementation changes the selected caller, build/inventory projections,
runtime execution and their focused proofs. It does not delete unrelated
custody behaviour, change release pins, finish Issue #62 or claim whole-plugin
portability. Keep existing package work and accepted predecessor evidence.

This record amends ADRs 0005, 0006 and 0007 for declared compiled
skills only. Preserve their bodies and link this scoped amendment. Full
supersession and acquired-runtime deletion require all surviving guarantees to
have replacement evidence in the later complete-plugin migration.

## Confirmation: full Test Design brief

**Behaviour:** Two real `skill-a` source edits reach the Development Installation
through Bun compilation and native refresh. The installed selected path works
without external runtime acquisition or contributor files.

**Seam and proof layer:** Real build process, extracted generated launcher,
and real development CLI for mechanics. Native Codex discovery and invocation
are separate human-observed checks. Fake Codex fixtures prove only transition
behaviour; they cannot satisfy the native cells.

**Independent result:** Literal skill JSON values, expected stderr and exit
status; independently measured installed executable bytes and permissions.
Never derive the expected response from the skill function or trust a build
receipt as evidence of execution.

**How it goes RED:** Disposable tampering, missing executable, hostile
environment/configuration, stale compilation and changed post-preview candidate
must fail their owning assertions. Restore each perturbation and prove GREEN
through the same process path. Use existing fixture conventions rather than
creating another runner or evidence framework.

**Relevant profiles:** Process/CLI, installation/native, runtime/platform and
state/recovery. Existing `scripts/runtime-custody-exec.test.ts` owns pass-through
and hostile-environment regression meaning; `scripts/dev.test.ts` owns fake
native transition meaning. Keep raw native evidence under the existing private
qualification owner, not source or the vault.

**Focused command:** `bun test ./scripts/compiled-development.test.ts` from
the repository root, run through Agent Runner. Require seven discovered tests,
zero skips, one per row below. Observe the selector and counts before claiming
coverage.

| Row | Public proof and failure sensitivity |
| --- | --- |
| CD01 | Build and extract real `skill-a`; literal JSON, empty stderr and exit 0 with repository/source/dependencies inaccessible, empty private runtime cache and network denied. Removing the included executable must fail. |
| CD02 | Use a test-owned probe through the same catalog/build/launcher path to prove argv, cwd, ordinary environment, stdin/stdout/stderr and nonzero exit pass-through. It supplements, never replaces, CD01. |
| CD03 | Hostile Bun control environment, cwd/HOME config and preload inputs cannot execute a marker or alter the selected result. Disabling the protection must make the check RED. |
| CD04 | Missing, corrupt, symlinked, wrong-target and non-executable artifacts refuse before skill execution or cache/network repair. Assert structured cause and next action, not only nonzero exit. |
| CD05 | Two distinct real skill edits each rebuild, stage and invoke from independently copied installed bytes with different literal results. Assert unchanged-input rebuild identity separately; fake native success alone does not pass. |
| CD06 | Changed payload after preview invalidates apply before native mutation; same candidate retains its approved identity. Do not add a build cache unless measured compilation behaviour requires one. |
| CD07 | A failed compiler run cannot produce a current candidate or install stale bytes. Keep the prior successful installation intact and expose the build failure. |

**Still unproved:** These tests do not prove native discovery, native trust,
cross-platform execution, browser/worker child isolation, Claude behaviour or
production release qualification. Existing full repository checks remain local
completion obligations; this brief does not replace them.

### Native acceptance

After local proof, separately preview and approve the exact Development
Installation effect. Run two real edit/build/refresh/invoke cycles in Codex,
verify the loaded development identity and both changed results, and record
elapsed time plus Nathan's required actions. Nathan confirms usability before
widening. Preserve the established qualification distinction between mechanics
and fresh-native evidence. The selected skill needs no hook trust change.

## Consequences and revisit triggers

- Positive: the selected installed path is self-contained; the existing skill
  Interface and development command remain familiar.
- Negative: every target artifact includes Bun, increasing installation bytes;
  recompilation may cost more than JavaScript bundling. Measure both cycles.
- Neutral: compilation is not a sandbox, encryption, publisher authentication
  or native installation. Existing publisher trust and approval remain.
- Revisit shared dispatch only for witnessed eager-entry execution, incompatible
  self-exec/child semantics or unacceptable measured build cost. Do not reopen
  unrelated architecture or pre-emptively add caches, workers or infrastructure.

## References

- [Shared runtime custody](0005-shared-runtime-custody.md)
- [Single Bun runtime tier](0006-single-bun-runtime-tier.md)
- [Workspace authoring and bundled distribution](0007-workspace-authoring-bundled-distribution.md)
- [Canonical Harness Identity](0009-canonical-harness-identity.md)
- [Native qualification](../native-capability-qualification.md)
- [Bun standalone executables](https://bun.com/docs/bundler/executables).
  Current documentation explains runtime inclusion and autoload controls;
  local Bun 1.4.0 help confirms the required compile/autoload flags. Actual
  compatibility remains a process-proof obligation.
