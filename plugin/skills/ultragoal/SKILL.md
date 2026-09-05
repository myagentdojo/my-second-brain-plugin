---
name: ultragoal
description: "Work out, start, continue, or review a durable project goal from ordinary language, with explicit success checks and vault-native state."
---

# Ultragoal

Use for work that must survive several agent turns without losing the objective.
Read [the adaptation record](references/source.md) before changing this skill.

Accept ordinary intent. The human never needs to name a mode, packet file,
field, or Harness primitive.

## Opening

When invoked with no usable request beyond the skill name, compose the bundled
`decision-view` skill before doing goal work.

Resolve only the context already available from the active goal, current
working directory, and directly named or linked vault project. UltraGoal owns
and supplies the complete Decision Input:

- `state`: whether an active goal and a vault project are resolved;
- `question`: "What do you want UltraGoal to do?";
- `options`: one to four actions that are valid in the resolved state;
- `recommendation`: continue the active goal when one exists, otherwise work
  out the next goal for the resolved project, otherwise choose a project;
- `consequence`: which UltraGoal branch the selection enters;
- `authority`: selection grants only the mapped effect; activation requires an
  option that explicitly starts or continues work; and
- `mode`: `choose`.

Offer only applicable actions from: continue the active goal, work out the next
project goal, start an already-defined next goal, review a goal or project, or
choose a project. Decision View owns `Wait what?`. Show the human only its
`decision_view`; retain its `response_map` for the selected continuation.

## Intent

- **Work out**: A question such as "what's next?" or "help me work this out"
  asks for a grounded recommendation. Inspect and propose; leave the goal
  unactivated.
- **Review**: Find ambiguity, missing evidence, unsafe scope, stale state, or
  false completion. Leave the goal unactivated.
- **Start**: Treat an affirmative request to begin work, including "work on the
  next goal", as explicit activation authority.
- **Continue**: Resume the active goal. When no goal is active, continue a
  project only when its next bounded goal is already unambiguous; otherwise
  present the owned decision through Decision View.

Do not make the human restate information already available in the active goal
or project packet. Ask only for a choice that changes the objective, authority,
or scope.

## Workflow

1. Resolve the configured Super-vault through `~/.config/context/vault.md`.
2. Ground the request in the owning vault project and relevant source material.
3. Interpret the ordinary-language intent. Use the no-argument Decision View
   only when no usable request was supplied.
4. Decide whether a persistent goal adds value. Keep short work as an ordinary
   task.
5. Define one concrete objective, explicit boundaries, acceptance checks, and a
   verifier.
6. Commit each durable packet update through the sibling
   [vault-note-commits](../vault-note-commits/SKILL.md) workflow. Choose the
   complete packet file set, begin before mutation, work in the returned
   worktree, and finish after the update.
7. Keep durable state in the project packet:
   - `README.md`: current state, ownership links, and next action.
   - `GOAL.md`: optional detail for a bounded active outcome.
   - `result.md`: completion evidence only.
8. Never create a running activity log. Promote decisions, findings, and proof
   into the canonical note instead.
9. Ask for user approval before irreversible, public, shared, or costly actions,
   or when the next action crosses a safety or ownership boundary.
10. Activate only for an affirmative work request or the mapped effect of a
   start or continue selection, following
   [Activation by Harness](#activation-by-harness). Questions, reviews, and
   drafting leave the goal unactivated.
11. Omit `token_budget` unless the user explicitly supplies one.
12. Continue until the acceptance checks pass or a genuine blocker prevents the
    next safe action.
13. Mark the goal complete only after the verifier confirms the result and the
    project packet records the evidence.

## Activation by Harness

Probe for the callable tool before activating. A command's existence and a
previous run both leave the tool unproven.

**Codex** exposes goal tools, gated by `features.goals`. When `create_goal` is
present, call it with the objective. It activates the goal and the current
session works toward it. Terminal status belongs to that session, which calls
`update_goal` itself.

**Claude Code** exposes no goal tools. `/goal` is user-typed only. Activation
there emits a copyable `/goal` prompt carrying the objective, and says it needs
pasting.

With no callable tool, report activation as unavailable and name the missing
primitive. Design, critique, and continuation still run, and the project packet
still holds the goal.

Keep these mechanics out of the human's requested prose. Activation means a
tool call or a pasted prompt. An emitted prompt is still awaiting the user, and
a drafted `GOAL.md` is a document.

## Goal Packet

Before activation, make these fields unambiguous:

- **Objective**: One outcome, stated as observable change.
- **Why now**: The value of completing it.
- **In scope**: The systems, files, and people already authorized.
- **Out of scope**: Attractive work that would broaden the goal.
- **Acceptance**: Checks that distinguish done from plausible.
- **Verifier**: The command, review, or human confirmation that closes the goal.
- **Next action**: The first safe, concrete move.

## Active Goal Discipline

- Re-read the active goal and project `README.md` before each continuation.
- Prefer evidence over progress narration.
- Update durable state when the decision, boundary, or next action changes.
- Preserve unrelated work.
- Stop for user direction when completion needs new authority or a material
  change of scope.
