import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

const root = join(import.meta.dir, "..")
const skillRoot = join(root, "plugin", "skills", "new-skill")
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8")
const glossary = readFileSync(join(skillRoot, "CONTEXT.md"), "utf8")
const guidance = readFileSync(join(skillRoot, "AGENTS.md"), "utf8")
const standards = readFileSync(join(skillRoot, "CODING_STANDARDS.md"), "utf8")
const contextMap = readFileSync(join(root, "CONTEXT-MAP.md"), "utf8")
const domainGuide = readFileSync(join(root, "docs", "agents", "domain.md"), "utf8")
const skillNormalized = skill.replaceAll(/\s+/g, " ")
const contextMapNormalized = contextMap.replaceAll(/\s+/g, " ")
const domainGuideNormalized = domainGuide.replaceAll(/\s+/g, " ")

test("new-skill is an explicit cross-harness formation manager", () => {
	expect(skill).toMatch(/^---\nname: new-skill\n/)
	expect(skill).toContain("disable-model-invocation: true")
	expect(skill).toContain("Read [`CONTEXT.md`](CONTEXT.md) before starting the Formation Run.")
	expect(skill).toContain("cross-harness Formation Run")
	expect(skill).toContain("explicitly invokes `$new-skill`")
	expect(skill).toContain("ends at the implementation frontier")
})

test("new-skill creates a bare shell before the conditional context pair and scaffold", () => {
	const sourceEntries = new Set(readdirSync(skillRoot))
	for (const entry of ["AGENTS.md", "CODING_STANDARDS.md", "CONTEXT.md", "SKILL.md"]) {
		expect(sourceEntries.has(entry)).toBe(true)
	}
	for (const path of [
		"plugin/skills/<skill-id>/SKILL.md",
		"plugin/skills/<skill-id>/CONTEXT.md",
		"plugin/skills/<skill-id>/AGENTS.md",
		"scripts/<skill-id>.test.ts",
	]) {
		expect(skill).toContain(path)
	}
	expect(skill).toContain("deferred evidence-derived path:")
	expect(skill).toContain(
		"plugin/skills/<skill-id>/CODING_STANDARDS.md (after architecture and Test Design)",
	)
	expect(skill).toContain("bare skill shell:")
	expect(skill).toContain("conditional Domain Modeling-owned context pair:")
	expect(skill).toContain("CONTEXT-MAP.md: <exact row for plugin/skills/<skill-id>/CONTEXT.md>")
	expect(skill).toContain("create both only when the first distinct skill-local term resolves")
	expect(skill).toContain("omit both otherwise")
	expect(skill).toContain("post-grill scaffold:")
	const bareShell = skill.slice(
		skill.indexOf("## Bare skill shell"),
		skill.indexOf("## Grill and domain language"),
	)
	expect(bareShell).toContain("minimal `SKILL.md`")
	expect(bareShell).toContain("Do not create an empty `CONTEXT.md`")
	expect(bareShell).not.toContain("Create an empty `CONTEXT.md`")
	expect(bareShell).toContain("This step completes only when the exact `SKILL.md` exists")
	expect(bareShell).toContain("Keep `AGENTS.md`, the")
	const scaffold = skill.slice(
		skill.indexOf("## Complete the Mandatory Skill Scaffold"),
		skill.indexOf("## Development Installation"),
	)
	const scaffoldNormalized = scaffold.replaceAll(/\s+/g, " ")
	expect(scaffold).not.toContain("- `CODING_STANDARDS.md`")
	expect(scaffold).toContain("Keep `CODING_STANDARDS.md` absent during this scaffold")
	expect(scaffold).toContain("three always-required artifacts exist at their")
	expect(scaffoldNormalized).toContain("either the paired skill-local `CONTEXT.md` and `CONTEXT-MAP.md` row or that no distinct skill-local vocabulary resolved")
	expect(scaffoldNormalized).toContain("Writing for Agents owns the accepted-outcome `SKILL.md`")
	expect(scaffoldNormalized).toContain("Domain Modeling owns the paired `CONTEXT.md` glossary")
	expect(scaffoldNormalized).toContain("Test Design routes and owns proof")
	expect(scaffoldNormalized).toContain("before its creation")
	expect(scaffoldNormalized).toContain("Model-only status alone does not create either artifact")
	const stages = [
		"## Resume the Formation Run",
		"## Formation Preview and approval",
		"## Bare skill shell",
		"## Grill and domain language",
		"## Complete the Mandatory Skill Scaffold",
		"## Development Installation",
		"## Complexity Gate and architecture",
		"## Testing, conventions, and review",
		"## Evidence-derived coding standards",
		"## Publish the frontier and stop",
		"Stop before implementation",
	]
	let previous = -1
	for (const stage of stages) {
		const position = skill.indexOf(stage)
		expect(position, `${stage} must be present`).toBeGreaterThan(previous)
		previous = position
	}
	expect(skill).toContain("scaffolded")
	expect(skillNormalized).toContain("no behaviour proof")
	expect(skillNormalized).toContain("direct, read-only, naming-only, non-mutating inspection")
	expect(skillNormalized).toContain(
		"Do not invoke Domain Modeling until the exact Bare Skill Shell exists after Formation approval",
	)
	expect(skillNormalized).toContain("Do not approve paths built from unresolved language")
	expect(skill).toContain("Use the accepted governing glossary, including the skill-local `CONTEXT.md` when")
	expect(skill).toContain("interview immediately after the Bare Skill Shell exists")
	expect(skillNormalized).toContain("That owner calls Grilling and Domain Modeling")
	expect(skill).toContain("When the first distinct skill-local term resolves")
	expect(skillNormalized).toContain("updates the glossary as later terms resolve")
	expect(skillNormalized).toContain("When no distinct skill-local vocabulary resolves, preserve both files' absence")
})

