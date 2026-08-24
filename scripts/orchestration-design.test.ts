import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const skill = readFileSync(
	join(root, "plugin", "skills", "orchestration-design", "SKILL.md"),
	"utf8",
)
const normalized = skill.replaceAll(/\s+/g, " ")

describe("orchestration-design recommendation contract", () => {
	test("publishes one narrow model-invoked recommendation trigger", () => {
		expect(skill).toMatch(/^---\nname: orchestration-design\n/)
		expect(skill).toContain("Recommend which agents should handle a proposed workflow")
		expect(skill).not.toContain("disable-model-invocation")
	})

	test("is a tiny Sol Advisor pointer", () => {
		expect(skill.split("\n").length).toBeLessThan(20)
		expect(skill.match(/\$sol-advisor:orchestration/g)).toHaveLength(1)
		expect(skill).not.toContain("references/")
	})

	test("returns a compact, inspectable agent recommendation", () => {
		for (const required of [
			"root agent",
			"worker agents only when needed",
			"optional reviewer",
			"model and effort",
			"why each agent is needed",
			"execution order",
			"unavailable",
		]) {
			expect(normalized).toContain(required)
		}
	})

	test("is advice only and owns no workflow mutation", () => {
		expect(normalized).toContain("Advice only")
		for (const forbidden of [
			"startup pointer",
			"domain owner",
			"domain-owned workflow",
			"explicit approval",
			"edit only",
			"application boundary",
		]) {
			expect(normalized).not.toContain(forbidden)
		}
		expect(normalized).toContain("Do not inspect or edit files, launch agents, or execute the workflow")
	})

	test("has no runtime catalog, bundle, or launcher surface", () => {
		expect(existsSync(join(root, "plugin", "bin", "orchestration-design"))).toBe(false)
		expect(readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8")).not.toContain(
			'"orchestration-design"',
		)
		expect(readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8")).not.toContain(
			'"orchestration-design"',
		)
	})
})
