---
name: orchestration-design
description: "Recommend which agents should handle a proposed workflow, using Sol Advisor to choose the smallest effective team."
---

# Orchestration Design

No workflow supplied: ask for it.

Resolve `sol-advisor:orchestration` through the active Harness: Claude Code
uses `/sol-advisor:orchestration`; Codex uses `$sol-advisor:orchestration`.
Use it to recommend the smallest effective agent lineup for the proposed
workflow.

Return one compact recommendation: the root agent; worker agents only when
needed; an optional reviewer; each selected agent's model and effort; why each
agent is needed; the execution order; and the fallback when an agent is
unavailable.

Advice only. Do not inspect or edit files, launch agents, or execute the workflow.
