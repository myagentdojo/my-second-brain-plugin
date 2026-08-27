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
		"packages/agent-browser/src/modules/warm-browser/bounds.ts",
		"packages/agent-browser/src/modules/warm-browser/cdp-channel.ts",
		"packages/agent-browser/src/modules/warm-browser/contract.ts",
		"packages/agent-browser/src/modules/warm-browser/controlled-page.ts",
		"packages/agent-browser/src/modules/warm-browser/credential-fields.ts",
		"packages/agent-browser/src/modules/warm-browser/host-effects.ts",
		"packages/agent-browser/src/modules/warm-browser/listener-table.ts",
		"packages/agent-browser/src/modules/warm-browser/ownership.ts",
		"packages/agent-browser/src/modules/warm-browser/process-table.ts",
		"packages/agent-browser/src/modules/warm-browser/production-adapter.ts",
		"packages/agent-browser/src/modules/warm-browser/snapshot.ts",
		"packages/agent-browser/src/modules/warm-browser/state.ts",
		"packages/agent-browser/src/modules/warm-browser/warm-browser.ts",
		"packages/agent-browser/tests/fixtures/cdp-page-fixture.ts",
		"packages/agent-browser/tests/fixtures/cli-refusals.ts",
		"packages/agent-browser/tests/fixtures/controlled-page-probe.ts",
		"packages/agent-browser/tests/fixtures/host-effects-preload.ts",
		"packages/agent-browser/tests/fixtures/independent-cdp-reader.ts",
		"packages/agent-browser/tests/fixtures/production-cli-harness.ts",
		"packages/agent-browser/tests/fixtures/warm-browser-driver.ts",
		"packages/agent-browser/tests/warm-browser.negative-controls.test.ts",
		"packages/agent-browser/tests/warm-browser.page-control.test.ts",
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
	expect(skill).toContain("Maturity: `page-control-slice`")
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
	expect(warmBrowser).toContain(
		"`start`, `status`, `open`, `snapshot`, `click`,\n`fill`, and `stop`",
	)
	expect(warmBrowser).toContain("never through a\npublic selector")
	expect(warmBrowser).toContain("refuses a credential field from the snapshot")
	expect(warmBrowser).toContain("never at the socket the endpoint\nadvertises")
	expect(warmBrowser).toMatch(/command that merely proves the page moved or was replaced/)
	expect(warmBrowser).toMatch(/login\nidentifier is classified with the password/)
	expect(warmBrowser).toContain("The name counts only where a value could be typed")
	expect(warmBrowser).toMatch(/says what the attempt already cost the page/)
	expect(warmBrowser).toMatch(/A navigation is bound to the document it asked for/)
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
	expect(packageReadme).toContain("## Controlled Page operation")
	expect(packageReadme).toContain("## Deterministic Controlled Page proof")
	expect(packageReadme).toMatch(/`e<ordinal>@<generation>`/)
	expect(packageReadme).toContain("CONTROLLED_PAGE_REPLACED")
	expect(packageReadme).toContain("`ELEMENT_NOT_ACTIONABLE`")
	expect(packageReadme).toContain("independent CDP target reader")
	expect(packageReadme).toContain("`invalidated`")
	expect(packageReadme).toMatch(
		/only one decided before the page was asked for\nanything records `unchanged`/,
	)
	expect(packageReadme).toMatch(/the name a reader would hear is asked only about a field a value/)
	expect(packageReadme).toMatch(/A navigation succeeds only on the document it asked for/)
	expect(packageReadme).toMatch(/A login identifier is a credential field on the same\s+footing/)
})

/**
 * The codes one text lists, taken from the paragraph that follows its anchor.
 *
 * The anchor must appear exactly once and the paragraph it opens must name
 * codes. A region that moved or was reworded fails here, instead of letting an
 * empty list read as agreement between two texts neither of which was read.
 */
function listedResultCodes(text: string, anchor: string, code: RegExp): readonly string[] {
	const parts = text.split(anchor)
	expect(parts.length, anchor).toBe(2)
	const codes = [...parts[1]!.split("\n\n")[0]!.matchAll(code)].map((match) => match[1]!)
	expect(codes.length, anchor).toBeGreaterThan(1)
	return codes
}

test("the published Result Vocabulary is the whole closed one Warm Browser declares", () => {
	const warmBrowserRoot = join(root, "packages", "agent-browser", "src", "modules", "warm-browser")
	// Two readings that share nothing: the union as the Module declares it, and
	// the list as the package README publishes it. Because neither is derived from
	// the other, a code added, removed, renamed, or reordered on one side is a
	// disagreement here rather than a drift the next reader discovers.
	const declared = listedResultCodes(
		readFileSync(join(warmBrowserRoot, "contract.ts"), "utf8"),
		"export type ResultCode =\n",
		/"([A-Z_]+)"/g,
	)
	const published = listedResultCodes(
		readFileSync(join(root, "packages", "agent-browser", "README.md"), "utf8"),
		"Result Vocabulary is",
		/`([A-Z_]+)`/g,
	)

	expect(published).toEqual(declared)
})