test("new-skill keeps discovery read-only until one exact Formation approval", () => {
	expect(skillNormalized).toContain("Discovery before Formation approval is read-only")
	expect(skillNormalized).toContain("exact existing or proposed absolute Formation Packet path")
	expect(skillNormalized).toContain("exact existing or proposed branch and absolute worktree path")
	expect(skillNormalized).not.toContain("approved packet owner route")

	const approval = skillNormalized.indexOf("After Formation approval")
	expect(approval).toBeGreaterThan(-1)
	for (const mutation of [
		"packet mutation to New Project and UltraGoal",
		"worktree creation or reuse to WorkTree",
	]) {
		expect(skillNormalized.indexOf(mutation)).toBeGreaterThan(approval)
	}
	expect(skillNormalized).toContain("stop and render a new Formation Preview")
})

test("new-skill keeps the gate, architecture, and owner routing explicit", () => {
	for (const term of [
		"persistent state",
		"filesystem writes",
		"an external system",
		"a CLI or subprocess contract",
		"approval or recovery state",
		"multiple deep modules",
		"multiple meaningful seams",
		"Codebase Design",
		"Improve Codebase Architecture",
		"Architecture Shell",
		"CLI Author",
		"Test Design",
		"Writing for Agents",
		"Domain Modeling",
	]) {
		expect(skillNormalized).toContain(term)
	}
	expect(skill).toContain("explicit-only `$grill-with-docs` owner")
	expect(skillNormalized).toContain("That owner calls Grilling and Domain Modeling")
	expect(skillNormalized).toContain("offer the user-invoked `$grill-me` route")
	expect(skillNormalized).toContain("show the recommendation and ask the user to select")
	expect(skillNormalized).toContain("Do not treat an inference as selection")
	expect(skill).toContain("Payload-only is the default")
	expect(skill).toContain("packages/<skill-id>/` absent")
	expect(skill).toContain("never hardwire Luna, Terra, Sol")
	expect(skill).toContain("Orchestration Design dynamically")
	expect(skillNormalized).toContain("user asks for delegation or review")
	expect(skillNormalized).toContain("ask the user to invoke the explicit-only Improve Codebase Architecture")
	expect(skillNormalized).toContain("Include a Domain Structure Map")
	expect(skillNormalized).toContain("exact accepted `CONTEXT.md` term")
	for (const rejectedBucket of ["`utils`", "`helpers`", "`services`", "`manager`", "`core`"]) {
		expect(skill).toContain(rejectedBucket)
	}
	expect(skillNormalized).toContain("unless the glossary defines that word as a domain concept")
	expect(skillNormalized).toContain("Before continuing, route the Complexity Gate as `closed` or `fired`")
	expect(skillNormalized).toContain(
		"record the context owner, consumer, governed scopes, and deduplication decision before package-shell creation",
	)
	expect(skillNormalized).toContain("Choose one canonical glossary owner from vocabulary and consumer")
	expect(skillNormalized).toContain(
		"Reuse the skill-local glossary when its vocabulary also governs `packages/<skill-id>/**`",
	)
	expect(skillNormalized).toContain(
		"Create a package-local glossary only when distinct resolved package-only project vocabulary has a distinct consumer",
	)
	expect(skillNormalized).toContain(
		"Do not duplicate definitions or create a pointer-only payload glossary to a non-shipping package path",
	)
	expect(skill).toContain("Only after the recorded Complexity Gate result")
	expect(skillNormalized).toContain("Test Design has returned its report or brief")
	expect(skillNormalized).toContain("reviewed relevant-package precedent supports it")
	expect(skillNormalized).toContain("they do not become witnessed idioms merely because they were proposed")
	expect(skillNormalized).toContain("When no package-specific idiom survives")
})

