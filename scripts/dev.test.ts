import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { claudeWatchSources } from "./dev"
import { payloadInventorySha256, pluginPayloadInventory } from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const pluginConfig = loadPluginConfig(root)
const pluginName = pluginConfig.name
const pluginVersion = pluginConfig.version
const productionId = `${pluginName}@${pluginName}`
const developmentMarketplaceName = `${pluginName}-dev`
const developmentId = `${pluginName}@${developmentMarketplaceName}`

interface FakePlugin {
	id: string
	version: string
	scope: string
	enabled: boolean
	installPath: string
}

interface FakeMarketplace {
	name: string
	source: "directory" | "git" | "github" | "url"
	path?: string
	repo?: string
	url?: string
	ref?: string
	installLocation?: string
}

interface FakeState {
	plugins: FakePlugin[]
	marketplaces: FakeMarketplace[]
	commands: string[][]
	failCommands?: string[]
	failAfterCommands?: string[]
	installVersions?: Record<string, string>
}

function run(arguments_: string[], environment = process.env, repositoryRoot = root) {
	return Bun.spawnSync({
		cmd: [process.execPath, "scripts/dev.ts", ...arguments_],
		cwd: repositoryRoot,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	})
}

const isolatedRepositoryExcludedEntries = new Set([".dev", ".git"])

function isolatedRepository(prefix: string): string {
	const repositoryRoot = mkdtempSync(join(tmpdir(), prefix))
	cpSync(root, repositoryRoot, {
		recursive: true,
		filter: (source) =>
			source === root || !isolatedRepositoryExcludedEntries.has(basename(source)),
	})
	return realpathSync(repositoryRoot)
}

/**
 * Every `dev.ts` invocation here spawns the CLI, and the lifecycle rebuilds the
 * payload before it inspects anything, so one measures ~940ms. The cases that
 * carry several run at 2.5s to 4.2s against Bun's 5s default. The 4.2s case has
 * timed out in isolation, and the margin on the rest does not survive a loaded
 * runner. The budget is stated where the cost is spent, so adding an invocation
 * visibly spends it.
 */
const lifecycleSuiteTimeoutMs = 30_000

function writeExecutable(path: string, contents: string): void {
	writeFileSync(path, contents)
	chmodSync(path, 0o755)
}

