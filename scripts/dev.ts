import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

import {
	ClaudeDevelopmentInstallationError,
	claudeWatchSources,
	runClaudeDevelopmentInstallation,
	type ClaudeDevelopmentErrorAction,
	type ClaudeDevelopmentOperation,
} from "./claude-development-installation"
import {
	HARNESS_IDENTITIES,
	QUALIFICATION_CLIENT_HARNESSES,
	type HarnessId,
} from "./harness-identity"
import {
	CodexDevelopmentInstallationError,
	runCodexDevelopmentInstallation,
	type CodexDevelopmentErrorAction,
} from "./codex-development-installation"

export { claudeWatchSources }

const root = resolve(import.meta.dir, "..")

const topLevelHelp = `Develop the complete Plugin Payload through each native harness.

Usage:
  bun run dev -- claude <check|install|restore|watch> [options]
  bun run dev -- codex <check|install> [options]
  bun run dev -- --help

Commands:
  claude              Manage one persistent live-linked Claude Development Installation
  codex               Inspect, preview, and apply one staged Codex Development Installation

Run \`bun run dev -- claude --help\` for the Claude lifecycle and safety contract.
`

const claudeHelp = `Manage one persistent live-linked Claude Code Development Installation.

Usage:
  bun run dev -- claude check [--json] [--no-input]
  bun run dev -- claude install [--apply] [--json] [--no-input]
  bun run dev -- claude restore [--apply] [--json] [--no-input]
  bun run dev -- claude watch [--json] [--no-input]

Actions:
  check               Build, validate, and inspect without changing Claude profile state
  install             Preview production-to-development replacement; --apply executes it
  restore             Preview exact prior-state restoration; --apply executes it
  watch               Build once, then watch sources; never launches Claude

Options:
  --apply              Authorize the previewed install or restore mutation
  --json               Emit one stable machine result on stdout
  --no-input           Assert the non-interactive path; this command never prompts
  -h, --help           Show this help

Examples:
  bun run dev -- claude check --json --no-input
  bun run dev -- claude install
  bun run dev -- claude install --apply
  bun run dev:claude
  bun run dev -- claude restore --apply

Safety:
  Production and development identities are never retained together. Install and
  restore fail closed on ambiguous or non-user state. Persistent mutations require
  --apply. Build and watch write repository output but do not change Claude settings.
`

const codexHelp = `Manage one staged Codex Development Installation.

Usage:
  bun run dev -- codex check [--json] [--no-input]
  bun run dev -- codex install [--apply --candidate-hash <sha256>] [--no-launch] [--json] [--no-input]

Options:
	--apply              Authorize the exact previewed candidate mutation
	--candidate-hash     Bind --apply to the candidate hash returned by preview
	--no-launch          Do not launch Codex after a verified apply
	--json               Emit one stable machine result on stdout
	--no-input           Assert the non-interactive path; this command never prompts or launches Codex
  -h, --help          Show this help

Safety:
  Check and install preview may rebuild repository output and stage the candidate,
  but never change Codex profile state. Native mutation requires --apply plus the
  exact candidate hash. Apply re-inspects the resulting native identity.
`

interface ClaudeInvocation {
	harness: "claude"
	operation: ClaudeDevelopmentOperation
	apply: boolean
	json: boolean
	noInput: boolean
}

interface CodexInvocation {
	harness: "codex"
	operation: "check" | "install"
	apply: boolean
	expectedCandidateHash?: string
	launch: boolean
	json: boolean
	noInput: boolean
}

type Invocation = ClaudeInvocation | CodexInvocation

class UsageError extends Error {}

