---
name: dev-mode
description: "Enter, verify, refresh, or leave plugin development mode for the current Claude Code or Codex Harness."
---

# Development Mode

Route from the current Harness identity before running a lifecycle command.

- Codex session: read [Codex](references/codex.md).
- Claude Code session: read [Claude Code](references/claude.md).
- Unknown Harness: ask which Harness owns the requested development session;
  make no profile change.

Use session identity, not installed commands, environment binaries, or the
requested plugin's cache path. Run another Harness's lifecycle only when the
user names that Harness explicitly.

Each branch develops the complete Plugin Payload from the selected checkout's
`plugin/` directory. A cache, staged copy, or printed install command is not
proof that the current session loaded those bytes.
