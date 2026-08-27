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

test("Agent Browser lifecycle source follows the repository discovery contract", () => {
	const requiredPaths = [
		"plugin/skills/agent-browser/SKILL.md",
		"plugin/skills/agent-browser/AGENTS.md",
		"plugin/skills/agent-browser/CONTEXT.md",
		"plugin/skills/agent-browser/CODING_STANDARDS.md",
		"packages/agent-browser/README.md",
		"packages/agent-browser/scripts/prove-cdp-compatibility.ts",
		"packages/agent-browser/scripts/prove-cdp-compatibility.test.ts",
		"packages/agent-browser/src/main.ts",
		"packages/agent-browser/src/modules/private-delivery/README.md",
		"packages/agent-browser/src/modules/warm-browser/README.md",
		"packages/agent-browser/src/modules/warm-browser/adapter.ts",
		"packages/agent-browser/src/modules/warm-browser/contract.ts",
		"packages/agent-browser/src/modules/warm-browser/host-effects.ts",
		"packages/agent-browser/src/modules/warm-browser/listener-table.ts",
		"packages/agent-browser/src/modules/warm-browser/ownership.ts",
		"packages/agent-browser/src/modules/warm-browser/process-table.ts",
		"packages/agent-browser/src/modules/warm-browser/production-adapter.ts",
		"packages/agent-browser/src/modules/warm-browser/state.ts",
		"packages/agent-browser/src/modules/warm-browser/warm-browser.ts",
		"packages/agent-browser/tests/fixtures/cli-refusals.ts",
		"packages/agent-browser/tests/fixtures/host-effects-preload.ts",
		"packages/agent-browser/tests/fixtures/production-cli-harness.ts",
		"packages/agent-browser/tests/fixtures/warm-browser-driver.ts",
		"packages/agent-browser/tests/warm-browser.production-launch.test.ts",
		"packages/agent-browser/tests/warm-browser.production-process-table.test.ts",
		"packages/agent-browser/tests/warm-browser.public-process.test.ts",
		"packages/agent-browser/tests/warm-browser.state.test.ts",
		"plugin/bin/warm-browser",
		"scripts/agent-browser.test.ts",
	] as const

	for (const path of requiredPaths) {
		expect(existsSync(join(root, path)), path).toBe(true)
	}

	expect(skill).toMatch(/^---\nname: agent-browser\ndescription: "[^"]+"\n---\n/)
	expect(skill).not.toContain("disable-model-invocation: true")
	expect(skill).toContain("Read [`CONTEXT.md`](CONTEXT.md) before using this skill.")
	expect(skill).toContain("Maturity: `lifecycle-slice`")
	expect(skill).toContain("<plugin-root>/bin/warm-browser")
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

test("Agent Browser has the approved lifecycle workspace and generated activation", () => {
	expect(existsSync(join(skillRoot, "CODING_STANDARDS.md"))).toBe(true)
	const repositoryPackageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
	expect(repositoryPackageJson.packageManager).toBe("bun@1.4.0")
	expect(repositoryPackageJson.scripts["prove:agent-browser-cdp"]).toBe(
		"bun packages/agent-browser/scripts/prove-cdp-compatibility.ts",
	)
	expect(repositoryPackageJson.scripts["prove:agent-browser-cdp"]).not.toContain(
		"AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED",
	)

	const packageRoot = join(root, "packages", "agent-browser")
	const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
		expect(packageJson).toEqual({
		name: "agent-browser",
		version: "0.0.0",
		private: true,
		type: "module",
		main: "src/main.ts",
		scripts: {
			"prove:cdp": "bun scripts/prove-cdp-compatibility.ts",
		},
		dependencies: {
			"playwright-core": "1.62.1",
		},
	})

	const moduleRoot = join(packageRoot, "src", "modules")
	expect(readdirSync(moduleRoot).sort()).toEqual(["private-delivery", "warm-browser"])
	const warmBrowser = readFileSync(join(moduleRoot, "warm-browser", "README.md"), "utf8")
	expect(warmBrowser).toContain("one of the two Agent Browser Modules, and the implemented one")
	expect(warmBrowser).toContain("owns the Command Vocabulary and Result Vocabulary")
	expect(warmBrowser).toContain("`start`, `status`, and `stop`")
	expect(warmBrowser).toContain("Snapshot Generation")
	expect(warmBrowser).toContain("Screenshot lifecycle")
	expect(warmBrowser).toContain("private session-owned PNG")
	expect(warmBrowser).toContain("SHA-256 metadata")
	expect(warmBrowser).toContain("refuses arbitrary output paths")
	expect(warmBrowser).toContain("production Adapter is fixed")
	expect(warmBrowser).toContain("no factory, no injected dependency")
	const privateDelivery = readFileSync(join(moduleRoot, "private-delivery", "README.md"), "utf8")
	expect(privateDelivery).toContain("the one Agent Browser Module still ahead")
	expect(privateDelivery).toContain("exact-origin unique-match and revalidation")
	expect(privateDelivery).toContain("one selected-field")
	expect(privateDelivery).toContain("disposable-child confinement")
	expect(privateDelivery).toContain("redacted non-secret results")
	expect(privateDelivery).toMatch(/no public or general\s+seam/)

	expect(existsSync(join(root, "plugin", "bin", "warm-browser"))).toBe(true)
	expect(existsSync(join(packageRoot, "src", "index.ts"))).toBe(false)
	expect(existsSync(join(packageRoot, "src", "main.ts"))).toBe(true)

	const catalog = JSON.parse(readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8"))
	expect(catalog.skills["agent-browser"]).toEqual({
		entry: "runtime/warm-browser.js",
		runtimeProfile: "bun",
		workspace: "packages/agent-browser",
		launcher: "warm-browser",
	})
	const packageText = readFileSync(join(packageRoot, "package.json"), "utf8")
	expect(packageText).not.toContain("bin")
	expect(packageText).toContain('"playwright-core": "1.62.1"')
	const packageReadme = readFileSync(join(packageRoot, "README.md"), "utf8")
	expect(packageReadme).toContain("$XDG_STATE_HOME/my-second-brain/warm-browser/")
	expect(packageReadme).toMatch(/Profile Cutover has not\s+happened/)
	expect(packageReadme).toContain(
		"AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED=1 bun run prove:agent-browser-cdp -- --run-id <ID>",
	)
})