test("new-skill names distinct checkpoints and native development ownership", () => {
	const checkpoints = [
		"Formation approval",
		"Shared-understanding confirmation",
		"Development Installation approval",
		"Architecture Shell approval",
		"Coding Standards approval",
		"Spec publication approval",
		"Ticket publication approval",
		"Later implementation",
		"Later activation, release, and cleanup",
	]
	let previous = -1
	for (const checkpoint of checkpoints) {
		const position = skill.indexOf(checkpoint)
		expect(position, `${checkpoint} must be ordered`).toBeGreaterThan(previous)
		previous = position
	}
	expect(skill).toContain("approval authorizes only the exact forecast path and effect mutations")
	expect(skill).toContain("it does not introduce a separate scaffold approval")
	expect(skill).toContain("Shared-understanding later accepts the resolved content")
	expect(skillNormalized).toContain("Claude routes to `dev-mode`")
	expect(skillNormalized).toContain("documented Codex Development Installation owner")
	expect(skillNormalized).toContain("owner's documented preview and preview-bound apply route")
	expect(skillNormalized).toContain("native owner's exact preview")
	expect(skillNormalized).toContain("Only after that approval may the native owner apply")
	expect(skillNormalized).toContain("exact Development Installation current")
	expect(skillNormalized).toContain("exact active Harness Development Installation verified current")
	expect(skillNormalized).toContain("No duplicate workflow ledger")
	expect(skillNormalized).toContain("ask the user to invoke the explicit-only `to-spec` owner")
	expect(skillNormalized).toContain("Ask the user to invoke the explicit-only `to-tickets` owner")
	expect(skillNormalized).toContain("Spec Publication Handoff")
	expect(skillNormalized).toContain("Use the `to-spec` owner's documented publication contract")
	expect(skillNormalized).toContain("do not copy or emulate its internal mechanics")
	expect(skillNormalized).toContain("numbered proposal and user approval as the Ticket publication checkpoint")
	const publication = skill.slice(skill.indexOf("## Publish the frontier and stop"))
	const publicationNormalized = publication.replaceAll(/\s+/g, " ")
	for (const prerequisite of [
		"current Formation Packet",
		"all three always-required Mandatory Skill Scaffold artifacts",
		"paired skill-local `CONTEXT.md` and `CONTEXT-MAP.md` row when the packet records distinct vocabulary",
		"verified active Development Installation",
		"Shared-understanding",
		"recorded Complexity Gate result",
		"applicable accepted architecture and Test Design decisions",
		"accepted Coding Standards",
	]) {
		expect(publicationNormalized).toContain(prerequisite)
	}
})

