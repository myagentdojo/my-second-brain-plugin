import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, expect, test } from "bun:test"

import {
	loadInstalledPluginPayloadSkillInventory,
	loadPluginPayloadSkills,
	renderPluginPayloadSkillInventory,
} from "./plugin-payload-skills"
import { proveInstalledCapabilityEvidence, runtimeClosureEvidence } from "./prove-harness-install"

const root = resolve(import.meta.dir, "..")
const temporaryRoots: string[] = []

const expectedSkills = [
	["capability-tour", "model-only", "hook-independent"],
	["dev-mode", "model-only", "hook-independent"],
	["frontier-runner", "bun-backed", "hook-independent"],
	["handoff-to-opus", "model-only", "hook-independent"],
	["hello-world", "bun-backed", "hook-independent"],
	["new-note", "model-only", "hook-independent"],
	["new-plugin", "model-only", "hook-independent"],
	["new-project", "model-only", "hook-independent"],
	["new-skill", "model-only", "hook-independent"],
	["orchestration-design", "model-only", "hook-independent"],
	["runtime-custody", "model-only", "hook-independent"],
	["skill-a", "bun-backed", "hook-independent"],
	["skill-b", "bun-backed", "hook-independent"],
	["ultragoal", "model-only", "hook-independent"],
] as const

