import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { compareCodeUnits, pluginPayloadInventory } from "./plugin-files"
import { loadSkillCatalog } from "./runtime-custody-config"

export type PayloadSkillExecution = "bun-backed" | "model-only"
export type PayloadSkillHookDependence = "hook-dependent" | "hook-independent"

export interface PluginPayloadSkill {
	readonly id: string
	readonly execution: PayloadSkillExecution
	readonly hookDependence: PayloadSkillHookDependence
}

export interface PayloadSkillObservation {
	readonly skills: readonly PluginPayloadSkill[]
}

export interface PluginPayloadSkills {
	readonly skills: readonly PluginPayloadSkill[]
	requireExactSkillSet(observation: PayloadSkillObservation): readonly PluginPayloadSkill[]
}

export interface PluginPayloadSkillGeneratedFile {
	readonly path: "plugin/skill-inventory.json"
	readonly contents: string
}

const skillIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const skillInventoryPath = "plugin/skill-inventory.json" as const

// Hook dependence has one owner. Current payload skills all run without hooks.
const hookDependentSkillIds: readonly string[] = []

function sameSkill(left: PluginPayloadSkill, right: PluginPayloadSkill): boolean {
	return (
		left.id === right.id &&
		left.execution === right.execution &&
		left.hookDependence === right.hookDependence
	)
}

function normalizeSkills(skills: readonly PluginPayloadSkill[], source: string): PluginPayloadSkill[] {
	const byId = new Map<string, PluginPayloadSkill>()
	for (const skill of skills) {
		if (!skillIdPattern.test(skill.id)) {
			throw new Error(`${source} skill id is invalid: ${skill.id}`)
		}
		if (
			skill.execution !== "bun-backed" &&
			skill.execution !== "model-only"
		) {
			throw new Error(`${source} skill execution is invalid for ${skill.id}`)
		}
		if (
			skill.hookDependence !== "hook-dependent" &&
			skill.hookDependence !== "hook-independent"
		) {
			throw new Error(`${source} skill hook dependence is invalid for ${skill.id}`)
		}
		if (byId.has(skill.id)) throw new Error(`${source} has duplicate logical skill id: ${skill.id}`)
		byId.set(skill.id, skill)
	}
	if (byId.size === 0) throw new Error(`${source} skill inventory must not be empty`)
	return [...byId.values()].sort((left, right) => compareCodeUnits(left.id, right.id))
}

function exactSkillMismatch(
	expected: readonly PluginPayloadSkill[],
	actual: readonly PluginPayloadSkill[],
): string | undefined {
	const expectedById = new Map(expected.map((skill) => [skill.id, skill]))
	const actualById = new Map(actual.map((skill) => [skill.id, skill]))
	const missing = expected.filter((skill) => !actualById.has(skill.id)).map((skill) => skill.id)
	const extra = actual.filter((skill) => !expectedById.has(skill.id)).map((skill) => skill.id)
	const changed = expected
		.filter((skill) => {
			const observed = actualById.get(skill.id)
			return observed !== undefined && !sameSkill(skill, observed)
		})
		.map((skill) => skill.id)
	if (missing.length === 0 && extra.length === 0 && changed.length === 0) return undefined
	return [
		missing.length > 0 ? `missing ${missing.join(", ")}` : undefined,
		extra.length > 0 ? `unexpected ${extra.join(", ")}` : undefined,
		changed.length > 0 ? `misclassified ${changed.join(", ")}` : undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join("; ")
}

function directSkillDefinitionName(path: string, source: string, id: string): string {
	const contents = readFileSync(path, "utf8")
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)
	if (!frontmatter) throw new Error(`${source} skill frontmatter is missing: ${id}`)
	const frontmatterBody = frontmatter[1]
	if (frontmatterBody === undefined) {
		throw new Error(`${source} skill frontmatter is missing: ${id}`)
	}
	const names = [...frontmatterBody.matchAll(/^name:\s*(.*)$/gm)]
	if (names.length !== 1) throw new Error(`${source} skill frontmatter must contain exactly one name: ${id}`)
	const value = names[0]?.[1]?.trim()
	if (value === undefined) {
		throw new Error(`${source} skill frontmatter must contain exactly one name: ${id}`)
	}
	const quoted = /^(?:"([a-z0-9]+(?:-[a-z0-9]+)*)"|'([a-z0-9]+(?:-[a-z0-9]+)*)')$/.exec(
		value,
	)
	const name = quoted?.[1] ?? quoted?.[2] ?? value
	if (!skillIdPattern.test(name)) {
		throw new Error(`${source} skill frontmatter name is invalid: ${id}`)
	}
	if (name !== id) {
		throw new Error(`${source} skill frontmatter name does not match directory id: ${id}`)
	}
	return name
}

