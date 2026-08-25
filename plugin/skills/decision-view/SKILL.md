---
name: decision-view
description: "Present an already-owned human decision as a compact plain-language question and numbered router for another skill, agent, or user."
---

# Decision View

Read [`CONTEXT.md`](CONTEXT.md) before presenting a decision.

Use only the supplied Decision Input. The caller owns the decision, options,
recommendation, effects, and authority. A human may supply the same Decision
Input directly.

## Decision Input

Require:

- `state`: where the decision has got to;
- `question`: one concrete human question;
- `options`: one to four actionable choices, each with a label and effect;
- `recommendation`: one supplied option and the reason it is recommended;
- `consequence`: what deciding changes;
- `authority`: where the caller's existing authority stops; and
- `mode`: `choose` by default and `explain` after `Wait what?` is selected.

Accept `blocker` with its reason and bypass risk when one exists. Accept
`approval_proposal` only when the human is reviewing a visible proposal.

Return `status: incomplete`, `missing_inputs`, and at most three currently
answerable `focused_questions` when required meaning is absent, contradictory,
or not caller-owned. Use the same result when asked to investigate, choose, or
invent. Ask fewer questions when one can unblock the Decision Input. Do not
render a router from incomplete meaning.

## Complete result

Return only `status: complete`, `decision_view`, and `response_map`.

Render `decision_view` in this order: current state, why the decision matters,
the bold concrete question, then the router. Keep the first two parts short;
include the consequence and authority when they affect the choice. A supplied
blocker includes both its reason and bypass risk.

Put the bold question on its own line and the router in the next paragraph. Use
one word-wrapping line separated by ` · ` only when every option is a very short
action such as `Approve`, `Review`, or `Wait`. For longer options, use Markdown
hard line breaks to put one numbered option on each line without separators.
Use at most five numbered options, exactly one complete recommended option in
bold, and ordinary Markdown for the rest. Keep `Wait what?` last. Use `Revise`
only when `approval_proposal` is supplied. Use no bullets, code styling, or
fenced block for the router.

Map each number to its supplied caller-owned effect in `response_map`. Map
`Wait what?` to the same Decision Input with `mode: explain`. Show a human only
`decision_view`; return the complete Decision Result to its caller.

## Wait What Disclosure

When `mode` is `explain`, add a little context and re-pitch the same decision in
short, plain human language. Use the canonical vocabulary. Explain the supplied
option effects, recommendation reason, and consequence, then show the unchanged
question and router again. Add no facts, choices, or authority.

If the human still does not understand, ask which term, option, or consequence
is unclear and return that focused question to the caller. Keep no interaction
state.

## Return control

The caller owns the selection, consequence, and continuation within its
existing authority. Decision View performs no selected effect and grants no new
authority.
