---
name: new-skill
description: "Form one resumable skill from an idea or formation packet through an approved implementation frontier."
disable-model-invocation: true
---

# New Skill Formation

Read [`CONTEXT.md`](CONTEXT.md) before starting the Formation Run.

Use this skill only when the user explicitly invokes `$new-skill`. It is a
cross-harness Formation Run for one skill idea or one existing Formation
Packet. It ends at the implementation frontier; it does not implement,
activate, release, or clean up the skill.

## Ordered human checkpoints

1. Formation approval for the exact Formation Preview.
2. Shared-understanding confirmation for the resolved content.
3. Development Installation approval for the native owner's exact preview.
4. Architecture Shell approval when the Complexity Gate fires.
5. Coding Standards approval after accepted architecture and Test Design work.
6. Spec publication approval.
7. Ticket publication approval.
8. Later implementation.
9. Later activation, release, and cleanup.

No checkpoint silently authorizes a later one.

## Resume the Formation Run

1. Resolve the current vault through `~/.config/context/vault.md`, then read
   the packet `README.md` and `GOAL.md` when present. Read the target Plugin
   Repository instructions and the current native owner state before choosing
   an action.
2. Resume the existing Formation Packet when its plugin, skill unit, writer,
   and next action match. Keep the Formation Packet as the only durable
   formation record. No duplicate workflow ledger. The packet and the native
   owners remain the durable state.
3. When no idea or packet is supplied, ask for one sentence describing the
   desired skill outcome. If the outcome remains foggy, offer the user-invoked
   `$grill-me` route and pause for the user's choice.
4. Inspect the available Plugin Repositories and the packet's existing owner,
   infer the likely target, then show the recommendation and ask the user to
   select the target Plugin Repository. Do not treat an inference as selection.
5. When the selected Plugin Repository is missing, offer `$new-plugin` as a
   separate branch with a separate approval. Keep plugin creation outside this
   Formation Run.
6. After every stage boundary, route the stage result or evidence and the next
   action through New Project and UltraGoal to the Formation Packet.

Before rendering paths, perform a direct, read-only, naming-only, non-mutating
inspection of the target repository's governing glossary and current Formation
Packet. Identify the smallest settled vocabulary needed for the skill ID,
discovery test, and proposed stubs, then ask the user to settle any missing or
overloaded name. Do not invoke Domain Modeling until the exact Bare Skill Shell
exists after Formation approval. Do not approve paths built from unresolved
language. Fixed owner filenames such as `SKILL.md`, `CONTEXT.md`, `AGENTS.md`,
and `CODING_STANDARDS.md` keep their repository meaning; every domain-bearing
directory, basename, exported type, interface, and test title uses the selected
domain term.

Discovery before Formation approval is read-only. Derive the exact planned
Formation Packet path from the vault conventions, and inspect the current
branch, worktree, and writer state without creating or updating them. New
Project and UltraGoal own packet mutation after approval. WorkTree owns
worktree creation or reuse after approval. Reuse is valid only for the same
plugin, the same bounded skill unit, and no conflicting writer.

## Formation Preview and approval

Before any mutation, render one exact Formation Preview. Prefer the active
harness's native interactive visualization. If it is unavailable, show the
same information as a Markdown tree or table:

```text
selected plugin: <Plugin Repository and identity>
vault packet: <exact existing or proposed absolute Formation Packet path>
branch/worktree: <exact existing or proposed branch and absolute worktree path>
bare skill shell:
  plugin/skills/<skill-id>/SKILL.md
conditional Domain Modeling-owned context pair:
  plugin/skills/<skill-id>/CONTEXT.md
  CONTEXT-MAP.md: <exact row for plugin/skills/<skill-id>/CONTEXT.md>
  (create both only when the first distinct skill-local term resolves; omit both otherwise)
post-grill scaffold:
  plugin/skills/<skill-id>/AGENTS.md
  scripts/<skill-id>.test.ts
deferred evidence-derived path:
  plugin/skills/<skill-id>/CODING_STANDARDS.md (after architecture and Test Design)
effects: <files to create or update, packet status, and named checks>
exclusions: <runtime, package, implementation, activation, release, and cleanup exclusions>
```