function skillIdsFromInventory(
	inventory: readonly string[],
	source: string,
	pluginRoot: string,
): string[] {
	const skillSubtrees = new Map<string, { hasDirectDefinition: boolean }>()
	for (const path of inventory) {
		if (!path.startsWith("skills/")) continue
		const match = /^skills\/([^/]+)\/(.+)$/.exec(path)
		if (!match) throw new Error(`${source} skill path is invalid: ${path}`)
		const id = match[1]
		const descendant = match[2]
		if (id === undefined || descendant === undefined) {
			throw new Error(`${source} skill path is invalid: ${path}`)
		}
		if (!skillIdPattern.test(id)) throw new Error(`${source} skill id is invalid: ${id}`)
		const subtree = skillSubtrees.get(id) ?? { hasDirectDefinition: false }
		if (descendant === "SKILL.md") {
			directSkillDefinitionName(join(pluginRoot, path), source, id)
			subtree.hasDirectDefinition = true
		}
		skillSubtrees.set(id, subtree)
	}
	for (const [id, subtree] of skillSubtrees) {
		if (!subtree.hasDirectDefinition) {
			throw new Error(`${source} skill subtree lacks direct SKILL.md: ${id}`)
		}
	}
	return [...skillSubtrees.keys()].sort(compareCodeUnits)
}

/** Observe installed skill identities from every skill subtree without loading repository sources. */
export function observeInstalledPluginPayloadSkillIds(
	installedPluginRoot: string,
	installedInventory: readonly string[],
): readonly string[] {
	return skillIdsFromInventory(installedInventory, "installed plugin payload", installedPluginRoot)
}

/**
 * Load the canonical skill classification for one exact Plugin Payload candidate.
 *
 * @param pluginRepositoryRoot - Repository root containing the candidate `plugin/` payload
 * @returns Source-bound skill classification and exact observation checker
 */
export function loadPluginPayloadSkills(pluginRepositoryRoot: string): PluginPayloadSkills {
	const ids = skillIdsFromInventory(
		pluginPayloadInventory(pluginRepositoryRoot),
		"plugin payload",
		join(pluginRepositoryRoot, "plugin"),
	)
	if (ids.length === 0) throw new Error("plugin payload skill inventory must not be empty")
	if (new Set(ids).size !== ids.length) throw new Error("plugin payload has duplicate logical skill ids")

	const catalogIds = Object.keys(loadSkillCatalog(pluginRepositoryRoot).skills).sort(compareCodeUnits)
	const missingCatalogIdentities = catalogIds.filter((id) => !ids.includes(id))
	if (missingCatalogIdentities.length > 0) {
		throw new Error(`plugin payload is missing catalog skill identities: ${missingCatalogIdentities.join(", ")}`)
	}
	const extraCatalogIdentities = catalogIds.filter((id) => !skillIdPattern.test(id))
	if (extraCatalogIdentities.length > 0) {
		throw new Error(`runtime catalog has invalid skill identities: ${extraCatalogIdentities.join(", ")}`)
	}

	const normalizedHookExceptions = [...hookDependentSkillIds].sort(compareCodeUnits)
	if (new Set(normalizedHookExceptions).size !== normalizedHookExceptions.length) {
		throw new Error("plugin payload has duplicate hook-dependent skill exceptions")
	}
	const missingHookExceptions = normalizedHookExceptions.filter((id) => !ids.includes(id))
	if (missingHookExceptions.length > 0) {
		throw new Error(`plugin payload is missing hook-dependent skill exceptions: ${missingHookExceptions.join(", ")}`)
	}
	const extraHookExceptions = normalizedHookExceptions.filter((id) => !skillIdPattern.test(id))
	if (extraHookExceptions.length > 0) {
		throw new Error(`plugin payload has invalid hook-dependent skill exceptions: ${extraHookExceptions.join(", ")}`)
	}

	const skills = normalizeSkills(
		ids.map((id) => ({
			id,
			execution: catalogIds.includes(id) ? "bun-backed" : "model-only",
			hookDependence: normalizedHookExceptions.includes(id)
				? "hook-dependent"
				: "hook-independent",
		})),
		"plugin payload",
	)
	return {
		skills,
		requireExactSkillSet(observation) {
			const observed = normalizeSkills(observation.skills, "observed plugin payload")
			const mismatch = exactSkillMismatch(skills, observed)
			if (mismatch !== undefined) throw new Error(`plugin payload skill set differs: ${mismatch}`)
			return skills
		},
	}
}

