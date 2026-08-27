import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

const root = join(import.meta.dir, "..")
const skillRoot = join(root, "plugin", "skills", "agent-browser")
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8")
const guidance = readFileSync(join(skillRoot, "AGENTS.md"), "utf8")
const glossary = readFileSync(join(skillRoot, "CONTEXT.md"), "utf8")
const standards = readFileSync(join(skillRoot, "CODING_STANDARDS.md"), "utf8")
const contextMap = readFileSync(join(root, "CONTEXT-MAP.md"), "utf8")

test("Agent Browser source scaffold follows the repository discovery contract", () => {
	const requiredPaths = [
		"plugin/skills/agent-browser/SKILL.md",
		"plugin/skills/agent-browser/AGENTS.md",
		"plugin/skills/agent-browser/CONTEXT.md",
		"plugin/skills/agent-browser/CODING_STANDARDS.md",
		"scripts/agent-browser.test.ts",
	] as const

	for (const path of requiredPaths) {
		expect(existsSync(join(root, path)), path).toBe(true)
	}

	expect(skill).toMatch(/^---\nname: agent-browser\ndescription: "[^"]+"\n---\n/)
	expect(skill).not.toContain("disable-model-invocation: true")
	expect(skill).toContain("Read [`CONTEXT.md`](CONTEXT.md) before using this skill.")
	expect(skill).toContain("Maturity: `scaffolded`")
	expect(guidance).toContain("Agent Browser Source Guidance")
	expect(glossary).toContain("**Agent Browser**")
	expect(glossary).toContain("**Warm Browser**")
	expect(glossary).toContain("**Screenshot**")
	expect(skill).toContain("`screenshot`")
	expect(standards).toContain("## One vocabulary owner")
	expect(standards).toContain("## Prove the public process")
	expect(standards).toContain("## YAGNI exclusions")
	expect(contextMap).toContain(
		"| **Agent Browser** | [`plugin/skills/agent-browser/CONTEXT.md`](./plugin/skills/agent-browser/CONTEXT.md) | None. |",
	)
})

test("Agent Browser has the approved documentation-only workspace shell", () => {
	expect(existsSync(join(skillRoot, "CODING_STANDARDS.md"))).toBe(true)

	const packageRoot = join(root, "packages", "agent-browser")
	const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
	expect(packageJson).toEqual({
		name: "agent-browser",
		version: "0.0.0",
		private: true,
		type: "module",
	})

	const moduleRoot = join(packageRoot, "src", "modules")
	expect(readdirSync(moduleRoot).sort()).toEqual(["private-delivery", "warm-browser"])
	const warmBrowser = readFileSync(join(moduleRoot, "warm-browser", "README.md"), "utf8")
	expect(warmBrowser).toContain("exactly two future Agent Browser Modules")
	expect(warmBrowser).toContain("future Command Vocabulary and Result Vocabulary")
	expect(warmBrowser).toContain("Snapshot Generation")
	expect(warmBrowser).toContain("Screenshot lifecycle")
	expect(warmBrowser).toContain("private session-owned PNG")
	expect(warmBrowser).toContain("SHA-256 metadata")
	expect(warmBrowser).toContain("refuses arbitrary output paths")
	expect(warmBrowser).toContain("production Adapter is fixed")
	const privateDelivery = readFileSync(join(moduleRoot, "private-delivery", "README.md"), "utf8")
	expect(privateDelivery).toContain("exactly two future Agent Browser Modules")
	expect(privateDelivery).toContain("exact-origin unique-match and revalidation")
	expect(privateDelivery).toContain("one selected-field")
	expect(privateDelivery).toContain("disposable-child confinement")
	expect(privateDelivery).toContain("redacted non-secret results")
	expect(privateDelivery).toMatch(/no public or general\s+seam/)

	expect(existsSync(join(root, "plugin", "bin", "warm-browser"))).toBe(false)
	expect(existsSync(join(packageRoot, "src", "index.ts"))).toBe(false)
	expect(existsSync(join(packageRoot, "src", "main.ts"))).toBe(false)

	const catalog = readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8")
	expect(catalog).not.toContain('"agent-browser"')
	const packageText = readFileSync(join(packageRoot, "package.json"), "utf8")
	expect(packageText).not.toContain("dependencies")
	expect(packageText).not.toContain("bin")
	expect(packageText).not.toContain("playwright")
})
