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

**Agent startup timeout**:
Herdr owns its `agent start` interactive-readiness timeout. The bounded run
timeout is passed only to prompt and wait operations, where a classified
timeout enters receipt-backed reconciliation.
_Avoid_: passing the caller's run timeout to `agent start`, treating startup
failure as a resumable prompt effect

**Pre-launch busy rejection**:
Herdr's structured `agent_pane_busy` reply for a just-split pane, returned
before any agent spawns. Each agent start retries the same name and pane on
one fixed bounded cadence, then fails closed as one classified rejected
effect.
_Avoid_: replacement worker or reviewer, unbounded retry, classifying the
bounded rejection as an unknown effect

**Independent result marker**:
`frontier-result:<sha256>` derived from the changed fixture bytes and observed
in worker readback. The full marker is absent from the submitted prompt.
_Avoid_: terminal idle as completion, echoed input as proof

**Owned pane**:
A Terminal Code, terminal Chromium, worker, or reviewer pane whose opaque ID
came from this run's Herdr split response and was checkpointed in its receipt.
_Avoid_: focused pane, inferred sidebar position, unrelated operator pane

**Review verdict**:
One independently generated advisory classification from one fresh, distinct
Codex reviewer started with a read-only sandbox after the bounded run is proved.
It is bound to an unchanged candidate workspace digest and is resumed through
the same recorded identity without prompt replay or replacement.
_Avoid_: acceptance, repair instruction, second opinion, implementation gate

**Operator decision**:
One `accepted` or `declined` classification supplied by Nathan through an
owner-private file after one receipt-backed `approve` verdict. It is bound to
the run, candidate, verdict, reviewer, recognised Controller, and first
submission attempt.
_Avoid_: repair authority, repository acceptance, publication, cleanup, retry

**Same-worker repair**:
One Nathan-approved owner-private prompt dispatched to the exact worker and
pane recorded by one unchanged `request_changes` review. One checkpoint owns
the attempt; resume reconciles it without prompt replay or replacement. A
changed candidate plus one independently derived result marker proves success.
_Avoid_: reviewer transcript as instructions, repair loop, replacement worker,
re-review, acceptance

**Safe Ghostty boundary**:
Safe Ghostty's Public Controller Interface exposes no Frontier Runner Owner
Workflow operation. It cannot request repair. A direct repair process outside
the recognised Herdr Controller is an External Caller and is refused before
receipt mutation.
_Avoid_: public repair alias, Ghostty typing, raw pane input, inherited owner
authority

## Boundary

The V0 shell launcher owns session start and pane-derived editor launch. The
bounded executable owns one validated run, one optional read-only review, one
state-bound Operator decision or same-worker repair, private receipt,
reconciliation, and owned-pane cleanup. Herdr owns terminal execution,
observed agent state, and opaque identifiers. The user owns every human gate.
Queueing, replacement workers, re-review, repository acceptance, publication,
and a second unit require another goal.
