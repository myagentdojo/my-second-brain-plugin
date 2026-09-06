# Codex Development Mode

Codex loads a cached Plugin Payload. Enter development mode once for one
checkout. Then rebuild and refresh the same stable development cache while
editing.

## Inspect first

Run `bun run dev -- codex check --json --no-input` from the selected checkout.
Verify that the candidate source path belongs to that checkout and retain the
planned Plugin and Marketplace identity. The check may build and stage the
candidate; it does not change Codex profile state.

## Enter development mode

Preview the exact transition without changing Codex profile state:

```sh
bun run dev -- codex install --json --no-input --no-launch
```

Show the candidate identity, candidate hash, operation plan, and exact apply
command. Get one explicit approval bound to that candidate hash.

After approval, substitute the previewed hash and run the exact bound command:

```sh
bun run dev -- codex install --apply --candidate-hash <sha256> --json --no-input --no-launch
```

Do not launch a nested Codex TUI from an agent-managed terminal. Nested launch
introduces a separate hook-trust decision and does not reload the task that
invoked this skill.

Treat a failure after `codex plugin add` as ambiguous. Inspect the planned
Plugin Installation before any retry.

On success, report the installed plugin ID, stable development version, cache
path, and owning checkout. After the first approved install, ask the user to
start one fresh Codex task so its selector binds the stable path.

Hook trust remains a user decision. Never select `Trust all and continue` on
the user's behalf.

## Refresh edits

After the approved install, run:

```sh
bun run dev -- codex refresh --json --no-input
```

Do not ask for another approval while the exact enabled Development
Installation remains owned by the selected checkout. Refresh rebuilds and
stages the Plugin Payload, replaces the bytes at the stable development version
and path, then re-inspects native identity.

If refresh reports an absent, disabled, conflicting, migrated, or differently
owned identity, stop before mutation. Return to the install preview and ask for
approval of that new ownership boundary.

## Verify

Invoke the smallest read-only skill path in the current task after each
refresh. A staged directory, cache entry, or install receipt does not prove
native execution. Do not ask for another task restart while the selector keeps
the same stable path.

## Leaving

Inspect the exact installed development identity with
`codex plugin list --marketplace <marketplace> --json`.

Removal is destructive profile state. Show the exact
`codex plugin remove <plugin>@<marketplace> --json` command and get explicit
approval before running it. Install a production plugin only through its normal
installation workflow; do not infer that removal authorizes replacement.
