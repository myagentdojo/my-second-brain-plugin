# Agent plugin repository template

Build one Git-distributed plugin for Claude Code and Codex.

- Share skills and portable runtime behavior.
- Keep native manifests and reload behavior separate.
- Author in Bun and TypeScript.
- Execute dependency-closed bundles through one verified, plugin-managed Bun runtime.
- Publish from GitHub Releases, not npm.
- Develop through each harness's native plugin workflow.

Contributors need Git and [Bun](https://bun.sh/docs/installation). Plugin consumers need Claude Code or Codex and Git access to the repository. They do not need a user-managed Bun, Node.js, Python, npm, or setup command.

## Choose a path

| Goal | Start |
| --- | --- |
| Create a plugin repository from this template | Continue at [Create a plugin repository](#create-a-plugin-repository). |
| Extend an initialized plugin repository | Continue at [Add plugin behavior](#add-plugin-behavior). |
| Install or restore a Claude Development Installation | Continue at [Develop in both harnesses](#2-develop-in-both-harnesses). |
| Install, upgrade, replace, or roll back a release | Read [Install, upgrade, or roll back a release](docs/installing.md). |
| Open or qualify a pull request | Read [Pull requests and CI](docs/pull-requests-and-ci.md). |
| Configure GitHub release automation | Read [Configure release automation](docs/release-setup.md). |
| Qualify fresh native capabilities | Read [Qualify fresh native capabilities](docs/native-capability-qualification.md). |
| Publish a release | Read [Publish a release](docs/publishing.md). |
| Maintain, resume, or repair release state | Read [Maintain, resume, or repair release state](docs/release-repair.md). |
| Qualify publishing-system changes with public/private canaries | Read [Qualify public and private canaries](docs/canary-qualification.md). |
| Change the distribution architecture or its language | Read [`CONTEXT.md`](CONTEXT.md), then the relevant [ADR](docs/adr/). |

## Create a plugin repository

### 1. Initialize the repository

Create a repository from this GitHub template, clone it, and install the locked development dependencies:

```sh
bun install --frozen-lockfile
```

Initialize the plugin identity once:

```sh
bun run init -- \
  --name dojo-hello \
  --display-name "Dojo Hello" \
  --author "My Agent Dojo" \
  --repository https://github.com/myagentdojo/dojo-hello
```

`plugin.config.json` owns plugin metadata. Generation derives both marketplace catalogs and native manifests.

```sh
bun run generate:check
```

Initialization completes when `generate:check` passes and every generated identity surface names the new plugin.

Continue at [Add plugin behavior](#add-plugin-behavior).

## Add plugin behavior

### Source owners

- `plugin.config.json`: plugin identity, version, and canary configuration.
- `runtime/runtime.lock.json`: approved Bun version and per-platform asset identity.
- `plugin/skills/<id>/SKILL.md`: installed skill workflow.
- `runtime/src/`: shared portable command logic.
- `packages/<id>/`: dependency-bearing workspace code.
- `runtime/skill-catalog.json`: logical skill registration.
- `plugin/`: complete installed Plugin Payload for both harnesses.

Both marketplace catalogs point at `./plugin`. Development staging, Git installation, packaging, and distribution proof all start from that subtree. Repository scripts, TypeScript source, Git metadata, and development state cannot enter the installed payload.

Edit these owners and commit their generated files together. Generated manifests, launchers, bundle inventories, and `plugin/runtime/*.js` name their source; regenerate them instead of editing them directly.

### 1. Implement the behavior

Keep portable command logic under `runtime/src/`. Add dependency-bearing skills as isolated workspace members, register them in `runtime/skill-catalog.json`, then regenerate the closed bundles and launchers.

```sh
bun run build
bun run generate:check
```

The change is internally complete when the catalog, generated launchers, bundle inventory, notices, and manifests match their sources.

### 2. Develop in both harnesses

Run profile-safe preparation checks first. These commands build local output and Codex staging without changing harness settings or installed plugins:

```sh
bun run dev -- claude check --json --no-input
bun run dev -- codex check --json --no-input
```

#### Claude Code

```sh
bun run dev -- claude install
bun run dev -- claude install --apply
bun run dev:claude
```

`install` builds the Plugin Payload, generates an ignored local Marketplace that uses Claude Code's official command source with `mode: "link"`, and previews the profile transition. `--apply` captures the exact prior production or absent state, removes the production source with plugin data preserved, then installs and enables one user-scoped Development Installation linked to this checkout. It fails closed if Claude reports another scope, an unknown identity, the wrong development checkout, or production and development together.

The installation persists across ordinary Claude sessions started from unrelated directories. After `install --apply` succeeds, `bun run dev:claude` builds once and watches runtime source, skills, hooks, assets, manifests, and lock inputs. It fails closed if no enabled live-linked Development Installation exists. It does not launch Claude or change profile state. After a successful rebuild, run `/reload-plugins` in each open Claude session.

Restore the captured production enabled state and Marketplace source, a Marketplace-only state, or the exact prior absent state through the same preview gate. Restore snapshots are atomic, profile-keyed, ignored repository state and reject Marketplace sources containing inline credentials:

```sh
bun run dev -- claude restore
bun run dev -- claude restore --apply
```

Claude development completes when an ordinary reloaded session discovers and runs the changed skill from the checkout. `check`, `install`, and `restore` support `--json --no-input` for deterministic agent checks. Persistent changes still require explicit `--apply`.

#### Codex

```sh
bun run dev -- codex install --json --no-input --no-launch
bun run dev -- codex install --apply --candidate-hash <sha256> --json --no-input --no-launch
bun run dev:codex
```

Codex plugins use a staged development source rather than the canonical payload directly. Enter development mode once with `codex install`: it builds `plugin/`, copies it into ignored `.dev` staging, derives a candidate hash from the exact payload, inspects the native Marketplace and Plugin Installation, and previews the checkout ownership change. The preview returns the bound `--apply --candidate-hash <sha256>` command.

Review that first preview before running its exact apply command. Apply registers the local development Marketplace, installs the stable `<plugin-version>+codex.dev` identity, removes only the superseded same-name development selector when present, then re-inspects its enabled identity, source path, and Marketplace owner. `--no-input` implies `--no-launch`; `--no-launch` is the equivalent explicit human-facing choice. Start one fresh Codex task after this one-time identity change so its selector binds the stable path.

After that approval, `bun run dev:codex` rebuilds, stages, and replaces the bytes at the same development version and cache path. It does not ask for another approval while the exact enabled installation remains owned by this checkout. It refuses before mutation when the installation is absent, disabled, conflicting, migrated, or owned by another checkout. The Marketplace registration persists; only its staged payload and cache bytes refresh.

Production and development remain enabled together under distinct Codex identities:

- Production displays as `<Display Name>` and exposes `$<plugin-name>:<skill>`.
- Development displays as `<Display Name> Dev` and exposes `$<plugin-name>-dev:<skill>`.

The Development Installation stays distinct from the production identity and preserves the production installation. Candidate hashes still identify each staged payload for evidence, but same-checkout refresh does not turn each edit into a new ownership approval.

Codex development completes when the one fresh task discovers both identities without collisions and then runs two changed development payloads from the stable cache path without another task restart. Production-skill proof must resolve to the production cache separately.

Use the native development commands. A skills-only symlink or harness-global copy bypasses the manifests, launchers, runtime custody, cache identity, and installation boundary under test.

### 3. Prove the change

Run the local gate:

```sh
bun test
bun run generate:check
bun run release:validate
bun run prove:all
```

Local proof completes when the current worktree contains only the intended diff and `prove:all` passes. Then follow [Pull requests and CI](docs/pull-requests-and-ci.md) for PR naming, payload-impact classification, and hosted qualification.

## Architecture at a glance

```text
plugin/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── skills/<id>/SKILL.md
├── skill-inventory.json
├── bin/{frontier-runner,hello-world,skill-a,skill-b,warm-browser}
├── bin/darwin-arm64/my-second-brain
├── THIRD-PARTY-NOTICES.md
└── runtime/
    ├── runtime-exec
    ├── runtime-lock.sh
    ├── skill-catalog.sh
    ├── bundle-inventory.{json,sh}
    ├── frontier-runner-<digest>.js
    ├── hello-world.js
    └── skill-{a,b}-<digest>.js
```

The portable process seam is:

```text
skill id + arguments + invocation identity
    -> stdout + stderr + exit code
```

| Area | Shared | Claude Code | Codex |
| --- | --- | --- | --- |
| Skills | Portable Agent Skills content | `/PLUGIN:SKILL` invocation and Claude extensions | `$SKILL` invocation and Codex extensions |
| Runtime | One selected-entry compiled executable on admitted targets, generated launchers, closed migration bundles, and one custody engine | Executes the shared launcher | Executes the shared launcher |
| Manifest | Plugin identity only | Claude-native manifest | Codex-native manifest |
| Lifecycle hooks | One shared fail-open mechanics handler | Native `SessionStart`/`Stop` declaration; plugin enablement controls activation | Native `SessionStart`/`Stop` declaration; exact hook definition requires user trust |
| Development refresh | Source and payload | Persistent live link plus `/reload-plugins` | Stable staged cache plus same-checkout refresh |
| Harness-only features | Nothing by default | Keep Claude-only components native | Keep Codex-only components native |

Use [`CONTEXT.md`](CONTEXT.md) for canonical language. The architecture rationale lives in the ADRs for [one payload with native adapters](docs/adr/0001-one-payload-native-harness-adapters.md), [shared runtime custody](docs/adr/0005-shared-runtime-custody.md), [one Bun runtime](docs/adr/0006-single-bun-runtime-tier.md), and [closed workspace bundles](docs/adr/0007-workspace-authoring-bundled-distribution.md).

## Proof commands

- `bun test`: initializer, metadata, CLI, release, development, and canary contracts.
- `bun run generate:check`: generated manifests match `plugin.config.json`.
- `bun run build`: regenerate the Bun hello-world bundle, workspace bundles, notices, and inventory.
- `bun run prove:runtime-custody`: exercise missing, repair, corruption, concurrency, hostile-environment, and pass-through behavior.
- `bun run prove:runtime-platform -- --target <target>`: acquire the reviewed target asset, execute the packaged skill, and prove warm offline reuse.
- `bun run prove:harness-install -- --require-native --fixture-acknowledged`: install the tagged payload in isolated Claude and Codex homes and prove package bytes, declarations, installed bytes, and direct handler mechanics. It does not prove native activation, hook trust, UI presentation, or delegation; those need the receipts in `docs/native-capability-qualification.md`.
- `bun run prove:distribution`: build twice, compare package bytes, extract the payload, prove Bun-only closure, and verify cold read-only guidance.
- `bun run prove:dx`: replace an isolated production Claude installation with the live link, prove discovery from an unrelated directory, restore the exact production version, enabled state, Marketplace source, and retained data, then verify the Codex development boundary.
- `bun run prove:all`: complete local gate.

## Current boundaries

- macOS arm64/x64 and Linux arm64/x64 only.
- The current compiled migration admits all runtime-backed skills only on `darwin-arm64`. Do not publish it as a production replacement until every retained supported target has a matching executed artifact or is deliberately removed from the support contract.
- The locked x64 baseline assets support AVX-capable CPUs for this Bun 1.4.0 candidate. Older no-AVX x64 hosts are outside the support boundary; custody executes `bun --version` before publication and refuses an unusable binary. Development uses TypeScript 7.0.2 with the Bun type declarations pinned at 1.4.0.
- Bun is pinned by version and per-target archive/executable digests; users do not install or pin it themselves.
- Publisher-reviewed bundles and dependencies execute with the user's normal Bun and OS capabilities. This is not a sandbox or an untrusted-plugin runtime.
- The build rejects native addons, statically visible computed loaders and direct `eval`/`Function` use, undeclared assets, and runtime package installation. These are deterministic bundle-hygiene checks, not adversarial capability confinement; publisher review owns indirect or obfuscated code, and architecture-layer isolation owns untrusted code ([ADR 0006](docs/adr/0006-single-bun-runtime-tier.md)).
- Claude loads one persistent user-scoped Development Installation from the live Plugin Payload. Source edits need a successful build and `/reload-plugins` in each open session. Codex uses one approved checkout-owned development identity and refreshes the stable staged cache after each successful build.
- The capability-tour `SessionStart`/`Stop` sidecar is a fail-open lifecycle mechanics proof, not a production integrity or security guarantee. Runtime setup hooks, prewarm, doctor, inventory, and prune commands remain absent.
- Managed, workspace-installed, or non-removable plugins require administrator replacement or rollback.
- Vendor plugin specifications change. Recheck the official documentation linked from the [installation guide](docs/installing.md) and [maintainer index](docs/releasing.md) when manifests, discovery, installation, or reload behavior changes.