function fakeProfile(
	options: {
		production?: boolean
		productionMarketplaceOnly?: boolean
		productionEnabled?: boolean
		plugins?: FakePlugin[]
		marketplaces?: FakeMarketplace[]
		failCommands?: string[]
		failAfterCommands?: string[]
		failBuildAfter?: number
	} = {},
) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "claude-development-test-"))
	const profileRoot = join(temporaryRoot, "claude")
	const binaryRoot = join(temporaryRoot, "bin")
	const statePath = join(temporaryRoot, "state.json")
	const buildCountPath = join(temporaryRoot, "build-count")
	const productionMarketplaceRoot = join(temporaryRoot, "production-marketplace")
	mkdirSync(join(productionMarketplaceRoot, ".claude-plugin"), {
		recursive: true,
	})
	writeFileSync(
		join(productionMarketplaceRoot, ".claude-plugin", "marketplace.json"),
		`${JSON.stringify({
			name: pluginName,
			plugins: [
				{
					name: pluginName,
					source: join(root, "plugin"),
				},
			],
		})}\n`,
	)
	mkdirSync(binaryRoot, { recursive: true })
	writeExecutable(
		join(binaryRoot, "claude"),
		`#!/bin/sh\nexec '${process.execPath}' '${join(root, "scripts", "fixtures", "fake-claude.ts")}' "$@"\n`,
	)
	writeExecutable(
		join(binaryRoot, "bun"),
		`#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
	count=0
	if [ -f '${buildCountPath}' ]; then count=$(cat '${buildCountPath}'); fi
	count=$((count + 1))
	printf '%s\n' "$count" > '${buildCountPath}'
	if [ "$count" -gt '${options.failBuildAfter ?? 1_000_000}' ]; then
		printf '%s\n' 'injected build failure' >&2
		exit 70
	fi
	exit 0
fi
exec '${process.execPath}' "$@"
`,
	)
	const production = options.production ?? false
	const productionMarketplace = production || (options.productionMarketplaceOnly ?? false)
	const state: FakeState = {
		plugins:
			options.plugins ??
			(production
				? [
						{
							id: productionId,
							version: pluginVersion,
							scope: "user",
							enabled: options.productionEnabled ?? true,
							installPath: join(temporaryRoot, "production-install"),
						},
					]
				: []),
		marketplaces:
			options.marketplaces ??
			(productionMarketplace
				? [
						{
							name: pluginName,
							source: "directory",
							path: productionMarketplaceRoot,
							installLocation: productionMarketplaceRoot,
						},
					]
				: []),
		commands: [],
		failCommands: options.failCommands,
		failAfterCommands: options.failAfterCommands,
	}
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
	const environment = {
		...process.env,
		HOME: join(temporaryRoot, "home"),
		CLAUDE_CONFIG_DIR: profileRoot,
		FAKE_CLAUDE_STATE: statePath,
		PATH: `${binaryRoot}:${process.env.PATH ?? ""}`,
	}
	const profileKey = createHash("sha256").update(resolve(profileRoot)).digest("hex").slice(0, 16)
	const snapshotPath = join(root, ".dev", "claude", "restore-state", `${profileKey}.json`)
	return {
		temporaryRoot,
		profileRoot,
		productionMarketplaceRoot,
		environment,
		snapshotPath,
		readBuildCount: () =>
			existsSync(buildCountPath) ? Number(readFileSync(buildCountPath, "utf8").trim()) : 0,
		readState: () => JSON.parse(readFileSync(statePath, "utf8")) as FakeState,
		writeState: (nextState: FakeState) =>
			writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`),
		cleanup: () => {
			rmSync(temporaryRoot, { recursive: true, force: true })
			rmSync(snapshotPath, { force: true })
		},
	}
}

function jsonOutput(result: ReturnType<typeof run>): any {
	return JSON.parse(result.stdout.toString())
}

async function waitFor(
	condition: () => boolean,
	description: string,
	timeoutMilliseconds = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
		await Bun.sleep(25)
	}
}

test("Claude development help exposes persistent lifecycle actions", () => {
	const result = run(["claude", "--help"])

	expect(result.exitCode).toBe(0)
	const output = result.stdout.toString()
	for (const action of ["check", "install", "restore", "watch"]) {
		expect(output).toContain(action)
	}
	expect(output).not.toContain("--plugin-dir")
})

test("invalid Claude lifecycle usage exits with the input-error status", () => {
	const result = run(["claude", "check", "--apply"])

	expect(result.exitCode).toBe(2)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toContain("--apply is supported only")
})

test("Claude check has one non-interactive JSON process contract", () => {
	const profile = fakeProfile()
	try {
		const result = run(["claude", "check", "--json", "--no-input"], profile.environment)

		expect(result.exitCode).toBe(0)
		expect(result.stderr.toString()).toBe("")
		const output = JSON.parse(result.stdout.toString())
		expect(output).toMatchObject({
			schemaVersion: 1,
			contractId: "plugin.development-installation",
			ok: true,
			harness: "claude",
			operation: "check",
			mode: "inspect",
			changed: false,
			retrySafety: "safe",
		})
		expect(output.runId).toBeString()
		expect(output.nextAction).toBeString()
	} finally {
		profile.cleanup()
	}
})

test("dev:claude is the build-only watch shortcut", () => {
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

	expect(packageJson.scripts["dev:claude"]).toBe("bun run scripts/dev.ts claude watch")
})

test("dev:codex is the preview-only shortcut", () => {
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

	expect(packageJson.scripts["dev:codex"]).toBe("bun run scripts/dev.ts codex install")
})

interface FakeCodexPlugin {
	pluginId: string
	name: string
	marketplaceName: string
	version: string
	installed: boolean
	enabled: boolean
	source: { source: string; path: string }
	marketplaceSource: { sourceType: string; source: string }
}

interface FakeCodexState {
	marketplaces: Array<{ name: string; root: string }>
	plugins: FakeCodexPlugin[]
	commands: string[]
	skipInstall?: boolean
	failCommands?: string[]
	failAfterCommands?: string[]
	invalidJsonCommands?: string[]
}

function fakeCodexProfile(
	repositoryRoot: string,
	options: {
		marketplaceRoot?: string | null
		plugins?: FakeCodexPlugin[]
		skipInstall?: boolean
		failCommands?: string[]
		failAfterCommands?: string[]
		invalidJsonCommands?: string[]
	} = {},
) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-development-profile-"))
	const binaryRoot = join(temporaryRoot, "bin")
	const statePath = join(temporaryRoot, "state.json")
	const marketplaceRoot = join(repositoryRoot, ".dev", "codex-marketplace")
	mkdirSync(binaryRoot, { recursive: true })
	writeExecutable(
		join(binaryRoot, "bun"),
		`#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "build" ]; then exit 0; fi
exec '${process.execPath}' "$@"
`,
	)
	writeExecutable(
		join(binaryRoot, "codex"),
		`#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const statePath = process.env.CODEX_TEST_STATE
const state = JSON.parse(readFileSync(statePath, "utf8"))
const args = process.argv.slice(2)
const command = args.join(" ")
state.commands.push(command)
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n")
const completeMutation = (output) => {
  save()
  if (state.failAfterCommands?.includes(command)) {
    console.error("injected Codex post-mutation failure")
    process.exit(70)
  }
  console.log(JSON.stringify(output))
}
if (state.failCommands?.includes(command)) {
  save()
  console.error("injected Codex failure")
  process.exit(70)
} else if (state.invalidJsonCommands?.includes(command)) {
  save()
  console.log("not JSON")
} else if (command === "plugin marketplace list --json") {
  save()
  console.log(JSON.stringify({ marketplaces: state.marketplaces }))
} else if (command === "plugin list --json") {
  save()
  console.log(JSON.stringify({ installed: state.plugins, available: [] }))
} else if (args.slice(0, 3).join(" ") === "plugin marketplace add") {
	const root = args[3]
	state.marketplaces = state.marketplaces.filter((entry) => entry.name !== "my-second-brain-dev")
	state.marketplaces.push({ name: "my-second-brain-dev", root })
	completeMutation({ marketplaceName: "my-second-brain-dev", installedRoot: root })
} else if (args[0] === "plugin" && args[1] === "add") {
  if (!state.skipInstall) {
    const sourcePath = join(process.env.CODEX_TEST_MARKETPLACE_ROOT, "plugins", "my-second-brain-dev")
    const manifest = JSON.parse(readFileSync(join(sourcePath, ".codex-plugin", "plugin.json"), "utf8"))
    state.plugins = state.plugins.filter((entry) => entry.pluginId !== args[2])
    state.plugins.push({
      pluginId: args[2],
      name: "my-second-brain-dev",
      marketplaceName: "my-second-brain-dev",
      version: manifest.version,
      installed: true,
      enabled: true,
      source: { source: "local", path: sourcePath },
		marketplaceSource: { sourceType: "local", source: process.env.CODEX_TEST_MARKETPLACE_ROOT },
	})
	}
	completeMutation({ ok: true })
} else if (args[0] === "plugin" && args[1] === "remove") {
	state.plugins = state.plugins.filter((entry) => entry.pluginId !== args[2])
	completeMutation({ ok: true })
} else {
  save()
  console.error("unexpected Codex command: " + command)
  process.exit(99)
}
`,
	)
	const state: FakeCodexState = {
		marketplaces:
			options.marketplaceRoot === null
				? []
				: [
						{
							name: "my-second-brain-dev",
							root: options.marketplaceRoot ?? marketplaceRoot,
						},
					],
		plugins: options.plugins ?? [],
		commands: [],
		skipInstall: options.skipInstall,
		failCommands: options.failCommands,
		failAfterCommands: options.failAfterCommands,
		invalidJsonCommands: options.invalidJsonCommands,
	}
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
	return {
		environment: {
			...process.env,
			PATH: `${binaryRoot}:${process.env.PATH ?? ""}`,
			CODEX_TEST_STATE: statePath,
			CODEX_TEST_MARKETPLACE_ROOT: marketplaceRoot,
		},
		marketplaceRoot,
		readState: () => JSON.parse(readFileSync(statePath, "utf8")) as FakeCodexState,
		writeState: (state: FakeCodexState) => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`),
		cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true }),
	}
}

