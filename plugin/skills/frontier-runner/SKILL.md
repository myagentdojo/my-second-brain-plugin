---
name: frontier-runner
description: "Start Frontier Runner V0 or drive one receipt-backed bounded Codex run in Herdr."
disable-model-invocation: true
---

# Frontier Runner

Read [CONTEXT.md](CONTEXT.md), then resolve this skill directory from the
installed `SKILL.md` path.

## V0 launcher

Use V0 when the user asks only to open the named Herdr session or Terminal
Code pane. Run from the target workspace:

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

## Bounded run

Use the bounded runner only when the user supplies one unit ID, granted
workspace, bounded prompt, timeout, browser URL, and existing relative fixture
file. Keep the prompt body in a private temporary file. Resolve the plugin root
two directories above this skill, then inspect the executable contract:

```sh
<plugin-root>/bin/frontier-runner --help
```

Run exactly one `run` command from the granted Herdr workspace. Report its JSON
envelope. A `PROMPT_TIMEOUT` continues only through `resume --run-id <id>`;
`run` never repeats for the same receipt. Run `cleanup --run-id <id>` only when
the user wants the recorded panes closed.

Stop at `blocked`, `unknown`, identity conflict, unknown effect, trust,
permission, or approval state. Show the named repair path and leave the visible
decision to the user.

## Smoke checks

```sh
bash <skill-directory>/scripts/frontier-runner.sh --help
<plugin-root>/bin/frontier-runner --help
```