afterEach(() => {
	for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(): string {
	const path = mkdtempSync(join(tmpdir(), "plugin-payload-skills-"))
	temporaryRoots.push(path)
	cpSync(join(root, "plugin"), join(path, "plugin"), { recursive: true })
	mkdirSync(join(path, "runtime"), { recursive: true })
	cpSync(join(root, "runtime", "runtime.lock.json"), join(path, "runtime", "runtime.lock.json"))
	cpSync(join(root, "runtime", "skill-catalog.json"), join(path, "runtime", "skill-catalog.json"))
	return path
}

test("Plugin Payload Skill Inventory classifies the complete candidate through independent expected rows", () => {
	const inventory = loadPluginPayloadSkills(root)
	expect(inventory.skills).toEqual(
		expectedSkills.map(([id, execution, hookDependence]) => ({ id, execution, hookDependence })),
	)
	inventory.requireExactSkillSet({ skills: inventory.skills })
})

test("Plugin Payload Skill Inventory compares installed projections with useful exact-set failures", () => {
	const inventory = loadPluginPayloadSkills(root)
	expect(() =>
		inventory.requireExactSkillSet({
			skills: inventory.skills.filter((skill) => skill.id !== "ultragoal"),
		}),
	).toThrow("missing ultragoal")
	expect(() =>
		inventory.requireExactSkillSet({
			skills: inventory.skills.map((skill) =>
				skill.id === "hello-world" ? { ...skill, execution: "model-only" as const } : skill,
			),
		}),
	).toThrow("misclassified hello-world")
})

test("Plugin Payload Skill Inventory rejects a malformed candidate identity and catalog drift", () => {
	const malformed = fixture()
	mkdirSync(join(malformed, "plugin", "skills", "bad_id"), { recursive: true })
	writeFileSync(join(malformed, "plugin", "skills", "bad_id", "SKILL.md"), "# bad\n")
	expect(() => loadPluginPayloadSkills(malformed)).toThrow("skill id is invalid: bad_id")

	const catalogDrift = fixture()
	const catalogPath = join(catalogDrift, "runtime", "skill-catalog.json")
	const catalog = JSON.parse(readFileSync(catalogPath, "utf8"))
	catalog.skills["absent-skill"] = catalog.skills["hello-world"]
	writeFileSync(catalogPath, `${JSON.stringify(catalog, null, "\t")}\n`)
	expect(() => loadPluginPayloadSkills(catalogDrift)).toThrow("missing catalog skill identities: absent-skill")
})

test("Plugin Payload Skill Inventory rejects an orphan skill subtree", () => {
	const orphan = fixture()
	mkdirSync(join(orphan, "plugin", "skills", "orphan-skill", "references"), { recursive: true })
	writeFileSync(join(orphan, "plugin", "skills", "orphan-skill", "references", "note.md"), "orphan\n")
	expect(() => loadPluginPayloadSkills(orphan)).toThrow(
		"skill subtree lacks direct SKILL.md: orphan-skill",
	)

	const malformedAncillary = fixture()
	mkdirSync(join(malformedAncillary, "plugin", "skills", "bad_id", "references"), {
		recursive: true,
	})
	writeFileSync(
		join(malformedAncillary, "plugin", "skills", "bad_id", "references", "note.md"),
		"malformed\n",
	)
	expect(() => loadPluginPayloadSkills(malformedAncillary)).toThrow("skill id is invalid: bad_id")
})

test("Plugin Payload Skill Inventory rejects a source definition with a mismatched frontmatter name", () => {
	const mismatch = fixture()
	const definition = join(mismatch, "plugin", "skills", "hello-world", "SKILL.md")
	writeFileSync(definition, readFileSync(definition, "utf8").replace("name: hello-world", "name: wrong-name"))
	expect(() => loadPluginPayloadSkills(mismatch)).toThrow(
		"plugin payload skill frontmatter name does not match directory id: hello-world",
	)
})

test("Plugin Payload Skill Inventory uses a minimal ordered installed projection", () => {
	const rendered = renderPluginPayloadSkillInventory(root)
	expect(JSON.parse(rendered.contents)).toEqual({
		schemaVersion: 1,
		skills: expectedSkills.map(([id, execution, hookDependence]) => ({ id, execution, hookDependence })),
	})
	expect(loadInstalledPluginPayloadSkillInventory(join(root, "plugin"))).toEqual(
		expectedSkills.map(([id, execution, hookDependence]) => ({ id, execution, hookDependence })),
	)
})

test("installed proof rejects an exact skill-set mismatch against its projection", () => {
	const temporaryRoot = fixture()
	const pluginRoot = join(temporaryRoot, "plugin")
	mkdirSync(join(pluginRoot, "skills", "unexpected-model-skill"), { recursive: true })
	writeFileSync(
		join(pluginRoot, "skills", "unexpected-model-skill", "SKILL.md"),
		"---\nname: unexpected-model-skill\n---\n",
	)
	expect(() =>
		proveInstalledCapabilityEvidence(
			pluginRoot,
			"claude",
			"a".repeat(40),
			runtimeClosureEvidence(pluginRoot).payloadHash,
		),
	).toThrow("installed portable skill inventory differs")

	const projectionPath = join(pluginRoot, "skill-inventory.json")
	const projection = JSON.parse(readFileSync(projectionPath, "utf8"))
	projection.skills[0].extra = true
	writeFileSync(projectionPath, `${JSON.stringify(projection)}\n`)
	expect(() => loadInstalledPluginPayloadSkillInventory(pluginRoot)).toThrow(
		"invalid skill schema",
	)
})

test("installed proof rejects an orphan skill subtree before projection comparison", () => {
	const temporaryRoot = fixture()
	const pluginRoot = join(temporaryRoot, "plugin")
	mkdirSync(join(pluginRoot, "skills", "orphan-skill"), { recursive: true })
	writeFileSync(join(pluginRoot, "skills", "orphan-skill", "README.md"), "orphan\n")
	expect(() =>
		proveInstalledCapabilityEvidence(
			pluginRoot,
			"claude",
			"a".repeat(40),
			runtimeClosureEvidence(pluginRoot).payloadHash,
		),
	).toThrow("installed plugin payload skill subtree lacks direct SKILL.md: orphan-skill")
})

test("installed proof rejects a mismatched direct skill frontmatter name", () => {
	const temporaryRoot = fixture()
	const pluginRoot = join(temporaryRoot, "plugin")
	const definition = join(pluginRoot, "skills", "hello-world", "SKILL.md")
	writeFileSync(definition, readFileSync(definition, "utf8").replace("name: hello-world", "name: wrong-name"))
	expect(() =>
		proveInstalledCapabilityEvidence(
			pluginRoot,
			"claude",
			"a".repeat(40),
			runtimeClosureEvidence(pluginRoot).payloadHash,
		),
	).toThrow("installed plugin payload skill frontmatter name does not match directory id: hello-world")
})
