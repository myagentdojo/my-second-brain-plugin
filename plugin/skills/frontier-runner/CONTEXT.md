# Frontier Runner Context

## V0

**Frontier Runner V0**:
A launcher that starts one named Herdr session, then opens Terminal Code in a
second Herdr pane on the managed pane's canonical working directory.
_Avoid_: autonomous orchestrator, ticket engine, durable run ledger

**Canonical workspace path**:
The absolute directory used by the Herdr root pane and Terminal Code pane.
_Avoid_: inferred repository, hidden worktree, terminal label

**Herdr session**:
The persistent terminal container named `frontier-runner-v0`.
_Avoid_: acceptance authority, ticket state, Ghostty-native split

**Pane-derived editor launch**:
Creating a Herdr pane with the canonical workspace path, then running `tode .`
inside that pane.
_Avoid_: separately inferred editor mapping, copied workspace label

**Human gate**:
An agent trust, permission, or approval screen that only the user decides.
_Avoid_: automatic confirmation, inferred consent, terminal status as success

## Boundary

The shell launcher owns only session start and pane-derived editor launch.
Herdr owns terminal execution, observation, and the canonical pane working
directory. A later controller may own worker dispatch, durable state, and
reconciliation after those contracts are specified.