Request the distinct Formation approval for this preview. A missing,
declined, or unavailable approval stops the run before mutation. This one
approval authorizes only the exact forecast path and effect mutations: packet
and worktree setup, Bare Skill Shell, the conditional Domain Modeling context
pair, and the post-grill scaffold.
Shared-understanding later accepts the resolved content. Formation approval
grants no Development Installation, Architecture Shell, Coding Standards, Spec
publication, Ticket publication, implementation, activation, release, or
cleanup approval, and it does not introduce a separate scaffold approval.

After Formation approval, route exactly the previewed packet mutation to New
Project and UltraGoal, then route exactly the previewed worktree creation or
reuse to WorkTree. If an owner returns a different path, identity, or effect,
stop and render a new Formation Preview. Formation setup completes only when
the exact packet and worktree exist under the previewed ownership.

## Bare skill shell

After Formation approval and exact packet/worktree setup, create or confirm the
selected `plugin/skills/<skill-id>/` directory and its minimal `SKILL.md`. The
file contains only valid frontmatter, the explicit invocation boundary, the
one-sentence intended outcome, and a scaffolded maturity statement. This is the
writable landing zone for the grill, not an accepted skill design.

This step completes only when the exact `SKILL.md` exists with those four Bare
Skill Shell elements and New Project and UltraGoal have routed its `scaffolded`
result and next action to the Formation Packet.

Do not create an empty `CONTEXT.md`. Domain Modeling owns lazy glossary
creation only when the first distinct skill-local term resolves. Keep `AGENTS.md`, the
repository-pattern test, and `CODING_STANDARDS.md` absent until their ordered
stages below.

## Grill and domain language

Ask the user to invoke the explicit-only `$grill-with-docs` owner for the main
interview immediately after the Bare Skill Shell exists. That owner calls
Grilling and Domain Modeling. When the first distinct skill-local term resolves,
Domain Modeling creates `plugin/skills/<skill-id>/CONTEXT.md` in the shell and
its `CONTEXT-MAP.md` row together, then updates the glossary as later terms
resolve. When no distinct skill-local vocabulary resolves, preserve both files'
absence. Keep a created glossary implementation-free and use its canonical and
`_Avoid_` terms.

Writing for Agents owns skill source and docs. Never route to skill-author;
route that work to Writing for Agents.

Close the grill only after the user gives a separate Shared-understanding
confirmation. Route that confirmation, accepted content, and next action
through New Project and UltraGoal to the Formation Packet. Treat the result as
`accepted` only when a human has settled the decision or spec; a scaffold
remains `scaffolded` until then.

## Complete the Mandatory Skill Scaffold

After Shared-understanding confirmation, complete or confirm the Mandatory
Skill Scaffold through its named owners in the target Plugin Payload:

- Writing for Agents owns the accepted-outcome `SKILL.md` and concise
  source-maintenance `AGENTS.md` prose;
- Test Design routes and owns proof for one discovery-only repository-pattern
  test at `scripts/<skill-id>.test.ts` before its creation.
- When distinct skill-local vocabulary resolved, Domain Modeling owns the
  paired `CONTEXT.md` glossary and target `CONTEXT-MAP.md` row. Model-only
  status alone does not create either artifact.

Keep `CODING_STANDARDS.md` absent during this scaffold. Its rules depend on the
settled domain, the accepted architecture decision when the Complexity Gate
fires, and Test Design evidence. Creating an empty standards placeholder would
pretend those inputs are already known.

Preserve an existing file when it belongs to the same approved skill unit;
extend it only through the current preview. Mark every scaffold artifact and
the packet claim as `scaffolded`. Scaffolded means valid shape with no
behaviour proof. It does not mean architecture, implementation, or tests are
settled.

