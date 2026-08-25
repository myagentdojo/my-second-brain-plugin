# Codex Ticket Routing

This reference owns Codex assignment and fork policy for `orchestrate-spec`.
The resolved `implement-spec` skill remains the workflow owner.

## Assign each ready ticket

Choose the lane with the lowest coordination cost that preserves isolation and
evidence. There is no universal solo lane.

| Lane | Use when | Assignment |
|---|---|---|
| Root task | The ticket is tightly coupled to current edits, changes shared state, or is cheaper to complete than hand off. | Root implements and verifies it directly. |
| Internal subagent | The work is bounded inside the current task and benefits from focused exploration, review, or disjoint implementation. | Assign one role, exact scope, exclusive file ownership for writes, and a return contract. Subagents share the current filesystem. |
| Codex worktree fork | The ticket is independent, produces a user-visible durable outcome, benefits from separate steering, and the user explicitly requested a fork or new task. | Give the child an isolated worktree and make it return one reviewable commit plus evidence. |

Use an exploration subagent for bounded read-only discovery. Use a reviewer
after integration when an independent read-only pass is valuable. The root
task remains the only merger and acceptance owner.

## Fork checkpoint

Codex forks copy completed history only. Before forking the current task,
finish a root turn containing the ticket packet. On the next user-authorized
turn, create the worktree fork and send only the minimal follow-up needed to
start that ticket.

Never use a same-directory fork for concurrent code writers. If worktree forks
are unavailable, continue with a safely bounded internal subagent or root work
and report the degraded lane; do not fake isolation.

Use native task coordination to wait for progress. Do not wake or message a
child repeatedly. Leave approvals and user-input gates with the user.

## Ticket packet

Provide only information the child cannot recover from pointers:

- ticket objective and blocking relationship;
- assigned role; accepted model and effort only when explicitly chosen;
- specification and ticket pointers;
- allowed files and exclusive ownership;
- interface constraints and relevant prior commits;
- exact verification command;
- required handback: commit identifier, changed files, checks, and gaps.

Reject overlapping write ownership before dispatch. After handback, inspect
the commit and evidence, integrate in the root task, rerun the smallest covering
check, and only then advance the frontier.
