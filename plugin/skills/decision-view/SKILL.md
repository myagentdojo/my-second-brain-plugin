---
name: decision-view
description: "Validate supplied caller-owned Decision Input; return focused questions when incomplete or render a compact plain-language question and numbered choice router."
---

# Decision View

Read [`CONTEXT.md`](CONTEXT.md) before presenting a decision.

## Boundary

- Use only supplied Decision Input.
- Preserve caller ownership of decision, options, recommendation, effects, and
  authority.
- Accept the same Decision Input directly from a human.

## Decision Input

Require:

- `state`: current position;
- `question`: one concrete human question;
- `options`: one to four actionable choices; one label and effect each;
- `recommendation`: one supplied option plus reason;
- `consequence`: change caused by deciding;
- `authority`: caller authority boundary;
- `mode`: `choose` by default; `explain` after `Wait what?`.

Accept when supplied:

- `blocker`: reason plus bypass risk;
- `approval_proposal`: visible proposal plus caller-owned revision effect under
  human review.

## Incomplete Result

- Return `status: incomplete`, `missing_inputs`, and at most three currently
  answerable `focused_questions` for absent, contradictory, or non-caller-owned
  meaning.
- Return the same result when requested meaning exceeds supplied Decision Input
  or caller ownership.
- Ask one focused question when one unblocks the Decision Input.
- Render no router.

## Complete Result

Return only `status: complete`, `decision_view`, and `response_map`.

Render `decision_view` in order:

1. State. Short, complete human sentence.
2. Why the decision matters. Restate `consequence` as a short, complete human
   sentence.
3. Concrete question. Bold, complete, own line.
4. Router. Next paragraph; Markdown numbered list.

Render the router:

- Put one option in each numbered item.
- Keep the numeric marker outside bold.
- Bold the complete recommended option text.
- Use at most six numbered items: up to four supplied choices, optional
  `Revise`, then `Wait what?`.
- Keep `Wait what?` last.
- Use `Revise` only when `approval_proposal` supplies its effect.
- Use ordinary Markdown. Omit unordered bullets, code styling, and fences.

Include authority boundary when choice-relevant.
Always include supplied blocker reason plus bypass risk.

Map each supplied choice to its supplied caller-owned effect in `response_map`.
Map `Revise` only when it is rendered to the supplied revision effect. Map
`Wait what?` to the same Decision Input with `mode: explain`.

Complete only when every numbered item has exactly one `response_map` entry and
the map has no other entries.

Show a human only `decision_view`. Return the complete Decision Result to the
caller.

## Wait What Disclosure

When `mode` is `explain`:

- Add a little context.
- Re-pitch the same decision in short, plain human language.
- Use canonical vocabulary.
- Explain supplied option effects, recommendation reason, and consequence.
- Show the unchanged question and router again.
- Add no facts, choices, or authority.
- Put one focused question inside `decision_view` asking which term, option, or
  consequence remains unclear.
- Keep no interaction state.

## Return control

- Return selection, consequence, and continuation to the caller.
- Perform no selected effect.
- Grant no new authority.