function parseClaude(arguments_: string[]): ClaudeInvocation {
	const operation = arguments_[0] as ClaudeDevelopmentOperation | undefined
	if (!operation || !["check", "install", "restore", "watch"].includes(operation)) {
		throw new UsageError("claude requires check, install, restore, or watch")
	}
	let apply = false
	let json = false
	let noInput = false
	const seen = new Set<string>()
	for (const argument of arguments_.slice(1)) {
		if (seen.has(argument)) throw new UsageError(`${argument} may be provided once`)
		seen.add(argument)
		switch (argument) {
			case "--apply":
				apply = true
				break
			case "--json":
				json = true
				break
			case "--no-input":
				noInput = true
				break
			default:
				throw new UsageError(`unknown Claude option: ${argument}`)
		}
	}
	if (apply && !["install", "restore"].includes(operation)) {
		throw new UsageError("--apply is supported only by claude install and claude restore")
	}
	return { harness: "claude", operation, apply, json, noInput }
}

function parseCodex(arguments_: string[]): CodexInvocation {
	const operation = arguments_[0] as "check" | "install" | undefined
	if (!operation || !["check", "install"].includes(operation)) {
		throw new UsageError("codex requires check or install")
	}
	let apply = false
	let expectedCandidateHash: string | undefined
	let launch = operation === "install"
	let noLaunch = false
	let json = false
	let noInput = false
	const seen = new Set<string>()
	for (let index = 1; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (seen.has(argument)) throw new UsageError(`${argument} may be provided once`)
		seen.add(argument)
		switch (argument) {
			case "--apply":
				apply = true
				break
			case "--candidate-hash":
				expectedCandidateHash = arguments_[index + 1]
				if (!expectedCandidateHash || expectedCandidateHash.startsWith("--")) {
					throw new UsageError("--candidate-hash requires one SHA-256 value")
				}
				index += 1
				break
			case "--no-launch":
				launch = false
				noLaunch = true
				break
			case "--json":
				json = true
				break
			case "--no-input":
				noInput = true
				break
			default:
				throw new UsageError(`unknown Codex option: ${argument}`)
		}
	}
	if (operation === "check" && (apply || expectedCandidateHash || noLaunch)) {
		throw new UsageError("Codex check supports only --json and --no-input")
	}
	if (operation === "install" && apply !== Boolean(expectedCandidateHash)) {
		throw new UsageError("Codex install --apply requires --candidate-hash, and the hash requires --apply")
	}
	if (expectedCandidateHash && !/^[a-f0-9]{64}$/.test(expectedCandidateHash)) {
		throw new UsageError("Codex --candidate-hash must be one lowercase SHA-256 value")
	}
	if (noInput) launch = false
	return {
		harness: "codex",
		operation,
		apply,
		expectedCandidateHash,
		launch,
		json,
		noInput,
	}
}

function parseInvocation(arguments_: string[]): Invocation {
	const harness = arguments_[0] as HarnessId | undefined
	if (!harness || !Object.hasOwn(HARNESS_IDENTITIES, harness)) {
		throw new UsageError("expected the claude or codex harness")
	}
	return harness === QUALIFICATION_CLIENT_HARNESSES["claude-cli"]
		? parseClaude(arguments_.slice(1))
		: parseCodex(arguments_.slice(1))
}

function run(command: string[], environment = process.env): void {
	const result = Bun.spawnSync({
		cmd: command,
		cwd: root,
		env: environment,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	})
	if (result.exitCode !== 0) process.exit(result.exitCode)
}

function developmentFailure(
	runId: string,
	invocation: Invocation,
	error: ClaudeDevelopmentInstallationError | CodexDevelopmentInstallationError,
): Record<string, unknown> {
	const action: ClaudeDevelopmentErrorAction | CodexDevelopmentErrorAction = error.action
	return {
		schemaVersion: 1,
		contractId: "plugin.development-installation",
		runId,
		ok: false,
		harness: invocation.harness,
		operation: invocation.operation,
		mode:
			invocation.operation === "check"
				? "inspect"
				: invocation.harness === "claude" && invocation.operation === "watch"
					? "watch"
					: invocation.apply
						? "apply"
						: "preview",
		changed: error.changed,
		transactionState: error.transactionState,
		retrySafety: error.retrySafety,
		sideEffects: error.sideEffects,
		error: {
			name: error.name,
			code: error.code,
			action,
			retryable: error.retrySafety === "safe",
			errorFamily: error.errorFamily,
			hintVersion: 1,
			severity: error.transactionState === "unknown" ? "critical" : "error",
			recoverability:
				error.transactionState === "unknown"
					? "inspect"
					: error.retrySafety === "safe"
						? "retry"
						: "manual",
			safeToRetrySameInput: error.retrySafety === "safe",
		},
		message: error.message,
		nextAction: error.nextAction,
	}
}

