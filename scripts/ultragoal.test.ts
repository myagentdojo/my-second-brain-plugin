import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

const root = join(import.meta.dir, "..")
const skillRoot = join(root, "plugin", "skills", "ultragoal")
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8")
const source = readFileSync(join(skillRoot, "references", "source.md"), "utf8")
const normalized = skill.replaceAll(/\s+/g, " ")

test("ultragoal accepts ordinary project-goal intent", () => {
	expect(skill).toMatch(/^---\nname: ultragoal\n/)
	expect(normalized).toContain("The human never needs to name a mode, packet file, field, or Harness primitive")
	expect(normalized).toContain('including "work on the next goal", as explicit activation authority')
	expect(normalized).toContain("When no goal is active, continue a project only when its next bounded goal is already unambiguous")
	expect(normalized).toContain("Do not make the human restate information already available")
})

test("ultragoal opens a no-argument invocation through decision-view", () => {
	expect(normalized).toContain("When invoked with no usable request beyond the skill name, compose the bundled `decision-view` skill")
	for (const field of ["`state`", "`question`", "`options`", "`recommendation`", "`consequence`", "`authority`", "`mode`"]) {
		expect(skill).toContain(field)
	}
	expect(normalized).toContain('`question`: "What do you want UltraGoal to do?"')
	expect(normalized).toContain("continue the active goal when one exists")
	expect(normalized).toContain("otherwise work out the next goal for the resolved project")
	expect(normalized).toContain("Decision View owns `Wait what?`")
	expect(normalized).toContain("Show the human only its `decision_view`")
})

test("ultragoal preserves explicit activation and packet proof", () => {
	expect(normalized).toContain("Questions, reviews, and drafting leave the goal unactivated")
	expect(normalized).toContain("Omit `token_budget` unless the user explicitly supplies one")
	expect(normalized).toContain("Mark the goal complete only after the verifier confirms the result")
	expect(normalized).toContain("Keep these mechanics out of the human's requested prose")
})

test("ultragoal provenance records the decision-view composition", () => {
	expect(source).toContain("Local adaptation edited: 2026-08-25")
	expect(source).toContain("Compose the bundled Decision View for a no-argument invocation")
})