This step completes only when the three always-required artifacts exist at their
exact paths and the Formation Packet records either the paired skill-local
`CONTEXT.md` and `CONTEXT-MAP.md` row or that no distinct skill-local vocabulary
resolved. Mark every existing artifact and row `scaffolded` through New Project
and UltraGoal in the Formation Packet. Writing for Agents owns prose and docs;
Test Design routes the discovery-only repository-pattern test and owns its proof.

Use the accepted governing glossary, including the skill-local `CONTEXT.md` when
present, for the `<skill-id>` directory and test basename. If the grill changes a
domain-bearing path, type, interface, or test name from the Formation Preview,
stop and return to that exact preview and approval before renaming or creating
another stub.

## Development Installation

After the Mandatory Skill Scaffold exists, ask the active Harness's native
development owner to inspect the exact target state. Claude routes to
`dev-mode`. Codex routes to the target Plugin Repository's documented Codex
Development Installation owner. When its identity is not current, use that
owner's documented preview and preview-bound apply route. Keep all lifecycle
mechanics with that owner.

When the exact Development Installation is already current, record the
verified identity and next action through New Project and UltraGoal to the
Formation Packet, then continue. When replacement, relinking, or reinstall is
required, show the native owner's exact preview and request the separate
Development Installation approval. Only after that approval may the native
owner apply the previewed change. A preview, command, or approval without a
verified resulting identity is still awaiting installation.

This step completes only when the active Harness reports the exact
Development Installation current. Missing or declined approval stops the
Formation Run at this checkpoint.

## Complexity Gate and architecture

Payload-only is the default. Evaluate the Complexity Gate before creating a
package shell. The gate fires when the skill needs at least one of:

- persistent state;
- filesystem writes;
- an external system;
- a CLI or subprocess contract;
- approval or recovery state;
- multiple deep modules; or
- multiple meaningful seams.

When the gate is closed, keep the skill model-only in the Plugin Payload and
keep `packages/<skill-id>/` absent. When the gate fires, record the context
owner, consumer, governed scopes, and deduplication decision before package-shell
creation. Choose one canonical glossary owner from vocabulary and consumer.
Map every governed skill and package scope in `CONTEXT-MAP.md`. Reuse the
skill-local glossary when its vocabulary also governs `packages/<skill-id>/**`.
Create a package-local glossary only when distinct resolved package-only project
vocabulary has a distinct consumer. Do not duplicate definitions or create a
pointer-only payload glossary to a non-shipping package path.

Then use Codebase Design, then ask the user to invoke the explicit-only Improve
Codebase Architecture owner. Resume from its accepted candidates to identify
the modules, interfaces, and seams. Invoke Orchestration Design dynamically when
the user asks for delegation or review, independent work units exist, the gate
fires, or a route fails or is inadequate. Keep its recommendation advisory and
inherit the active harness settings; never hardwire Luna, Terra, Sol, model
versions, or effort levels.

Before continuing, route the Complexity Gate as `closed` or `fired`, including
the triggering criteria when fired, and its next action through New Project and
UltraGoal to the Formation Packet. A resumed run must distinguish a closed gate
from one that has not been evaluated.

Render the exact Architecture Shell before creating it. Name every module,
interface, seam, path, and stub. Include a Domain Structure Map that pairs each
domain-bearing folder, file, exported type, interface, and test title with its
exact accepted `CONTEXT.md` term. Reject generic buckets such as `utils`,
`helpers`, `services`, `manager`, or `core` unless the glossary defines that
word as a domain concept. Request a separate Architecture Shell approval. Only
after that approval may the package shell be created. Use CLI Author only when
a real CLI or process contract exists. Test Design always owns test routing
and proof. Route the closed-gate disposition or accepted Architecture Shell
result and next action through New Project and UltraGoal to the Formation
Packet.

## Testing, conventions, and review