function staleCodexPlugin(repositoryRoot: string, pluginId = "my-second-brain-dev@my-second-brain-dev") {
	const marketplaceRoot = join(repositoryRoot, ".dev", "codex-marketplace")
	return {
		pluginId,
		name: pluginId.startsWith("my-second-brain-dev@")
			? "my-second-brain-dev"
			: "my-second-brain",
		marketplaceName: "my-second-brain-dev",
		version: "0.2.0+codex.local-stale",
		installed: true,
		enabled: true,
		source: {
			source: "local",
			path: join(marketplaceRoot, "plugins", "my-second-brain-dev"),
		},
		marketplaceSource: { sourceType: "local", source: marketplaceRoot },
	} satisfies FakeCodexPlugin
}

test("Codex check stages and inspects without changing profile state", () => {
	const repositoryRoot = isolatedRepository("codex-development-check-")
	const profile = fakeCodexProfile(repositoryRoot, { marketplaceRoot: null })
	try {
		const result = run(
			["codex", "check", "--json", "--no-input"],
			profile.environment,
			repositoryRoot,
		)

		expect(result.exitCode, result.stderr.toString()).toBe(0)
		const output = jsonOutput(result)
		expect(output).toMatchObject({
			contractId: "plugin.development-installation",
			harness: "codex",
			operation: "check",
			mode: "inspect",
			changed: false,
			current: { development: "absent", candidateCurrent: false },
		})
		expect(output.candidate.payloadHash).toMatch(/^[a-f0-9]{64}$/)
		expect(output.candidate.candidateHash).toMatch(/^[a-f0-9]{64}$/)
		const inventory = pluginPayloadInventory(repositoryRoot)
		expect(output.candidate.payloadHash).toBe(
			payloadInventorySha256(output.candidate.sourcePath, inventory),
		)
		expect(output.candidate.payloadHash).not.toBe(
			payloadInventorySha256(join(repositoryRoot, "plugin"), inventory),
		)
		expect(output.plan).toEqual([
			`codex plugin marketplace add ${profile.marketplaceRoot}`,
			"codex plugin add my-second-brain-dev@my-second-brain-dev --json",
		])
		expect(profile.readState().commands).toEqual([
			"plugin marketplace list --json",
			"plugin list --json",
		])
		const developmentManifest = JSON.parse(
			readFileSync(
				join(
					profile.marketplaceRoot,
					"plugins",
					"my-second-brain-dev",
					".codex-plugin",
					"plugin.json",
				),
				"utf8",
			),
		)
		expect(developmentManifest).toMatchObject({
			name: "my-second-brain-dev",
			version: output.candidate.version,
			interface: { displayName: "My Second Brain Dev" },
		})
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex install preview binds the exact candidate and performs no mutation", () => {
	const repositoryRoot = isolatedRepository("codex-development-preview-")
	const profile = fakeCodexProfile(repositoryRoot, {
		plugins: [staleCodexPlugin(repositoryRoot)],
	})
	try {
		const result = run(
			["codex", "install", "--json", "--no-input", "--no-launch"],
			profile.environment,
			repositoryRoot,
		)

		expect(result.exitCode, result.stderr.toString()).toBe(0)
		const output = jsonOutput(result)
		expect(output).toMatchObject({
			mode: "preview",
			changed: false,
			transactionState: "previewed",
			current: { development: "installed", candidateCurrent: false },
			plan: ["codex plugin add my-second-brain-dev@my-second-brain-dev --json"],
		})
		expect(output.nextAction).toContain(output.candidate.candidateHash)
		expect(profile.readState().commands).toEqual([
			"plugin marketplace list --json",
			"plugin list --json",
		])
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex apply installs and verifies the exact previewed candidate", () => {
	const repositoryRoot = isolatedRepository("codex-development-apply-")
	const profile = fakeCodexProfile(repositoryRoot, { marketplaceRoot: null })
	try {
		const preview = run(
			["codex", "install", "--json", "--no-input", "--no-launch"],
			profile.environment,
			repositoryRoot,
		)
		const candidateHash = jsonOutput(preview).candidate.candidateHash
		const applied = run(
			[
				"codex",
				"install",
				"--apply",
				"--candidate-hash",
				candidateHash,
				"--json",
				"--no-input",
				"--no-launch",
			],
			profile.environment,
			repositoryRoot,
		)

		expect(applied.exitCode, applied.stderr.toString()).toBe(0)
		const appliedOutput = jsonOutput(applied)
		expect(appliedOutput).toMatchObject({
			mode: "apply",
			changed: true,
			transactionState: "installed",
			current: { development: "installed", enabled: true, candidateCurrent: true },
			sideEffects: ["development_marketplace_added", "development_plugin_installed"],
		})
		const commands = profile.readState().commands
		expect(commands).toContain(`plugin marketplace add ${profile.marketplaceRoot}`)
		expect(commands).toContain("plugin add my-second-brain-dev@my-second-brain-dev --json")
		expect(
			commands
				.filter(
					(command) =>
						command.startsWith("plugin marketplace add") ||
						command.startsWith("plugin add") ||
						command.startsWith("plugin remove"),
				)
				.map((command) => `codex ${command}`),
		).toEqual(appliedOutput.plan)
		expect(commands.slice(-2)).toEqual([
			"plugin marketplace list --json",
			"plugin list --json",
		])
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex no-input apply never launches an interactive Codex process", () => {
	const repositoryRoot = isolatedRepository("codex-development-no-input-launch-")
	const profile = fakeCodexProfile(repositoryRoot, { marketplaceRoot: null })
	try {
		const preview = run(
			["codex", "install", "--json", "--no-input"],
			profile.environment,
			repositoryRoot,
		)
		const candidateHash = jsonOutput(preview).candidate.candidateHash
		const applied = run(
			[
				"codex",
				"install",
				"--apply",
				"--candidate-hash",
				candidateHash,
				"--json",
				"--no-input",
			],
			profile.environment,
			repositoryRoot,
		)

		expect(applied.exitCode, applied.stderr.toString()).toBe(0)
		expect(jsonOutput(applied)).toMatchObject({ mode: "apply", transactionState: "installed" })
		expect(profile.readState().commands).not.toContain("")
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex apply refuses a candidate that differs from the preview", () => {
	const repositoryRoot = isolatedRepository("codex-development-binding-")
	const profile = fakeCodexProfile(repositoryRoot, { marketplaceRoot: null })
	try {
		const result = run(
			[
				"codex",
				"install",
				"--apply",
				"--candidate-hash",
				"0".repeat(64),
				"--json",
				"--no-input",
				"--no-launch",
			],
			profile.environment,
			repositoryRoot,
		)

		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			changed: false,
			transactionState: "blocked",
			error: {
				code: "CODEX_DEVELOPMENT_CANDIDATE_CHANGED",
				action: "FIX_INPUT",
				errorFamily: "conflict",
			},
		})
		expect(profile.readState().commands).toEqual([
			"plugin marketplace list --json",
			"plugin list --json",
		])
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex check rejects a development Marketplace owned by another checkout", () => {
	const repositoryRoot = isolatedRepository("codex-development-owner-")
	const profile = fakeCodexProfile(repositoryRoot, { marketplaceRoot: "/other/checkout" })
	try {
		const result = run(
			["codex", "check", "--json", "--no-input"],
			profile.environment,
			repositoryRoot,
		)

		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			changed: false,
			error: {
				code: "CODEX_DEVELOPMENT_MARKETPLACE_MISMATCH",
				action: "INSPECT_STATE",
				errorFamily: "conflict",
			},
		})
		expect(profile.readState().commands).toEqual([
			"plugin marketplace list --json",
			"plugin list --json",
		])
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex check classifies invalid native JSON as a protocol inspection", () => {
	const repositoryRoot = isolatedRepository("codex-development-invalid-json-")
	const profile = fakeCodexProfile(repositoryRoot, {
		marketplaceRoot: null,
		invalidJsonCommands: ["plugin list --json"],
	})
	try {
		const result = run(
			["codex", "check", "--json", "--no-input"],
			profile.environment,
			repositoryRoot,
		)

		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			error: {
				code: "CODEX_OUTPUT_INVALID",
				action: "INSPECT_STATE",
				errorFamily: "protocol",
			},
		})
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex check classifies native command failure as a runtime repair", () => {
	const repositoryRoot = isolatedRepository("codex-development-command-failure-")
	const profile = fakeCodexProfile(repositoryRoot, {
		marketplaceRoot: null,
		failCommands: ["plugin marketplace list --json"],
	})
	try {
		const result = run(
			["codex", "check", "--json", "--no-input"],
			profile.environment,
			repositoryRoot,
		)

		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			error: {
				code: "CODEX_COMMAND_FAILED",
				action: "FIX_INPUT",
				errorFamily: "runtime",
			},
		})
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex apply reports unknown state when resulting identity is not verified", () => {
	const repositoryRoot = isolatedRepository("codex-development-verification-")
	const profile = fakeCodexProfile(repositoryRoot, { marketplaceRoot: null, skipInstall: true })
	try {
		const preview = run(
			["codex", "install", "--json", "--no-input", "--no-launch"],
			profile.environment,
			repositoryRoot,
		)
		const candidateHash = jsonOutput(preview).candidate.candidateHash
		const applied = run(
			[
				"codex",
				"install",
				"--apply",
				"--candidate-hash",
				candidateHash,
				"--json",
				"--no-input",
				"--no-launch",
			],
			profile.environment,
			repositoryRoot,
		)

		expect(applied.exitCode).toBe(1)
		expect(jsonOutput(applied)).toMatchObject({
			changed: true,
			transactionState: "unknown",
			retrySafety: "inspect_required",
			error: {
				code: "CODEX_DEVELOPMENT_VERIFICATION_FAILED",
				action: "INSPECT_STATE",
				errorFamily: "verification",
			},
			sideEffects: ["development_marketplace_added", "development_plugin_installed"],
		})
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex apply removes only the superseded development identity", () => {
	const repositoryRoot = isolatedRepository("codex-development-migration-")
	const production = staleCodexPlugin(
		repositoryRoot,
		"my-second-brain@my-second-brain",
	)
	production.marketplaceName = "my-second-brain"
	production.name = "my-second-brain"
	const superseded = staleCodexPlugin(
		repositoryRoot,
		"my-second-brain@my-second-brain-dev",
	)
	const profile = fakeCodexProfile(repositoryRoot, { plugins: [production, superseded] })
	try {
		const preview = run(
			["codex", "install", "--json", "--no-input", "--no-launch"],
			profile.environment,
			repositoryRoot,
		)
		const candidateHash = jsonOutput(preview).candidate.candidateHash
		const applied = run(
			[
				"codex",
				"install",
				"--apply",
				"--candidate-hash",
				candidateHash,
				"--json",
				"--no-input",
				"--no-launch",
			],
			profile.environment,
			repositoryRoot,
		)

		expect(applied.exitCode, applied.stderr.toString()).toBe(0)
		const state = profile.readState()
		expect(state.plugins.some((entry) => entry.pluginId === production.pluginId)).toBe(true)
		expect(state.plugins.some((entry) => entry.pluginId === superseded.pluginId)).toBe(false)
		expect(state.commands).toContain(
			"plugin remove my-second-brain@my-second-brain-dev --json",
		)
		expect(state.commands).not.toContain("plugin remove my-second-brain@my-second-brain --json")
		expect(
			state.commands
				.filter(
					(command) =>
						command.startsWith("plugin marketplace add") ||
						command.startsWith("plugin add") ||
						command.startsWith("plugin remove"),
				)
				.map((command) => `codex ${command}`),
		).toEqual(jsonOutput(applied).plan)
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex apply rejects native-state drift from the approved operation plan", () => {
	const repositoryRoot = isolatedRepository("codex-development-plan-drift-")
	const profile = fakeCodexProfile(repositoryRoot, {
		plugins: [staleCodexPlugin(repositoryRoot)],
	})
	try {
		const preview = run(
			["codex", "install", "--json", "--no-input", "--no-launch"],
			profile.environment,
			repositoryRoot,
		)
		const previewOutput = jsonOutput(preview)
		expect(previewOutput.plan).toEqual([
			"codex plugin add my-second-brain-dev@my-second-brain-dev --json",
		])

		const drifted = profile.readState()
		drifted.plugins.push(
			staleCodexPlugin(repositoryRoot, "my-second-brain@my-second-brain-dev"),
		)
		drifted.commands = []
		profile.writeState(drifted)

		const applied = run(
			[
				"codex",
				"install",
				"--apply",
				"--candidate-hash",
				previewOutput.candidate.candidateHash,
				"--json",
				"--no-input",
				"--no-launch",
			],
			profile.environment,
			repositoryRoot,
		)

		expect(applied.exitCode).toBe(1)
		expect(jsonOutput(applied)).toMatchObject({
			changed: false,
			transactionState: "blocked",
			error: { code: "CODEX_DEVELOPMENT_CANDIDATE_CHANGED" },
		})
		expect(profile.readState().commands).toEqual([
			"plugin marketplace list --json",
			"plugin list --json",
		])
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Codex apply treats a post-mutation command failure as unknown", () => {
	const repositoryRoot = isolatedRepository("codex-development-post-mutation-failure-")
	const command = "plugin add my-second-brain-dev@my-second-brain-dev --json"
	const profile = fakeCodexProfile(repositoryRoot, { failAfterCommands: [command] })
	try {
		const preview = run(
			["codex", "install", "--json", "--no-input", "--no-launch"],
			profile.environment,
			repositoryRoot,
		)
		const applied = run(
			[
				"codex",
				"install",
				"--apply",
				"--candidate-hash",
				jsonOutput(preview).candidate.candidateHash,
				"--json",
				"--no-input",
				"--no-launch",
			],
			profile.environment,
			repositoryRoot,
		)

		expect(applied.exitCode).toBe(1)
		expect(jsonOutput(applied)).toMatchObject({
			changed: true,
			transactionState: "unknown",
			retrySafety: "inspect_required",
			error: { code: "CODEX_DEVELOPMENT_APPLY_FAILED", action: "INSPECT_STATE" },
			sideEffects: [],
		})
		expect(
			profile
				.readState()
				.plugins.some(
					(plugin) => plugin.pluginId === "my-second-brain-dev@my-second-brain-dev",
				),
		).toBe(true)
	} finally {
		profile.cleanup()
		rmSync(repositoryRoot, { recursive: true, force: true })
	}
})

test("Claude development watches workspace, runtime, manifest, and lock inputs", () => {
	const recursivePaths = new Set(
		claudeWatchSources.filter(({ recursive }) => recursive).map(({ relativePath }) => relativePath),
	)
	const filePaths = new Set(
		claudeWatchSources
			.filter(({ recursive }) => !recursive)
			.map(({ relativePath }) => relativePath),
	)

	for (const relativePath of [
		"runtime",
		"packages",
		"plugin/skills",
		"plugin/hooks",
		"plugin/assets",
		"plugin/.claude-plugin",
		"plugin/.codex-plugin",
	]) {
		expect(recursivePaths.has(relativePath)).toBe(true)
	}
	for (const relativePath of ["package.json", "bun.lock", "bunfig.toml", "plugin.config.json"]) {
		expect(filePaths.has(relativePath)).toBe(true)
	}
})

test("a failed rebuild reports the error and keeps watching", async () => {
	const profile = fakeProfile({ failBuildAfter: 2 })
	const watchedPath = join(root, "plugin.config.json")
	const originalTimes = statSync(watchedPath)
	const installed = run(
		["claude", "install", "--apply", "--json", "--no-input"],
		profile.environment,
	)
	expect(installed.exitCode).toBe(0)
	const commandCountBeforeWatch = profile.readState().commands.length

	const child = Bun.spawn({
		cmd: [process.execPath, "scripts/dev.ts", "claude", "watch", "--json", "--no-input"],
		cwd: root,
		env: profile.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
	let stderr = ""
	const decoder = new TextDecoder()
	const stderrReader = child.stderr.getReader()
	const stderrPump = (async () => {
		while (true) {
			const { done, value } = await stderrReader.read()
			if (done) break
			stderr += decoder.decode(value, { stream: true })
		}
		stderr += decoder.decode()
	})()
	let exitCode: number | undefined
	try {
		await waitFor(
			() =>
				profile.readBuildCount() >= 2 &&
				profile.readState().commands.length >= commandCountBeforeWatch + 4,
			"watch preparation to finish",
		)
		await Bun.sleep(100)
		utimesSync(watchedPath, originalTimes.atime, new Date(originalTimes.mtimeMs + 1_000))
		await waitFor(
			() => stderr.includes("Rebuild failed: Plugin Payload rebuild failed"),
			"the rebuild failure diagnostic",
		)
		expect(child.exitCode).toBeNull()
		expect(stderr).toContain("Watching for the next change.")
	} finally {
		utimesSync(watchedPath, originalTimes.atime, originalTimes.mtime)
		child.kill("SIGTERM")
		exitCode = await child.exited
		await stderrPump
		profile.cleanup()
	}
	const stdout = await new Response(child.stdout).text()
	expect(exitCode).toBe(0)
	expect(JSON.parse(stdout)).toMatchObject({
		ok: true,
		operation: "watch",
		transactionState: "ready",
	})
}, 20_000)

test("Claude check generates a link-mode command source for the canonical payload", () => {
	const profile = fakeProfile()
	try {
		const result = run(["claude", "check", "--json", "--no-input"], profile.environment)
		expect(result.exitCode).toBe(0)
		const marketplace = JSON.parse(
			readFileSync(
				join(root, ".dev", "claude", "marketplace", ".claude-plugin", "marketplace.json"),
				"utf8",
			),
		)
		expect(marketplace.name).toBe(developmentMarketplaceName)
		expect(marketplace.plugins).toHaveLength(1)
		expect(marketplace.plugins[0]).toMatchObject({
			name: pluginName,
			defaultEnabled: false,
			source: {
				source: "command",
				mode: "link",
			},
		})
		expect(marketplace.plugins[0].source.command).toContain(join(root, "plugin"))
	} finally {
		profile.cleanup()
	}
})

test("an unparsable production Marketplace URL blocks before profile mutation", () => {
	const profile = fakeProfile({
		marketplaces: [
			{
				name: pluginName,
				source: "url",
				url: "https://user:password@",
			},
		],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)

		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			changed: false,
			transactionState: "blocked",
			error: { code: "PRODUCTION_SOURCE_UNRESTORABLE" },
		})
		const state = profile.readState()
		expect(state.marketplaces).toHaveLength(1)
		expect(state.marketplaces[0].url).toBe("https://user:password@")
		expect(
			state.commands.some((command) => /plugin (install|uninstall|enable|disable)/.test(command.join(" "))),
		).toBe(false)
		expect(
			state.commands.some((command) => command.slice(0, 3).join(" ") === "plugin marketplace remove"),
		).toBe(false)
	} finally {
		profile.cleanup()
	}
})

test("a production Marketplace URL with inline credentials blocks before profile mutation", () => {
	const profile = fakeProfile({
		marketplaces: [
			{
				name: pluginName,
				source: "url",
				url: "https://user:password@example.com/marketplace.git",
			},
		],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)

		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			changed: false,
			transactionState: "blocked",
			error: { code: "PRODUCTION_SOURCE_CONTAINS_CREDENTIALS" },
		})
		const commands = profile.readState().commands.map((command) => command.join(" "))
		expect(commands.some((command) => command.includes("marketplace remove"))).toBe(false)
	} finally {
		profile.cleanup()
	}
})

test("install preview reports the transition without changing Claude profile state", () => {
	const profile = fakeProfile({ production: true })
	try {
		const result = run(["claude", "install", "--json", "--no-input"], profile.environment)

		expect(result.exitCode).toBe(0)
		expect(jsonOutput(result)).toMatchObject({
			ok: true,
			mode: "preview",
			changed: false,
			transactionState: "previewed",
			current: {
				production: "installed",
				development: "absent",
				singleSource: true,
			},
		})
		const commands = profile.readState().commands.map((command) => command.join(" "))
		expect(
			commands.some((command) => /plugin (install|uninstall|enable|disable)/.test(command)),
		).toBe(false)
		expect(commands.some((command) => command.includes("marketplace add"))).toBe(false)
		expect(commands.some((command) => command.includes("marketplace remove"))).toBe(false)
	} finally {
		profile.cleanup()
	}
})

/**
 * The preview is the only disclosure before a profile write, and `--apply`
 * uninstalls the production Plugin Installation before it installs the
 * development one. A fixed sentence that reads the same whether or not
 * production is present asks for consent to an action it never names.
 */
test("install preview names the production installation it will replace", () => {
	const profile = fakeProfile({ production: true })
	try {
		const result = run(["claude", "install", "--json", "--no-input"], profile.environment)

		const nextAction = jsonOutput(result).nextAction
		expect(nextAction).toContain("uninstall")
		expect(nextAction).toContain(productionId)
		// `--keep-data` is why the replacement is recoverable, so the preview
		// says it rather than leaving the reader to assume data loss.
		expect(nextAction).toContain("--keep-data")
		// Bare `restore` previews, so naming it as the recovery would send a
		// reader into a no-op and call the production state restored.
		expect(nextAction).toContain("claude restore --apply")
	} finally {
		profile.cleanup()
	}
})

test("install preview names a Marketplace-only production state", () => {
	const profile = fakeProfile({ productionMarketplaceOnly: true })
	try {
		const result = run(["claude", "install", "--json", "--no-input"], profile.environment)

		const nextAction = jsonOutput(result).nextAction
		// No Plugin Installation exists to uninstall, so naming one would
		// describe a mutation `--apply` never makes.
		expect(nextAction).not.toContain("uninstall")
		expect(nextAction).toContain("remove the")
		expect(nextAction).toContain("Marketplace")
	} finally {
		profile.cleanup()
	}
})

test("install preview claims no replacement when production is absent", () => {
	const profile = fakeProfile()
	try {
		const result = run(["claude", "install", "--json", "--no-input"], profile.environment)

		// Asserting the absence of "uninstall" alone passed against the fixed
		// string this replaced, so it pinned nothing. The sentence itself is
		// the assertion.
		expect(jsonOutput(result).nextAction).toBe(
			"Review the planned development installation, then rerun with `--apply`.",
		)
	} finally {
		profile.cleanup()
	}
})

test("install and restore preserve an originally absent production state", () => {
	const profile = fakeProfile()
	try {
		const installed = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(installed.exitCode).toBe(0)
		expect(jsonOutput(installed)).toMatchObject({
			transactionState: "installed",
			changed: true,
			current: {
				production: "absent",
				development: "installed",
				singleSource: true,
				linkedToCanonicalPayload: true,
			},
		})
		const development = profile.readState().plugins.find((plugin) => plugin.id === developmentId)
		expect(development?.enabled).toBe(true)
		expect(existsSync(development!.installPath)).toBe(true)

		const restored = run(
			["claude", "restore", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(restored.exitCode).toBe(0)
		expect(jsonOutput(restored)).toMatchObject({
			transactionState: "restored",
			current: {
				production: "absent",
				development: "absent",
				singleSource: true,
			},
		})
		expect(profile.readState().plugins).toHaveLength(0)
		expect(profile.readState().marketplaces).toHaveLength(0)
	} finally {
		profile.cleanup()
	}
})

test("restore succeeds when the checkout can no longer build", () => {
	const profile = fakeProfile({ production: true, failBuildAfter: 1 })
	try {
		const installed = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(installed.exitCode).toBe(0)
		expect(profile.readBuildCount()).toBe(1)

		const restored = run(
			["claude", "restore", "--apply", "--json", "--no-input"],
			profile.environment,
		)

		expect(restored.exitCode).toBe(0)
		expect(jsonOutput(restored)).toMatchObject({
			changed: true,
			transactionState: "restored",
			current: {
				production: "installed",
				development: "absent",
				singleSource: true,
			},
		})
		expect(profile.readBuildCount()).toBe(1)
	} finally {
		profile.cleanup()
	}
})

test("restore reports when the captured production version is unavailable", () => {
	const profile = fakeProfile({ production: true })
	try {
		const installed = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(installed.exitCode).toBe(0)
		const state = profile.readState()
		state.installVersions = { [productionId]: "0.0.0-unavailable" }
		profile.writeState(state)

		const restored = run(
			["claude", "restore", "--apply", "--json", "--no-input"],
			profile.environment,
		)

		expect(restored.exitCode).toBe(1)
		expect(jsonOutput(restored)).toMatchObject({
			changed: true,
			transactionState: "unknown",
			retrySafety: "inspect_required",
			error: { code: "PRODUCTION_VERSION_UNAVAILABLE" },
		})
		const finalState = profile.readState()
		expect(finalState.plugins[0].version).toBe("0.0.0-unavailable")
		expect(
			finalState.commands.some(
				(command) => command.join(" ") === `plugin install ${productionId} --scope user --yes`,
			),
		).toBe(true)
	} finally {
		profile.cleanup()
	}
})

test("install and restore preserve a production Marketplace without an installed plugin", () => {
	const profile = fakeProfile({ productionMarketplaceOnly: true })
	try {
		const preview = run(["claude", "install", "--json", "--no-input"], profile.environment)
		expect(preview.exitCode).toBe(0)
		expect(jsonOutput(preview).current.production).toBe("marketplace-only")

		const installed = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(installed.exitCode).toBe(0)
		expect(jsonOutput(installed).current).toMatchObject({
			production: "absent",
			development: "installed",
			singleSource: true,
		})

		const restored = run(
			["claude", "restore", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(restored.exitCode).toBe(0)
		expect(jsonOutput(restored).current).toMatchObject({
			production: "marketplace-only",
			development: "absent",
			singleSource: true,
		})
		expect(profile.readState().plugins).toHaveLength(0)
		expect(profile.readState().marketplaces).toHaveLength(1)
		expect(profile.readState().marketplaces[0].path).toBe(profile.productionMarketplaceRoot)
	} finally {
		profile.cleanup()
	}
})

test(
	"isolated profile snapshots cannot overwrite each other's restore state",
	() => {
		const productionProfile = fakeProfile({ production: true, productionEnabled: false })
		const absentProfile = fakeProfile()
		try {
			for (const profile of [productionProfile, absentProfile]) {
				const installed = run(
					["claude", "install", "--apply", "--json", "--no-input"],
					profile.environment,
				)
				expect(installed.exitCode).toBe(0)
			}

			const productionRestored = run(
				["claude", "restore", "--apply", "--json", "--no-input"],
				productionProfile.environment,
			)
			expect(productionRestored.exitCode).toBe(0)
			expect(jsonOutput(productionRestored).current.production).toBe("installed")
			expect(productionProfile.readState().plugins[0].enabled).toBe(false)

			const absentRestored = run(
				["claude", "restore", "--apply", "--json", "--no-input"],
				absentProfile.environment,
			)
			expect(absentRestored.exitCode).toBe(0)
			expect(jsonOutput(absentRestored).current.production).toBe("absent")
			expect(absentProfile.readState().plugins).toHaveLength(0)
		} finally {
			productionProfile.cleanup()
			absentProfile.cleanup()
		}
	},
	lifecycleSuiteTimeoutMs,
)

test("a snapshot without prior state reports a typed mismatch", () => {
	const profile = fakeProfile()
	try {
		const installed = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(installed.exitCode).toBe(0)
		const snapshot = JSON.parse(readFileSync(profile.snapshotPath, "utf8"))
		delete snapshot.prior
		writeFileSync(profile.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)

		const restored = run(
			["claude", "restore", "--json", "--no-input"],
			profile.environment,
		)

		expect(restored.exitCode).toBe(1)
		expect(jsonOutput(restored)).toMatchObject({
			changed: false,
			transactionState: "blocked",
			retrySafety: "inspect_required",
			error: { code: "RESTORATION_SNAPSHOT_MISMATCH" },
		})
	} finally {
		profile.cleanup()
	}
})

test("relative production Marketplace paths block before profile mutation", () => {
	const profile = fakeProfile({
		marketplaces: [
			{
				name: pluginName,
				source: "directory",
				path: "relative-marketplace",
				installLocation: "relative-marketplace",
			},
		],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			changed: false,
			error: { code: "PRODUCTION_SOURCE_UNRESTORABLE" },
		})
		const commands = profile.readState().commands.map((command) => command.join(" "))
		expect(commands.some((command) => command.includes("marketplace remove"))).toBe(false)
	} finally {
		profile.cleanup()
	}
})

for (const productionEnabled of [true, false]) {
	test(`install and restore preserve production enabled=${productionEnabled}`, () => {
		const profile = fakeProfile({ production: true, productionEnabled })
		const sentinel = join(
			profile.profileRoot,
			"plugins",
			"data",
			productionId,
			"restoration-sentinel.txt",
		)
		mkdirSync(join(sentinel, ".."), { recursive: true })
		writeFileSync(sentinel, "preserve me\n")
		try {
			const installed = run(
				["claude", "install", "--apply", "--json", "--no-input"],
				profile.environment,
			)
			expect(installed.exitCode).toBe(0)
			let state = profile.readState()
			expect(state.plugins.map((plugin) => plugin.id)).toEqual([developmentId])
			const commandTexts = state.commands.map((command) => command.join(" "))
			const uninstallIndex = commandTexts.indexOf(
				`plugin uninstall ${productionId} --keep-data --scope user`,
			)
			const marketplaceAddIndex = commandTexts.indexOf(
				`plugin marketplace add ${join(root, ".dev", "claude", "marketplace")} --scope user`,
			)
			expect(uninstallIndex).toBeGreaterThanOrEqual(0)
			expect(marketplaceAddIndex).toBeGreaterThanOrEqual(0)
			expect(uninstallIndex).toBeLessThan(marketplaceAddIndex)

			const restored = run(
				["claude", "restore", "--apply", "--json", "--no-input"],
				profile.environment,
			)
			expect(restored.exitCode).toBe(0)
			state = profile.readState()
			expect(state.plugins).toHaveLength(1)
			expect(state.plugins[0]).toMatchObject({
				id: productionId,
				version: pluginVersion,
				scope: "user",
				enabled: productionEnabled,
			})
			expect(state.marketplaces).toHaveLength(1)
			expect(state.marketplaces[0].path).toBe(profile.productionMarketplaceRoot)
			expect(readFileSync(sentinel, "utf8")).toBe("preserve me\n")
		} finally {
			profile.cleanup()
		}
	})
}

test("install is idempotent when the exact development link is already active", () => {
	const profile = fakeProfile()
	try {
		const first = run(["claude", "install", "--apply", "--json", "--no-input"], profile.environment)
		expect(first.exitCode).toBe(0)
		const before = profile.readState().commands.length
		const second = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(second.exitCode).toBe(0)
		expect(jsonOutput(second)).toMatchObject({
			changed: false,
			transactionState: "no_op",
		})
		const secondCommands = profile
			.readState()
			.commands.slice(before)
			.map((command) => command.join(" "))
		expect(
			secondCommands.some((command) => /plugin (install|uninstall|enable|disable)/.test(command)),
		).toBe(false)
	} finally {
		profile.cleanup()
	}
})

test(
	"install previews and repairs a disabled snapshot-owned development link",
	() => {
		const profile = fakeProfile({ production: true, productionEnabled: false })
		try {
			const installed = run(
				["claude", "install", "--apply", "--json", "--no-input"],
				profile.environment,
			)
			expect(installed.exitCode).toBe(0)
			const disabled = profile.readState()
			disabled.plugins[0].enabled = false
			profile.writeState(disabled)

			const preview = run(["claude", "install", "--json", "--no-input"], profile.environment)
			expect(preview.exitCode).toBe(0)
			expect(jsonOutput(preview)).toMatchObject({
				changed: false,
				transactionState: "previewed",
				current: { development: "installed", linkedToCanonicalPayload: true },
			})
			expect(profile.readState().plugins[0].enabled).toBe(false)

			const repaired = run(
				["claude", "install", "--apply", "--json", "--no-input"],
				profile.environment,
			)
			expect(repaired.exitCode).toBe(0)
			expect(jsonOutput(repaired)).toMatchObject({
				changed: true,
				transactionState: "installed",
				current: { development: "installed", linkedToCanonicalPayload: true },
			})
			expect(profile.readState().plugins[0].enabled).toBe(true)

			const restored = run(
				["claude", "restore", "--apply", "--json", "--no-input"],
				profile.environment,
			)
			expect(restored.exitCode).toBe(0)
			expect(profile.readState().plugins[0]).toMatchObject({
				id: productionId,
				version: pluginVersion,
				enabled: false,
			})
		} finally {
			profile.cleanup()
		}
	}, 15_000)

	test("an unmanaged development link without its profile snapshot fails closed", () => {
		const profile = fakeProfile()
		try {
			const installed = run(
				["claude", "install", "--apply", "--json", "--no-input"],
				profile.environment,
			)
			expect(installed.exitCode).toBe(0)
			rmSync(profile.snapshotPath, { force: true })

			const checked = run(["claude", "check", "--json", "--no-input"], profile.environment)
			expect(checked.exitCode).toBe(1)
			expect(jsonOutput(checked)).toMatchObject({
				ok: false,
				changed: false,
				retrySafety: "inspect_required",
				error: { code: "RESTORATION_SNAPSHOT_MISSING", action: "INSPECT_STATE" },
			})
		} finally {
			profile.cleanup()
		}
	},
	lifecycleSuiteTimeoutMs,
)

test("non-user plugin scope blocks before any profile mutation", () => {
	const profile = fakeProfile({
		plugins: [
			{
				id: productionId,
				version: pluginVersion,
				scope: "project",
				enabled: true,
				installPath: "/isolated/project-install",
			},
		],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			changed: false,
			transactionState: "blocked",
			error: { code: "NON_USER_PLUGIN_IDENTITY", action: "ASK_ADMIN" },
		})
		const commands = profile.readState().commands.map((command) => command.join(" "))
		expect(
			commands.some((command) => /plugin (install|uninstall|enable|disable)/.test(command)),
		).toBe(false)
	} finally {
		profile.cleanup()
	}
})

test("simultaneous production and development sources block before mutation", () => {
	const wrongDevelopmentRoot = join(tmpdir(), "wrong-development-install")
	const profile = fakeProfile({ production: true })
	const state = profile.readState()
	state.plugins.push({
		id: developmentId,
		version: `${pluginVersion}-fake-link`,
		scope: "user",
		enabled: true,
		installPath: wrongDevelopmentRoot,
	})
	state.marketplaces.push({
		name: developmentMarketplaceName,
		source: "directory",
		path: join(root, ".dev", "claude", "marketplace"),
		installLocation: join(root, ".dev", "claude", "marketplace"),
	})
	writeFileSync(join(profile.temporaryRoot, "state.json"), `${JSON.stringify(state, null, 2)}\n`)
	try {
		const result = run(["claude", "check", "--json", "--no-input"], profile.environment)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result).error.code).toBe("DUPLICATE_PLUGIN_SOURCES")
		expect(jsonOutput(result).changed).toBe(false)
	} finally {
		profile.cleanup()
	}
})

test("development Marketplace ownership mismatch blocks fail closed", () => {
	const profile = fakeProfile({
		marketplaces: [
			{
				name: developmentMarketplaceName,
				source: "directory",
				path: "/another/checkout/marketplace",
				installLocation: "/another/checkout/marketplace",
			},
		],
	})
	try {
		const result = run(["claude", "check", "--json", "--no-input"], profile.environment)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result).error.code).toBe("DEVELOPMENT_MARKETPLACE_MISMATCH")
	} finally {
		profile.cleanup()
	}
})

