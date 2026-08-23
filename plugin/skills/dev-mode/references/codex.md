# Codex Development Mode

Codex loads a cached Plugin Payload. Development refresh means build, stage,
reinstall, then start a fresh task. It is not a live link, and the current task
cannot reload changed plugin bytes.

## Inspect first

Run `bun run dev -- codex --dry-run --json` from the selected checkout. Verify
that `source` names that checkout and retain the planned plugin and Marketplace
identity.

Use `bun run dev -- codex --check` when the request authorizes repository build
and staging only. It does not change Codex profile state.

## Install or refresh

Installation mutates Codex profile state. Show the dry-run plan and get explicit
approval before dispatch.

After approval, run `bun run dev -- codex --no-launch`. Do not launch a nested
Codex TUI from an agent-managed terminal. Nested launch introduces a separate
hook-trust decision and does not reload the task that invoked this skill.

Treat a failure after `codex plugin add` as ambiguous. Inspect
`codex plugin list --marketplace <marketplace> --json` for the planned plugin
identity before any retry.

On success, report the installed plugin ID, staged version, and cache path from
the command result. Then ask the user to start a fresh Codex task in the
selected checkout.

Hook trust is a user decision in that fresh task. Do not select `Trust all and
continue` on the user's behalf.

## Verify

In the fresh task, verify that the changed skill appears under the plugin
namespace and invoke the smallest read-only path that proves the new behavior.

A staged directory, cache entry, install receipt, or skill visible in the old
task does not prove fresh-task discovery.

## Leaving

Inspect the exact installed development identity with
`codex plugin list --marketplace <marketplace> --json`.

Removal is destructive profile state. Show the exact
`codex plugin remove <plugin>@<marketplace> --json` command and get explicit
approval before running it. Install a production plugin only through its normal
installation workflow; do not infer that removal authorizes replacement.