Read the repository-wide coding standards and selected package precedents.
Route test decisions and proof through Test Design, then resume from its report
or brief. Keep source and docs ownership with Writing for Agents and vocabulary
with Domain Modeling. The repository-pattern test proves discovery and source
contracts; it does not claim native discovery, installation, activation, or
cross-harness qualification.

Before specification, review every scaffold surface against its owner:

- `SKILL.md` and `AGENTS.md`: Writing for Agents and the target Plugin
  Repository instructions.
- A mapped `CONTEXT.md` and context-map row, when present: Domain Modeling and
  the settled grill language.
- file structure and Architecture Shell: Codebase Design and the accepted
  Improve Codebase Architecture result when the Complexity Gate fired.
- repository-pattern and later proof tests: Test Design.
- a real CLI or process interface: CLI Author; for an agent-facing CLI, ask
  the user to invoke the explicit-only Agent Reliability Guardrails quality
  gate, then resume from its review.

Use Orchestration Design for this review when the surfaces form independent
review units. Resolve every finding, then route its accepted disposition and
next action through New Project and UltraGoal to the Formation Packet before
continuing.

## Evidence-derived coding standards

Only after the recorded Complexity Gate result, any required Improve Codebase
Architecture result is accepted, and Test Design has returned its report or
brief, prepare the selected skill's `CODING_STANDARDS.md`. Point to the target
repository's global standards instead of restating them. Admit a
package-specific idiom only when witnessed target-package evidence or a
reviewed relevant-package precedent supports it. Architecture and test choices
select the evidence to inspect; they do not become witnessed idioms merely
because they were proposed. Leave tooling-enforced rules and unproved
candidates out. When no package-specific idiom survives, propose a concise
pointer-only document.

Render an exact Coding Standards Preview containing the absolute target path,
global-standards pointer, proposed package-specific rules with their evidence,
excluded candidates, and file effects. Request a separate Coding Standards
approval. Only after that approval may Writing for Agents create the file.
Route the accepted Coding Standards result and next action through New Project
and UltraGoal to the Formation Packet; call an individual rule `verified` only
when its named check has passed. If later evidence changes a rule, return
through a new Coding Standards Preview before editing it.

## Publish the frontier and stop

Render a Spec Publication Handoff only after all prerequisites are current:
the current Formation Packet; all three always-required Mandatory Skill Scaffold
artifacts; the paired skill-local `CONTEXT.md` and `CONTEXT-MAP.md` row when the
packet records distinct vocabulary; the verified active Development
Installation; Shared-understanding; the recorded Complexity Gate result;
applicable accepted architecture and Test Design decisions; and accepted Coding
Standards. Name the exact Formation Packet, configured tracker, `to-spec` owner, declared
parent-publication effect, and the exclusion of tickets and implementation.
Use the `to-spec` owner's documented publication contract; do not copy or
emulate its internal mechanics. Request Spec publication approval for that
exact invocation.

Only after Spec publication approval, ask the user to invoke the explicit-only
`to-spec` owner with the Formation Packet, then resume from its published
parent. Ask the user to invoke the explicit-only `to-tickets` owner with that
parent. Treat its numbered proposal and user approval as the Ticket publication
checkpoint; publish only the approved graph, then resume again. Route both
publication results, the implementation frontier, and the next action through
New Project and UltraGoal to the Formation Packet.

Completion requires the current packet; all three always-required scaffold
artifacts; the paired skill-local `CONTEXT.md` and `CONTEXT-MAP.md` row when the
packet records distinct vocabulary; the exact active Harness Development
Installation verified current; confirmed Shared-understanding; the recorded
`closed` or `fired` Complexity Gate result and its triggers when fired; accepted applicable
architecture and Test Design decisions; accepted evidence-derived coding
standards; the approved published `to-spec` parent; the approved published
`to-tickets` graph; and a packet link to the implementation frontier. Stop
there. A publication or frontier record is not implementation authority.

Stop before implementation.