test("new-skill audits every scaffold surface through its owning discipline", () => {
	for (const required of [
		"`SKILL.md` and `AGENTS.md`",
		"A mapped `CONTEXT.md` and context-map row, when present: Domain Modeling",
		"file structure and Architecture Shell",
		"repository-pattern and later proof tests",
		"a real CLI or process interface",
		"ask the user to invoke the explicit-only Agent Reliability Guardrails quality gate",
		"independent review units",
	]) {
		expect(skillNormalized).toContain(required)
	}
	expect(skillNormalized).not.toContain("`SKILL.md`, `AGENTS.md`, and `CODING_STANDARDS.md`")
	expect(skillNormalized).toContain("Render an exact Coding Standards Preview")
	expect(skillNormalized).toContain("Only after that approval may Writing for Agents create the file")
})

test("new-skill maps real formation vocabulary without making every model-only skill a context", () => {
	expect(contextMap).toContain("**New Skill Formation**")
	expect(contextMap).toContain("plugin/skills/new-skill/CONTEXT.md")
	expect(contextMap).toContain("plugin/skills/new-skill/**")
	expect(contextMap).toContain("**Frontier Runner**")
	expect(contextMap).toContain("plugin/skills/frontier-runner/CONTEXT.md")
	expect(contextMap).toContain("plugin/skills/frontier-runner/**")
	expect(contextMap).toContain("packages/frontier-runner/**")
	expect(contextMap).not.toContain("packages/skill-a/CONTEXT.md")
	expect(contextMap).not.toContain("packages/skill-b/CONTEXT.md")
	expect(contextMapNormalized).toContain("One canonical glossary governs shared vocabulary by default")
	expect(contextMapNormalized).toContain("owner and consumer")
	expect(domainGuide).toContain("mapped skill-local vocabulary context")
	expect(domainGuide).toContain("Plugin Payload root; not one context")
	expect(domainGuideNormalized).toContain("vocabulary ownership and consumers, not adjacency or execution architecture")
	expect(domainGuideNormalized).toContain("One skill-local glossary may govern both skill and package paths")
	expect(domainGuideNormalized).toContain("distinct resolved package-scoped project vocabulary with a distinct consumer")
	expect(domainGuideNormalized).toContain("`CONTEXT.md` never owns implementation details or workflow steps")
})

test("new-skill keeps glossary and source guidance free of settled-work claims", () => {
	for (const term of [
		"Formation Run",
		"Formation Packet",
		"Formation Preview",
		"Domain Naming Pass",
		"Bare Skill Shell",
		"Mandatory Skill Scaffold",
		"Complexity Gate",
		"Architecture Shell",
		"Domain Structure Map",
		"Coding Standards Preview",
		"Scaffolded",
		"Accepted",
		"Verified",
	]) {
		expect(glossary).toContain(`**${term}**`)
	}
	expect(glossary).not.toContain("**Development Installation**")
	expect(readFileSync(join(root, "CONTEXT.md"), "utf8")).toContain(
		"**Development Installation**",
	)
	expect(guidance).toContain("source-facing")
	expect(guidance).toContain("first distinct skill-local term resolves")
	expect(standards).toContain("This skill has no witnessed package-specific idiom to add.")
	expect(standards).not.toContain("/Users/nathanvale")
	expect(skillNormalized).toContain("Never route to skill-author")
})

test("new-skill source and payload surfaces stay model-only", () => {
	for (const path of [
		"plugin/skills/new-skill/SKILL.md",
		"plugin/skills/new-skill/CONTEXT.md",
		"plugin/skills/new-skill/AGENTS.md",
		"plugin/skills/new-skill/CODING_STANDARDS.md",
		"scripts/new-skill.test.ts",
	]) {
		expect(existsSync(join(root, path))).toBe(true)
	}
	const catalog = readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8")
	const bundles = readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8")
	expect(catalog).not.toContain('"new-skill"')
	expect(bundles).not.toContain('"new-skill"')
	expect(existsSync(join(root, "plugin", "bin", "new-skill"))).toBe(false)
})
