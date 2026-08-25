import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

const root = join(import.meta.dir, "..")
const skillRoot = join(root, "plugin", "skills", "decision-view")
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8")
const glossary = readFileSync(join(skillRoot, "CONTEXT.md"), "utf8")
const guidancePath = join(skillRoot, "AGENTS.md")
const guidance = existsSync(guidancePath) ? readFileSync(guidancePath, "utf8") : ""
const contextMap = readFileSync(join(root, "CONTEXT-MAP.md"), "utf8")
const normalized = skill.replaceAll(/\s+/g, " ")

test("decision-view is a lean model-invoked presentation skill", () => {
	expect(skill).toMatch(/^---\nname: decision-view\n/)
	expect(skill).not.toContain("disable-model-invocation")
	expect(normalized).toContain(
		"Validate supplied caller-owned Decision Input; return focused questions when incomplete or render a compact plain-language question and numbered choice router",
	)
	expect(skill).toContain("Read [`CONTEXT.md`](CONTEXT.md)")
	expect(normalized).toContain("Accept the same Decision Input directly from a human")
	expect(skill.split(/\s+/).length).toBeLessThan(500)
})

test("decision-view defines one minimal input contract", () => {
	// Independent oracle: keep the required Decision Input fields test-owned.
	for (const field of [
		"`state`",
		"`question`",
		"`options`",
		"`recommendation`",
		"`consequence`",
		"`authority`",
		"`blocker`",
		"`approval_proposal`",
		"`mode`",
	]) {
		expect(skill).toContain(field)
	}
	expect(normalized).toContain("one to four actionable choices; one label and effect each")
	expect(normalized).toContain("`choose` by default; `explain`")
	expect(normalized).toContain("Use only supplied Decision Input")
	expect(normalized).toContain("visible proposal plus caller-owned revision effect")
})

test("decision-view returns only complete or incomplete results", () => {
	expect(skill).toContain("`status: complete`")
	expect(skill).toContain("`decision_view`")
	expect(skill).toContain("`response_map`")
	expect(skill).toContain("`status: incomplete`")
	expect(skill).toContain("`missing_inputs`")
	expect(skill).toContain("`focused_questions`")
	expect(normalized).toContain("at most three currently answerable `focused_questions`")
	expect(normalized).toContain("requested meaning exceeds supplied Decision Input or caller ownership")
	expect(normalized).toContain("Render no router")
	expect(normalized).toContain("Always include supplied blocker reason plus bypass risk")
	expect(normalized).toContain("Include authority boundary when choice-relevant")
})

test("decision-view renders one compact human choice", () => {
	expect(normalized).toContain("State. Short, complete human sentence")
	expect(normalized).toContain(
		"Why the decision matters. Restate `consequence` as a short, complete human sentence",
	)
	expect(normalized).toContain("Concrete question. Bold, complete, own line")
	expect(normalized).toContain("at most six numbered items")
	expect(normalized).toContain(
		"up to four supplied choices, optional `Revise`, then `Wait what?`",
	)
	expect(normalized).toContain("Bold the complete recommended option text")
	expect(normalized).toContain("Keep `Wait what?` last")
	expect(normalized).toContain(
		"Use `Revise` only when `approval_proposal` supplies its effect",
	)
	expect(normalized).toContain("Router. Next paragraph; Markdown numbered list")
	expect(normalized).toContain("Put one option in each numbered item")
	expect(normalized).toContain("Keep the numeric marker outside bold")
	expect(skill).not.toContain("separated by ` · `")
	expect(normalized).not.toContain("Markdown hard line breaks")
})

test("decision-view owns one inline Wait What re-pitch", () => {
	expect(normalized).toContain("When `mode` is `explain`:")
	expect(normalized).toContain("Add a little context")
	expect(normalized).toContain("short, plain human language")
	expect(normalized).toContain("canonical vocabulary")
	expect(normalized).toContain("Show the unchanged question and router again")
	expect(normalized).toContain("Add no facts, choices, or authority")
	expect(normalized).toContain(
		"Put one focused question inside `decision_view` asking which term, option, or consequence remains unclear",
	)
	expect(normalized).not.toContain("Return that focused question to the caller")
	expect(existsSync(join(skillRoot, "references"))).toBe(false)
})

test("decision-view returns ownership to its caller", () => {
	expect(normalized).toContain("Map each supplied choice to its supplied caller-owned effect")
	expect(normalized).toContain(
		"Map `Revise` only when it is rendered to the supplied revision effect",
	)
	expect(normalized).toContain(
		"every numbered item has exactly one `response_map` entry and the map has no other entries",
	)
	expect(normalized).toContain("Return selection, consequence, and continuation to the caller")
	expect(normalized).toContain("Perform no selected effect")
	expect(normalized).toContain("Grant no new authority")
})

test("decision-view owns one mapped glossary and no runtime surface", () => {
	// Independent oracle: keep the Decision View vocabulary test-owned.
	for (const term of [
		"Decision View",
		"Decision Input",
		"Decision Result",
		"Response Map",
		"Wait What Disclosure",
	]) {
		expect(glossary).toContain(`**${term}**`)
	}
	expect(contextMap).toContain("plugin/skills/decision-view/CONTEXT.md")
	expect(contextMap).toContain("plugin/skills/decision-view/**")
	expect(guidance).toContain("Keep the happy path one-pass and inline")
	expect(guidance).toContain("Update `scripts/decision-view.test.ts`")
	expect(existsSync(join(root, "packages", "decision-view"))).toBe(false)
	expect(existsSync(join(root, "plugin", "bin", "decision-view"))).toBe(false)
	const catalog = readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8")
	const bundles = readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8")
	expect(catalog).not.toContain('"decision-view"')
	expect(bundles).not.toContain('"decision-view"')
})
