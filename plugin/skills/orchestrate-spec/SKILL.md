---
name: orchestrate-spec
description: "Implement a ticketed specification through a root task, bounded subagents, and opt-in Codex worktree forks."
disable-model-invocation: true
---

# Orchestrate Spec

No specification or ticket graph supplied: ask for pointers to both. Do not
invent the graph.

## Workflow owner

`implement-spec`: hard dependency. Resolve it from the active Harness's skill
registry and read it before acting. If it is missing, stop as blocked; install
the reviewed Matt Pocock `implement-spec` skill, then invoke this skill again.

Treat `implement-spec` as the owner of specification reading, task-graph and
frontier semantics, implementation completion, review, and cleanup. This skill
owns only Codex ticket assignment and fork policy.

`orchestration-design`: optional handoff. Missing state: degraded to the
bundled routing reference and inherited model settings. Apply a staffing
recommendation only when the skill driver supplies or explicitly requests one.
Next repair: invoke `orchestration-design` and accept its recommendation before
dispatch.

Before creating a branch, PR, task, or fork, follow the nearest repository
instructions and obtain any authority the current request did not supply.

## Route the frontier

Read [Codex ticket routing](references/codex-ticket-routing.md), then assign
each ready ticket independently. Keep one root task as task-graph, integration,
verification, and acceptance owner. Do not assume either solo execution or
maximum concurrency.

Create a user-visible task or fork only when the user explicitly asks for it.
When a fork is selected for code changes, use an isolated worktree; never run
concurrent writers in a same-directory fork.

## Handback

Return the completed tickets, changed frontier, commits or diffs received,
verification evidence, unresolved gaps, and the next ready assignment. Stop at
any approval boundary required by the repository or user.