function parseInstalledProjection(contents: string): readonly PluginPayloadSkill[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(contents)
	} catch {
		throw new Error("installed plugin skill inventory is not valid JSON")
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.keys(parsed).sort(compareCodeUnits).join("\0") !== "schemaVersion\0skills"
	) {
		throw new Error("installed plugin skill inventory has an invalid schema")
	}
	const projection = parsed as { schemaVersion?: unknown; skills?: unknown }
	if (projection.schemaVersion !== 1 || !Array.isArray(projection.skills)) {
		throw new Error("installed plugin skill inventory has an invalid schema")
	}
	for (const skill of projection.skills) {
		if (
			typeof skill !== "object" ||
			skill === null ||
			Array.isArray(skill) ||
			Object.keys(skill).sort(compareCodeUnits).join("\0") !==
				"execution\0hookDependence\0id"
		) {
			throw new Error("installed plugin skill inventory has an invalid skill schema")
		}
	}
	const projectedSkills = projection.skills
	const skills = normalizeSkills(projectedSkills as PluginPayloadSkill[], "installed plugin skill inventory")
	if (skills.some((skill, index) => !sameSkill(skill, projectedSkills[index] as PluginPayloadSkill))) {
		throw new Error("installed plugin skill inventory must use code-unit skill ordering")
	}
	return skills
}

/** Read the narrow installed projection without reaching back into repository sources. */
export function loadInstalledPluginPayloadSkillInventory(
	installedPluginRoot: string,
): readonly PluginPayloadSkill[] {
	const path = join(installedPluginRoot, "skill-inventory.json")
	if (!existsSync(path)) throw new Error("installed plugin skill inventory is missing")
	return parseInstalledProjection(readFileSync(path, "utf8"))
}

/** Render the minimal installed projection from the source-bound inventory. */
export function renderPluginPayloadSkillInventory(
	pluginRepositoryRoot: string,
): PluginPayloadSkillGeneratedFile {
	const skills = loadPluginPayloadSkills(pluginRepositoryRoot).skills
	return {
		path: skillInventoryPath,
		contents: `${JSON.stringify({ schemaVersion: 1, skills }, null, "\t")}\n`,
	}
}

/** Write the generated installed projection. */
export function writePluginPayloadSkillInventory(
	pluginRepositoryRoot: string,
): PluginPayloadSkillGeneratedFile {
	const file = renderPluginPayloadSkillInventory(pluginRepositoryRoot)
	writeFileSync(join(pluginRepositoryRoot, file.path), file.contents)
	return file
}

/** Return the projection path when the installed bytes drift from source classification. */
export function checkPluginPayloadSkillInventory(pluginRepositoryRoot: string): string[] {
	const file = renderPluginPayloadSkillInventory(pluginRepositoryRoot)
	const path = join(pluginRepositoryRoot, file.path)
	return !existsSync(path) || readFileSync(path, "utf8") !== file.contents ? [file.path] : []
}
