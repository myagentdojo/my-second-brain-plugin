# Decision View Context

This context names the shared language for presenting one already-owned human
decision without taking ownership of the decision or its consequences.

## Language

**Decision View**:
The compact human-facing presentation of one already-owned decision, including
its current state, reason, concrete question, and numbered choices.
_Avoid_: decision maker, approval gate, full technical brief

**Decision Input**:
The complete meaning a caller supplies so one Decision View can be rendered
without discovering facts or inventing a choice, reason, effect, or authority.
_Avoid_: prompt, inferred context

**Decision Result**:
The agent-facing return containing completeness, the Decision View when
complete, missing inputs when incomplete, and the Response Map.
_Avoid_: human display, executed decision

**Response Map**:
The explicit mapping from each numbered human choice to the effect its caller
already owns.
_Avoid_: action executor, implicit continuation

**Wait What Disclosure**:
Decision View's inline plain-language re-pitch when a human asks to understand
the same Decision Input before choosing.
_Avoid_: external Wait What invocation, reference lookup, invented context
