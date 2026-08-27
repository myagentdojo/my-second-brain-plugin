import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { expect, test } from "bun:test"

import {
	chromeLaunchArguments,
	fixtureAcknowledgementVariable,
	parseProofOptions,
	realChromeFixtureAcknowledged,
} from "./prove-cdp-compatibility"

const packageRoot = resolve(import.meta.dir, "..")
const repositoryRoot = resolve(packageRoot, "../..")
const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

function fixtureChromeProcesses(): string[] {
	const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
	if (result.status !== 0) throw new Error("independent process reader failed")
	return result.stdout
		.split("\n")
		.filter((line) => line.includes("--user-data-dir=") && line.includes("agent-browser-cdp-"))
		.sort()
}

test("compatibility proof requires an explicit run identity and acknowledged failure fixture", () => {
	expect(() => parseProofOptions([])).toThrow("--run-id is required")
	expect(() =>
		parseProofOptions(["--run-id", "failure-cleanup", "--fixture-close-before-connect"]),
	).toThrow("--fixture-acknowledged is required")
	expect(
		parseProofOptions([
			"--run-id",
			"failure-cleanup",
			"--fixture-close-before-connect",
			"--fixture-acknowledged",
		]),
	).toEqual({ runId: "failure-cleanup", fixtureCloseBeforeConnect: true })
})

test("agent-browser owns one exact no-browser Playwright dependency", () => {
	const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
	expect(packageJson.dependencies).toEqual({ "playwright-core": "1.62.1" })
	expect(packageJson).not.toHaveProperty("devDependencies.playwright")
	const lockfile = readFileSync(resolve(repositoryRoot, "bun.lock"), "utf8")
	expect(lockfile).toContain('"playwright-core": "1.62.1"')
	expect(lockfile).toContain('"playwright-core": ["playwright-core@1.62.1"')
	expect(existsSync(resolve(repositoryRoot, "node_modules/playwright-core/.local-browsers"))).toBe(false)
})

test("Chrome launch contract isolates password storage from the macOS login keychain", () => {
	const arguments_ = chromeLaunchArguments("/private/agent-browser-fixture/profile")
	expect(arguments_.filter((argument) => argument === "--password-store=basic")).toHaveLength(1)
	expect(arguments_.filter((argument) => argument === "--use-mock-keychain")).toHaveLength(1)
	expect(arguments_).toContain("--user-data-dir=/private/agent-browser-fixture/profile")
})

test.each([
	[undefined, false],
	["", false],
	["0", false],
	["true", false],
	["01", false],
	[" 1", false],
	["1 ", false],
	["1", true],
] as const)("real Chrome fixture acknowledgment %p admits=%p", (value, expected) => {
	const environment = value === undefined ? {} : { [fixtureAcknowledgementVariable]: value }
	expect(realChromeFixtureAcknowledged(environment)).toBe(expected)
})

const realChromeTest =
	realChromeFixtureAcknowledged() &&
	process.platform === "darwin" &&
	process.arch === "arm64" &&
	existsSync(chromeExecutable)
		? test
		: test.skip

realChromeTest(
	"close-before-connect returns one redacted typed failure and removes the real Chrome process [requires AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED=1 and installed stable Chrome on macOS arm64]",
	() => {
		const processesBefore = new Set(fixtureChromeProcesses())
		const proof = spawnSync(
			process.execPath,
			[
				"run",
				resolve(import.meta.dir, "prove-cdp-compatibility.ts"),
				"--run-id",
				"failure-cleanup",
				"--fixture-close-before-connect",
				"--fixture-acknowledged",
			],
			{ encoding: "utf8", timeout: 30_000 },
		)
		expect(proof.status).toBe(1)
		expect(proof.stdout).toBe("")
		expect(proof.stderr.trim().split("\n")).toHaveLength(1)
		expect(JSON.parse(proof.stderr)).toEqual({
			schemaVersion: 1,
			ok: false,
			category: "agent-browser-cdp-compatibility",
			runId: "failure-cleanup",
			code: "CDP_CONNECT_FAILED",
			message:
				"playwright-core could not attach to the independently verified explicit CDP endpoint",
			retrySafe: true,
			nextAction:
				"Confirm the installed Chrome and playwright-core compatibility identities, then retry.",
			cleanup: { browserProcessExited: true, fixtureRemoved: true },
		})
		expect(proof.stderr).not.toContain("DevToolsActivePort")
		expect(proof.stderr).not.toContain("/var/folders/")
		expect(proof.stderr).not.toContain("ws://")
		expect(fixtureChromeProcesses().filter((line) => !processesBefore.has(line))).toEqual([])
	},
	30_000,
)
