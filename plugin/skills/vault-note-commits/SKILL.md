---
name: vault-note-commits
description: "Commit a finished vault note, new vault project, project goal change, or project completion without disturbing concurrent local work."
---

# Vault Note Commits

Resolve the configured vault through `~/.config/context/vault.md`. Resolve the
installed plugin root two directories above this `SKILL.md`, then inspect the
helper contract with `<plugin-root>/bin/vault-note-commits --help`.

## Begin

After choosing the complete intended file set, run `begin --json` with the
canonical vault root and one repeated `--path` per repository-relative file.
Use the returned worktree for every read and write in the update. Keep the
canonical checkout unchanged.

## Finish

Inspect the candidate diff and choose one concise commit subject describing the
durable meaning. Run `finish --json` with the returned worktree and subject.
Report the result. Local integration completes the vault write; remote sync is
a separate workflow.

On refusal, preserve the returned worktree and follow its `nextAction`. Resolve
semantic overlap with Nathan. The helper owns path fencing, the vault checker,
the exact-path commit, canonical-state validation, fast-forward integration,
and successful cleanup.
