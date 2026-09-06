# Compile the Portable Runtime during development builds

## Status

Accepted by Nathan on 6 September 2026, including the focused Test Design and
the stable Codex development identity amendment.
Use one plugin executable per target for the declared compiled skill set.
This scoped amendment preserves the remaining contracts of ADRs 0005, 0006
and 0007. Nathan confirmed the native Codex development loop usable on
6 September 2026, then approved widening every runtime-backed skill to the
qualified `darwin-arm64` executable.

## Context and problem

The existing generated skill launcher selects a catalog identity through
`runtime-exec run <skill> -- <args>`. ADR 0005 owns verification and execution;
ADR 0006 requires a separately acquired Bun executable; ADR 0007 distributes
dependency-closed JavaScript bundles. The contributor build already admits
dependencies and records bundle identities.

The product direction now requires the runtime inside the Plugin Payload and
observable edit/build/refresh/use cycles. Downloaded-runtime construction no
longer satisfies that direction, even though users already avoid manual setup.
The first selected caller was the existing `skill-a`, whose ESM and CommonJS
dependency result can be exercised offline. Its native development loop is now
proved. The current migration includes Agent Browser, Frontier Runner, Hello
World, Skill A and Skill B on `darwin-arm64`; each retains its own process
Interface behind one selected-entry executable.

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
8. Use one stable `<plugin-version>+codex.dev` version and cache path for Codex
   development. Keep the candidate hash as the exact staged payload identity.
   The first install or checkout ownership change uses preview and
   candidate-bound apply. After that approval, `codex refresh` may replace the
   cached bytes without another approval only while the exact enabled
   Development Installation remains owned by the same checkout. A missing,
   disabled, conflicting, migrated or differently owned identity refuses and
   returns to the install preview. Register the development Marketplace once;
   rebuild and stage its payload on each refresh. Keep production immutable and
   separately identified. Start one fresh Codex task after that one-time
   identity transition so its selector binds the stable path. Do not require a
   fresh task after each later refresh. Add no watcher, daemon, lease,
   Marketplace protocol or manual version bump.

### Migration state

The first slice declared only `skill-a` compiled on `darwin-arm64`. After its
native development loop passed and Nathan confirmed usability, Nathan approved
the second slice: declare every runtime-backed skill compiled on that same
target. Unqualified targets refuse compiled skills instead of silently taking
the old downloaded-runtime path.

Agent Browser keeps Private Delivery inside its existing Module. Its source
bundle re-enters through the Bun interpreter; its compiled process re-enters
the same plugin executable with the private Agent Browser selector. The public
Command Vocabulary does not gain a child command.

The implementation changes catalog declarations, build and inventory
projections, runtime execution and focused proofs. It does not delete unrelated
custody behaviour, change release pins, finish Issue #62 or claim cross-platform
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

### Full-plugin `darwin-arm64` Test Design

**Behaviour:** Every runtime-backed skill in the catalog runs through one
compiled plugin executable. Agent Browser keeps its source and compiled private
re-entry shapes distinct and can run a synthetic sanitizer child through the
compiled dispatcher.

**Seam and proof layer:** Real catalog, generator, build, extracted Plugin
Payload, generated launchers and public processes. A private pure check supports
the Agent Browser re-entry shape; the compiled sanitizer process is the primary
child-dispatch evidence.

**Independent result:** Literal skill identities, help and JSON output, stdout,
stderr and exit status, plus a test-owned synthetic credential-wrapper reply.

**How it goes RED:** Omit one compiled catalog declaration, remove the shared
executable, or restore interpreter-style arguments for a compiled Private
Delivery child. The focused proof must fail, then pass after restoration.

**Focused command:** `bun test ./scripts/compiled-plugin.test.ts` through Agent
Runner. Require four tests, zero skips and zero failures.

**Still unproved:** Real browser login, live Claude and Codex discovery for all
skills, non-macOS targets, signing, production release automation, install,
update and rollback remain separate gates.

### Native acceptance

After local proof, separately preview and approve the first Development
Installation effect. Start one fresh task to bind the stable development path.
In that task, run two real edit/build/refresh/invoke cycles without another
approval or task restart. Verify the stable development version and path plus
both changed results, and record elapsed time plus Nathan's required actions.
Nathan confirms usability before widening. Preserve the distinction between
local mechanics and native evidence. The selected skill needs no hook trust
change.

Observed on `darwin-arm64`: the one-time transition from a hash-version identity
required one Codex Desktop restart to bind the stable path. Two later real
source edits each compiled, refreshed, and ran through that same path without
another approval or task restart. Refreshes took 0.81 and 1.13 seconds. Both
compiled invocations exited zero with empty stderr and no external Bun visible.
Nathan approved widening. The private receipt SHA-256 is
`7bdd351669d33d0f7cbbd34d6ffc93c2552660098bedfce2c2e9676a841af0bb`.

## Consequences and revisit triggers

- Positive: the selected installed path is self-contained; the existing skill
  Interface and development command remain familiar.
- Positive: one checkout approval covers repeated local refreshes without
  weakening checkout ownership or production identity checks.
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
