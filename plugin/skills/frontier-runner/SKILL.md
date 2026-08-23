---
name: frontier-runner
description: "Start the bare-bones Frontier Runner V0 in Herdr and Terminal Code."
disable-model-invocation: true
---

# Frontier Runner V0

Read [CONTEXT.md](CONTEXT.md), then resolve this skill directory from the
installed `SKILL.md` path.

On explicit invocation, run from the target workspace:

```sh
bash <skill-directory>/scripts/frontier-runner.sh "$PWD"
```

Pass another workspace path only when the user names it and the invocation is
outside Herdr. Outside Herdr, the launcher starts or attaches the named V0
session in Ghostty. Inside a managed Herdr pane, it resolves the calling pane's
`foreground_cwd` through Herdr, creates a right-hand pane with that canonical
directory, and starts Terminal Code there. A missing pane directory,
conflicting path, or unavailable `tode` command fails closed.

Report the launcher's output. Stop at any agent trust, permission, or approval
screen and leave that decision to the user.

Smoke check:

```sh
bash <skill-directory>/scripts/frontier-runner.sh --help
```
