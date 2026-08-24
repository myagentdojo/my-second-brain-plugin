import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const skillRoot = join(root, "plugin", "skills", "orchestrate-spec")
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8")
const routing = readFileSync(join(skillRoot, "references", "codex-ticket-routing.md"), "utf8")
const normalizedSkill = skill.replaceAll(/\s+/g, " ")
const normalizedRouting = routing.replaceAll(/\s+/g, " ")

describe("orchestrate-spec wrapper contract", () => {
	test("is an explicit user-invoked skill", () => {
		expect(skill).toMatch(/^---\nname: orchestrate-spec\n/)
		expect(skill).toContain("disable-model-invocation: true")
		expect(skill).toContain("ticketed specification")
	})

	test("keeps implement-spec as a labelled hard dependency", () => {
		expect(normalizedSkill).toContain("`implement-spec`: hard dependency")
		expect(normalizedSkill).toContain("If it is missing, stop as blocked")
		expect(normalizedSkill).toContain("Treat `implement-spec` as the owner")
		expect(normalizedSkill).toContain("owns only Codex ticket assignment and fork policy")
	})

	test("uses orchestration-design only as an accepted optional handoff", () => {
		expect(normalizedSkill).toContain("`orchestration-design`: optional handoff")
		expect(normalizedSkill).toContain("Missing state: degraded")
		expect(normalizedSkill).toContain("only when the skill driver supplies or explicitly requests one")
		expect(normalizedSkill).toContain("inherited model settings")
	})

	test("routes tickets without a universal solo or concurrency default", () => {
		for (const required of ["Root task", "Internal subagent", "Codex worktree fork"]) {
			expect(routing).toContain(required)
		}
		expect(normalizedSkill).toContain("Do not assume either solo execution or maximum concurrency")
		expect(normalizedRouting).toContain("There is no universal solo lane")
		expect(normalizedRouting).toContain("root task remains the only merger and acceptance owner")
	})

	test("fails closed around user-visible forks and concurrent writers", () => {
		for (const required of [
			"user explicitly asks for it",
			"forks copy completed history only",
			"finish a root turn containing the ticket packet",
			"Never use a same-directory fork for concurrent code writers",
			"do not fake isolation",
		]) {
			expect(normalizedSkill + normalizedRouting).toContain(required)
		}
	})

	test("requires a sparse, reviewable ticket handback", () => {
		for (const required of [
			"accepted model and effort only when explicitly chosen",
			"allowed files and exclusive ownership",
			"exact verification command",
			"commit identifier",
			"Reject overlapping write ownership",
			"advance the frontier",
		]) {
			expect(normalizedRouting).toContain(required)
		}
	})

	test("has no runtime catalog, bundle, or launcher surface", () => {
		expect(existsSync(join(root, "plugin", "bin", "orchestrate-spec"))).toBe(false)
		expect(readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8")).not.toContain(
			'"orchestrate-spec"',
		)
		expect(
			readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8"),
		).not.toContain('"orchestrate-spec"')
	})
})
