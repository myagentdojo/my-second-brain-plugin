---
name: frontier-runner
description: "Start Frontier Runner V0 or drive one receipt-backed bounded Codex run, review, operator decision, or same-worker repair in Herdr."
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

## Review verdict

Use `review` only for an existing `completed` bounded-run receipt that has not
been cleaned or reviewed. The caller must remain in the recorded Herdr
workspace and tab. Put the bounded review instructions in one owner-private
file, then invoke exactly once:

```sh
<plugin-root>/bin/frontier-runner review \
  --run-id <id> \
  --review-prompt-file <private-path>
```

The transition starts one distinct Codex reviewer with `--sandbox read-only`,
binds its advisory verdict to a before-and-after candidate workspace digest,
and persists hashes, identities, effect classifications, and the verdict only.
Continue a timeout or uncertain prompt outcome only with `resume --run-id
<id>`; never repeat `review` or start a replacement reviewer. A workspace
mutation is a terminal review breach. `approve`, `request_changes`, `reject`,
and `cancelled` are advisory classifications and grant no authority to repair,
accept, commit, publish, or begin another unit.

## Operator decision

Use `decide` only for one proved, uncleaned run whose receipt-backed review
verdict is `approve`. Re-resolve the recognised Controller in the run's
recorded Herdr workspace, tab, and caller pane. Put Nathan's exact decision in
one owner-private file containing `accepted` or `declined` followed by one
newline, then invoke once:

```sh
<plugin-root>/bin/frontier-runner decide \
  --run-id <id> \
  --decision-file <private-path>
```

If the result is unknown, continue only with `resume --run-id <id>`; never
resubmit or replace the decision file. `accepted` records Nathan's decision
for the bound run, candidate, and verdict. It grants no repair, cleanup, Git,
publication, or next-unit authority. `declined` records the decision and stops.

## Same-worker repair

Use `repair` only for one proved, uncleaned run whose receipt-backed advisory
verdict is `request_changes`. Re-resolve the recognised Controller in the
recorded workspace, tab, and caller pane. Put Nathan's exact approved repair
instructions in one owner-private file, then invoke once:

```sh
<plugin-root>/bin/frontier-runner repair \
  --run-id <id> \
  --repair-prompt-file <private-path>
```

The transition checkpoints submission attempt 1, re-resolves the exact
recorded worker and pane, and dispatches no replacement worker or reviewer.
Continue timeout, unknown, or unproved results only with `resume --run-id
<id>`; never repeat `repair` or replace the repair prompt. If the same attempt
blocks after dispatch, use the existing exact `respond` transition after the
user approves its private response. Success requires a changed candidate and
one independently derived result marker. Stop before re-review, acceptance,
Git, publication, or another worker.

Repair is not one of Safe Ghostty's Public Controller Interface operations.
That interface cannot express or invoke it. A direct executable call outside
the recognised Herdr Controller is an External Caller and returns
`HERDR_REQUIRED` before receipt mutation.

## Smoke checks

```sh
bash <skill-directory>/scripts/frontier-runner.sh --help
<plugin-root>/bin/frontier-runner --help
```