async function main(arguments_: string[]): Promise<number> {
	if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "-h") {
		process.stdout.write(topLevelHelp)
		return 0
	}
	if (
		arguments_[0] === QUALIFICATION_CLIENT_HARNESSES["claude-cli"] &&
		(arguments_.length === 1 || arguments_.includes("--help") || arguments_.includes("-h"))
	) {
		process.stdout.write(claudeHelp)
		return 0
	}
	if (
		arguments_[0] === QUALIFICATION_CLIENT_HARNESSES["codex-cli"] &&
		(arguments_.includes("--help") || arguments_.includes("-h"))
	) {
		process.stdout.write(codexHelp)
		return 0
	}

	const runId = randomUUID()
	let invocation: Invocation
	try {
		invocation = parseInvocation(arguments_)
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid command usage"
		process.stderr.write(`dev: ${message}\n`)
		return 2
	}

	if (invocation.harness === QUALIFICATION_CLIENT_HARNESSES["claude-cli"]) {
		try {
			const output = await runClaudeDevelopmentInstallation({
				operation: invocation.operation,
				apply: invocation.apply,
				runId,
				repositoryRoot: root,
				environment: process.env,
			})
			if (invocation.json) process.stdout.write(`${JSON.stringify(output)}\n`)
			else process.stdout.write(`${output.transactionState}: ${output.nextAction}\n`)
			return 0
		} catch (error) {
			const failure =
				error instanceof ClaudeDevelopmentInstallationError
					? error
					: new ClaudeDevelopmentInstallationError(
							"INTERNAL_FAILURE",
							"Unexpected development lifecycle failure; native state was not proven",
							{
								action: "ESCALATE",
								errorFamily: "internal",
								retrySafety: "inspect_required",
								nextAction:
									"Report this run id with the command that produced it; the lifecycle proved no native state.",
							},
						)
			if (invocation.json)
				process.stdout.write(`${JSON.stringify(developmentFailure(runId, invocation, failure))}\n`)
			process.stderr.write(`dev: ${failure.code}: ${failure.message} [run ${runId}]\n`)
			return 1
		}
	}

	try {
		const output = runCodexDevelopmentInstallation({
			operation: invocation.operation,
			apply: invocation.apply,
			expectedCandidateHash: invocation.expectedCandidateHash,
			runId,
			repositoryRoot: root,
			environment: process.env,
		})
		if (invocation.json) process.stdout.write(`${JSON.stringify(output)}\n`)
		else process.stdout.write(`${output.transactionState}: ${output.nextAction}\n`)
		if (invocation.apply && output.transactionState === "installed" && invocation.launch) {
			run(["codex"])
		}
		return 0
	} catch (error) {
		const failure =
			error instanceof CodexDevelopmentInstallationError
				? error
				: new CodexDevelopmentInstallationError(
						"INTERNAL_FAILURE",
						"Unexpected Codex development lifecycle failure; native state was not proven",
						{
							action: "ESCALATE",
							errorFamily: "internal",
							retrySafety: "inspect_required",
							nextAction:
								"Report this run id with the command that produced it; the lifecycle proved no native state.",
						},
					)
		if (invocation.json)
			process.stdout.write(`${JSON.stringify(developmentFailure(runId, invocation, failure))}\n`)
		process.stderr.write(`dev: ${failure.code}: ${failure.message} [run ${runId}]\n`)
		return 1
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
