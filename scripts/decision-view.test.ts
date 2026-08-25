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
	expect(skill).toContain("Read [`CONTEXT.md`](CONTEXT.md)")
	expect(normalized).toContain("A human may supply the same Decision Input directly")
	expect(skill.split(/\s+/).length).toBeLessThan(700)
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
	expect(normalized).toContain("one to four actionable choices")
	expect(normalized).toContain("`choose` by default and `explain`")
	expect(normalized).toContain("Use only the supplied Decision Input")
})

test("decision-view returns only complete or incomplete results", () => {
	expect(skill).toContain("`status: complete`")
	expect(skill).toContain("`decision_view`")
	expect(skill).toContain("`response_map`")
	expect(skill).toContain("`status: incomplete`")
	expect(skill).toContain("`missing_inputs`")
	expect(skill).toContain("`focused_questions`")
	expect(normalized).toContain("at most three currently answerable")
	expect(normalized).toContain("investigate, choose, or invent")
})

test("decision-view renders one compact human choice", () => {
	expect(normalized).toContain("current state, why the decision matters, the bold concrete question, then the router")
	expect(normalized).toContain("at most five numbered options")
	expect(normalized).toContain("exactly one complete recommended option in bold")
	expect(normalized).toContain("Keep `Wait what?` last")
	expect(normalized).toContain("Use `Revise` only when `approval_proposal` is supplied")
	expect(normalized).toContain("one word-wrapping line separated by ` · ` only when every option is a very short action")
	expect(normalized).toContain("For longer options, use Markdown hard line breaks to put one numbered option on each line without separators")
})

test("decision-view owns one inline Wait What re-pitch", () => {
	expect(normalized).toContain("When `mode` is `explain`")
	expect(normalized).toContain("add a little context")
	expect(normalized).toContain("short, plain human language")
	expect(normalized).toContain("canonical vocabulary")
	expect(normalized).toContain("show the unchanged question and router again")
	expect(normalized).toContain("Add no facts, choices, or authority")
	expect(existsSync(join(skillRoot, "references"))).toBe(false)
})

test("decision-view returns ownership to its caller", () => {
	expect(normalized).toContain("Map each number to its supplied caller-owned effect")
	expect(normalized).toContain("The caller owns the selection, consequence, and continuation")
	expect(normalized).toContain("Decision View performs no selected effect")
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
