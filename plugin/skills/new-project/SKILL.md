---
name: new-project
description: "Create or update a resumable vault project packet with README, optional GOAL, and completion-only RESULT files."
---

# New Project

1. Resolve the configured Super-vault through `~/.config/context/vault.md`.
2. Read the vault root `AGENTS.md`, `README.md`, and `projects/README.md`.
3. Search existing project titles and slugs before creating a packet.
4. When a matching project has an unrelated active `GOAL.md`, preserve it and create a separate bounded project packet.
5. Choose the complete packet file set. Before changing it, use the sibling
   [vault-note-commits](../vault-note-commits/SKILL.md) workflow to begin a
   candidate. Perform the remaining packet work in the returned worktree.
6. Use `templates/project/README.md` as the required resumable front door.
7. Add `GOAL.md` only when a bounded outcome needs more acceptance detail.
8. Add `result.md` only when completion evidence exists.
9. Keep implementation truth in its code repository; link to it from the
   packet.
10. Finish through `vault-note-commits`. Its helper checks the vault and records
    the exact packet paths as one local commit.

Report the packet path, files created or updated, ownership links, and anything
left unverified.
