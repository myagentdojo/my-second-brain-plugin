# Ultragoal Adaptation Record

- Upstream:
  [jxnl/personal-monorepo-template](https://github.com/jxnl/personal-monorepo-template/blob/df863768495aaf524a2bf9b5b25ef2622a2591a1/.codex/skills/ultragoal/SKILL.md)
- Upstream commit: `df863768495aaf524a2bf9b5b25ef2622a2591a1`
- Checked: 2026-08-06
- Local adaptation edited: 2026-08-25
- Local plugin version: `0.1.0`

Preserved:

- Design, critique, activation, and continuation modes.
- Explicit activation before a goal is started on any Harness.
- Objective, boundary, verifier, and completion-proof discipline.
- No inferred token budget.

Adapted:

- Use the vault project packet as durable state.
- Keep `README.md` required, `GOAL.md` optional, and `result.md`
  completion-only.
- Remove the default `WORKLOG.md`; this vault preserves durable meaning, not
  activity logs.
- Split activation by Harness. Upstream assumes the Codex `create_goal` tool is
  always callable. Claude Code exposes no goal tools, so a skill there emits a
  copyable `/goal` prompt instead. Activation reports a tool call or a pasted
  prompt, which keeps an emitted prompt distinct from an activated goal.
- Accept ordinary-language work, review, and continuation requests without
  exposing internal modes, packet fields, or Harness mechanics to the human.
- Compose the bundled Decision View for a no-argument invocation, with
  UltraGoal retaining ownership of the decision, mapped effect, and authority.