test("failed development install restores the exact production state", () => {
	const profile = fakeProfile({
		production: true,
		productionEnabled: false,
		failCommands: [`plugin install ${developmentId} --scope user --yes`],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			operation: "install",
			mode: "apply",
			changed: true,
			transactionState: "restored",
			retrySafety: "safe",
			error: { code: "INSTALL_FAILED_RESTORED" },
		})
		const state = profile.readState()
		expect(state.plugins).toHaveLength(1)
		expect(state.plugins[0]).toMatchObject({
			id: productionId,
			version: pluginVersion,
			enabled: false,
		})
		expect(state.marketplaces).toHaveLength(1)
		expect(state.marketplaces[0].name).toBe(pluginName)
	} finally {
		profile.cleanup()
	}
})

test("a mutation that changes state before exiting nonzero is still restored", () => {
	const profile = fakeProfile({
		production: true,
		productionEnabled: true,
		failAfterCommands: [`plugin uninstall ${productionId} --keep-data --scope user`],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			transactionState: "restored",
			retrySafety: "safe",
			error: { code: "INSTALL_FAILED_RESTORED" },
		})
		const state = profile.readState()
		expect(state.plugins).toHaveLength(1)
		expect(state.plugins[0]).toMatchObject({
			id: productionId,
			version: pluginVersion,
			enabled: true,
		})
		expect(state.marketplaces).toHaveLength(1)
	} finally {
		profile.cleanup()
	}
})

test("failed installation and failed rollback report inspect-required unknown state", () => {
	const profile = fakeProfile({
		production: true,
		failCommands: [
			`plugin install ${developmentId} --scope user --yes`,
			// The first add is development; the directory source add below occurs only during rollback.
			`plugin marketplace add PLACEHOLDER --scope user`,
		],
	})
	const state = profile.readState()
	state.failCommands![1] = `plugin marketplace add ${profile.productionMarketplaceRoot} --scope user`
	writeFileSync(join(profile.temporaryRoot, "state.json"), `${JSON.stringify(state, null, 2)}\n`)
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			changed: true,
			transactionState: "unknown",
			retrySafety: "inspect_required",
			error: {
				code: "INSTALL_AND_RESTORATION_FAILED",
				action: "INSPECT_STATE",
				safeToRetrySameInput: false,
			},
		})
		const { message } = jsonOutput(result) as { message: string }
		expect(message).toContain("Installation cause:")
		expect(message).toContain("Restoration cause:")
	} finally {
		profile.cleanup()
	}
})
