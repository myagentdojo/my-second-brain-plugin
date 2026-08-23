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

## Bounded run

**Bounded run**:
One caller-supplied unit executed by one named Codex worker in one granted
Herdr workspace, with Terminal Code and terminal Chromium kept visible.
_Avoid_: queue, ticket engine, automatic selection, multiple workers

**Private receipt**:
The minimal XDG state record written before external dispatch and after each
observed effect. It stores identifiers, hashes, timestamps, states, and effect
outcomes rather than prompt, transcript, browser history, or source diff.
_Avoid_: run ledger service, audit log, project memory

**Classified timeout**:
Herdr reported `timeout` or `agent_prompt_stalled` after prompt submission may
have taken effect. Resume observes the recorded worker and never resends that
prompt.
_Avoid_: retry, replay, replacement worker

**Independent result marker**:
`frontier-result:<sha256>` derived from the changed fixture bytes and observed
in worker readback. The full marker is absent from the submitted prompt.
_Avoid_: terminal idle as completion, echoed input as proof

**Owned pane**:
A Terminal Code, terminal Chromium, or Codex pane whose opaque ID came from this
run's Herdr split response and was checkpointed in its receipt.
_Avoid_: focused pane, inferred sidebar position, unrelated operator pane

## Boundary

The V0 shell launcher owns session start and pane-derived editor launch. The
bounded executable owns one validated run, private receipt, reconciliation, and
owned-pane cleanup. Herdr owns terminal execution, observed agent state, and
opaque identifiers. The user owns every human gate. Queueing, review,
acceptance, repository publication, and a second unit require another goal.
