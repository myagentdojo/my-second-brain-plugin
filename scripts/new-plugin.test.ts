import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

const root = join(import.meta.dir, "..")
const skillRoot = join(root, "plugin", "skills", "new-plugin")
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8")
const normalized = skill.replaceAll(/\s+/g, " ")

test("new-plugin is an explicit thin bootstrap pointer", () => {
	expect(skill).toMatch(/^---\nname: new-plugin\n/)
	expect(skill).toContain("disable-model-invocation: true")
	expect(skill).toContain("explicitly invokes `$new-plugin`")
	expect(skill.split("\n").length).toBeLessThan(45)
	expect(readdirSync(skillRoot).sort()).toEqual(["SKILL.md"])
})

test("new-plugin points to the template owner and gathers bootstrap identity", () => {
	for (const required of [
		"Agent Plugin Template",
		"Create a plugin repository",
		"plugin name and display name",
		"author and repository identity",
		"destination directory or clone target",
		"selected Agent Plugin Template source",
		"template, clone or init destination",
		"identity initialization",
		"locked dependency installation",
		"generated validation",
		"dedicated New Plugin approval",
		"stop before actual bootstrap",
	]) {
		expect(normalized).toContain(required)
	}
	expect(normalized).toContain("Do not copy those mechanics")
	expect(normalized).toContain("later Plugin Creator handoff")
	expect(normalized).toContain("this stub does not call it")
})

test("new-plugin keeps preview effects and exclusions separate from formation", () => {
	for (const excluded of [
		"skill formation",
		"payload implementation",
		"runtime changes",
		"harness installation",
		"activation",
		"release",
		"cleanup",
	]) {
		expect(normalized).toContain(excluded)
	}
	expect(normalized).toContain("separate from Formation approval")
	expect(normalized).toContain("template/clone/init/validation effects only")
	expect(normalized).toContain("A proposed command, approval, or validation plan is not a created Plugin Repository")
})

test("new-plugin has no runtime or launcher surface", () => {
	expect(existsSync(join(root, "plugin", "skills", "new-plugin", "SKILL.md"))).toBe(true)
	const catalog = readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8")
	const bundles = readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8")
	expect(catalog).not.toContain('"new-plugin"')
	expect(bundles).not.toContain('"new-plugin"')
	expect(existsSync(join(root, "plugin", "bin", "new-plugin"))).toBe(false)
})
