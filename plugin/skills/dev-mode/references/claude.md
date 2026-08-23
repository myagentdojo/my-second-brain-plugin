# Claude Code Development Mode

Claude development mode is one persistent user-scoped link to this repository's
`plugin/` directory. It survives branch changes because the link names a path
and Git decides what that path holds. After a build, `/reload-plugins` loads the
change into an open Claude Code session.

## Read the state first

Run `bun run dev -- claude check --json --no-input`.

Take the first branch that matches, in this order. A failure envelope carries
no `current` object, so an unread `error.code` reads as an absent installation
and sends the next step into a command the lifecycle refuses.

1. `ok` is false: dispatch on `error.code`.
   - `DEVELOPMENT_CACHE_ORPHANED` or `DEVELOPMENT_CACHE_UNVERIFIABLE`: use
     [Orphaned or unverifiable cache](#orphaned-or-unverifiable-cache).
   - `DEVELOPMENT_MARKETPLACE_MISMATCH`: use
     [Marketplace owned elsewhere](#marketplace-owned-elsewhere).
   - `DEVELOPMENT_LINK_MISMATCH`: use
     [Installed, linked elsewhere](#installed-linked-elsewhere).
   - `DEVELOPMENT_STATE_INCOMPLETE`: run
     `bun run dev -- claude restore` to preview the owned recovery.
   - Anything else: report the code, `message`, and `nextAction`; do not guess
     a branch.
2. `current.development` is `installed` and
   `current.linkedToCanonicalPayload` is true: use
   [Installed and linked](#installed-and-linked).
3. `current.development` is `absent`: use [Absent](#absent).

## Installed and linked

Report that development mode is active. Name the checkout the link resolves to,
because a session started elsewhere still serves that path.

Source edits need a build. Model-only skill prose is already inside the payload,
so `/reload-plugins` alone loads it. Bun-backed changes need
`bun run dev:claude` first.

Read `current.freshness` before calling the session ready. A linked installation
still serves whatever bytes loaded at the last `/reload-plugins`, so linked and
current are different claims.

Only `fresh` is ready. On `stale`, `build-failed`, or `unproven`, show
`freshness.reason` verbatim as the finding and stop short of ready.

`stale` is the one status `/reload-plugins` alone resolves. `build-failed` and
`unproven` need the cause fixed first because reloading there serves known-bad
or unknown bytes.

## Installed, linked elsewhere

`DEVELOPMENT_LINK_MISMATCH` means an installation exists but its link resolves
to another checkout's payload, so that checkout owns development mode.

Run `bun run dev -- claude restore` from the linked checkout to preview its
release, or develop from that checkout instead.

## Absent

Installation mutates the user profile. Run
`bun run dev -- claude install --json --no-input` to preview it, show the user
the preview's exact `nextAction`, and get explicit approval.

The preview names only what this profile holds. A production Plugin
Installation is uninstalled with `--keep-data`. A production Marketplace is
removed. A Marketplace can stand without its Plugin Installation, so the
preview may name only the Marketplace, and with neither present it names no
replacement.

Only after approval, run `bun run dev -- claude install --apply`.

Inside a Claude Code session this fails and restores the prior state. That is
the trust boundary described below, not a defect.

## Acceptance by capability

Probe by attempting the install. A previous success and a printed command both
leave the current session's capability unproven.

**Terminal, or any session that can accept a command source**:
`install --apply` completes and reports `transactionState: "installed"`.

**Claude Code session**: `plugin install --yes` is refused because a person
must review a command source before it runs. The lifecycle restores the prior
state and reports `INSTALL_FAILED_RESTORED` with the cause.

With acceptance unavailable, present the exact command from the failure, say it
needs a terminal, and stop. Ask the user to run this skill again afterwards.
The second run reads the state and continues.

Entering development mode means a linked installation this skill has verified.
A presented command is still waiting on a person.

## Orphaned or unverifiable cache

`DEVELOPMENT_CACHE_ORPHANED` means a cache outlived its registration, usually a
worktree removed after its pull request merged. Claude no longer lists the
installation, so the profile holds files nothing reads. `check` and `install`
both refuse while it stands.

`DEVELOPMENT_CACHE_UNVERIFIABLE` means the cache could not be read, so its state
is unproven. Report the unreadable paths and let the user inspect permissions.

Removing a cache directory is a profile write outside the repository. Show the
exact path and counts, get explicit approval, then prefer a recoverable move to
Trash over permanent deletion.

## Marketplace owned elsewhere

`DEVELOPMENT_MARKETPLACE_MISMATCH` means another checkout holds the development
Marketplace name. One name exists per plugin, so worktrees compete for it.

The message names both the owning source and this checkout. Develop from the
owning checkout, or run `bun run dev -- claude restore` there to preview a
deliberate release.

## Leaving

Run `bun run dev -- claude restore --json --no-input` to preview restoration.
Show its exact `nextAction` and get explicit approval before
`bun run dev -- claude restore --apply`.

Restore before removing a checkout the installation points at. Otherwise only
the orphan path remains.
