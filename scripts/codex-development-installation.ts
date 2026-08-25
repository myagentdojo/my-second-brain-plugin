import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { copyPluginPayload, payloadInventorySha256 } from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"

type CodexDevelopmentOperation = "check" | "install"
type CodexDevelopmentMode = "inspect" | "preview" | "apply"
export type CodexDevelopmentErrorAction = "FIX_INPUT" | "INSPECT_STATE" | "ESCALATE"
type CodexDevelopmentErrorFamily = "conflict" | "protocol" | "runtime" | "verification" | "internal"

interface CodexMarketplaceList {
	marketplaces: Array<{ name: string; root: string }>
}

interface CodexInstalledPlugin {
	pluginId: string
	name: string
	marketplaceName: string
	version: string
	installed: boolean
	enabled: boolean
	source: { source: string; path: string }
	marketplaceSource?: { sourceType: string; source: string }
}

interface CodexPluginList {
	installed: CodexInstalledPlugin[]
	available?: unknown[]
}

interface CodexDevelopmentCandidate {
	pluginId: string
	supersededPluginId: string
	version: string
	payloadHash: string
	candidateHash: string
	marketplaceRoot: string
	sourcePath: string
}

type PreparedCodexDevelopmentCandidate = Omit<CodexDevelopmentCandidate, "candidateHash">

type CodexDevelopmentSideEffect =
	| "development_marketplace_added"
	| "development_plugin_installed"
	| "superseded_development_plugin_removed"

interface CodexDevelopmentPlanOperation {
	kind: "marketplace_add" | "plugin_add" | "plugin_remove"
	command: readonly string[]
	label: string
	sideEffect: CodexDevelopmentSideEffect
}

interface CodexDevelopmentCurrent {
	development: "absent" | "marketplace-only" | "installed"
	pluginId?: string
	version?: string
	enabled?: boolean
	marketplaceRoot?: string
	sourcePath?: string
	candidateCurrent: boolean
	supersededIdentityPresent: boolean
}

export interface CodexDevelopmentInstallationInput {
	operation: CodexDevelopmentOperation
	apply: boolean
	expectedCandidateHash?: string
	runId: string
	repositoryRoot: string
	environment: Record<string, string | undefined>
}

export interface CodexDevelopmentInstallationResult {
	schemaVersion: 1
	contractId: "plugin.development-installation"
	runId: string
	ok: true
	harness: "codex"
	operation: CodexDevelopmentOperation
	mode: CodexDevelopmentMode
	changed: boolean
	transactionState: "ready" | "previewed" | "no_op" | "installed"
	retrySafety: "safe"
	candidate: CodexDevelopmentCandidate
	current: CodexDevelopmentCurrent
	plan: string[]
	sideEffects: string[]
	nextAction: string
}

export class CodexDevelopmentInstallationError extends Error {
	readonly code: string
	readonly action: CodexDevelopmentErrorAction
	readonly errorFamily: CodexDevelopmentErrorFamily
	readonly changed: boolean
	readonly transactionState: "blocked" | "unknown"
	readonly retrySafety: "safe" | "inspect_required"
	readonly sideEffects: string[]
	readonly nextAction: string

	constructor(
		code: string,
		message: string,
		options: {
			action?: CodexDevelopmentErrorAction
			errorFamily?: CodexDevelopmentErrorFamily
			changed?: boolean
			transactionState?: "blocked" | "unknown"
			retrySafety?: "safe" | "inspect_required"
			sideEffects?: string[]
			nextAction: string
		},
	) {
		super(message)
		this.name = "CodexDevelopmentInstallationError"
		this.code = code
		const hint = codexErrorHint(code)
		this.action = options.action ?? hint.action
		this.errorFamily = options.errorFamily ?? hint.errorFamily
		this.changed = options.changed ?? false
		this.transactionState = options.transactionState ?? "blocked"
		this.retrySafety = options.retrySafety ?? "safe"
		this.sideEffects = options.sideEffects ?? []
		this.nextAction = options.nextAction
	}
}

function codexErrorHint(code: string): {
	action: CodexDevelopmentErrorAction
	errorFamily: CodexDevelopmentErrorFamily
} {
	switch (code) {
		case "CODEX_DEVELOPMENT_CANDIDATE_CHANGED":
			return { action: "FIX_INPUT", errorFamily: "conflict" }
		case "CODEX_OUTPUT_INVALID":
			return { action: "INSPECT_STATE", errorFamily: "protocol" }
		case "CODEX_DEVELOPMENT_VERIFICATION_FAILED":
			return { action: "INSPECT_STATE", errorFamily: "verification" }
		case "CODEX_COMMAND_FAILED":
		case "CODEX_DEVELOPMENT_APPLY_FAILED":
			return { action: "FIX_INPUT", errorFamily: "runtime" }
		case "CODEX_DEVELOPMENT_IDENTITY_AMBIGUOUS":
		case "CODEX_DEVELOPMENT_MARKETPLACE_MISMATCH":
		case "CODEX_DEVELOPMENT_STATE_INCOMPLETE":
			return { action: "INSPECT_STATE", errorFamily: "conflict" }
		default:
			return { action: "ESCALATE", errorFamily: "internal" }
	}
}

function command(
	arguments_: string[],
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
	label: string,
): string {
	const result = Bun.spawnSync({
		cmd: arguments_,
		cwd: repositoryRoot,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) {
		throw new CodexDevelopmentInstallationError(
			"CODEX_COMMAND_FAILED",
			`${label} failed with exit code ${result.exitCode}`,
			{
				nextAction: "Run the reported Codex command directly, repair its native error, then inspect again.",
			},
		)
	}
	return result.stdout.toString()
}

function jsonCommand<T>(
	arguments_: string[],
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
	label: string,
): T {
	const stdout = command(arguments_, repositoryRoot, environment, label)
	try {
		return JSON.parse(stdout) as T
	} catch {
		throw new CodexDevelopmentInstallationError(
			"CODEX_OUTPUT_INVALID",
			`${label} did not return one JSON document`,
			{
				nextAction: "Run the reported Codex inspection directly and confirm its JSON contract before retrying.",
			},
		)
	}
}

function build(repositoryRoot: string, environment: Record<string, string | undefined>): void {
	command(["bun", "run", "build"], repositoryRoot, environment, "Plugin Payload build")
}

function prepareCandidate(repositoryRoot: string): PreparedCodexDevelopmentCandidate {
	const pluginConfig = loadPluginConfig(repositoryRoot)
	const pluginName = pluginConfig.name
	const developmentPluginName = `${pluginName}-dev`
	const marketplaceRoot = join(repositoryRoot, ".dev", "codex-marketplace")
	const sourcePath = join(marketplaceRoot, "plugins", developmentPluginName)
	const supersededSourcePath = join(marketplaceRoot, "plugins", pluginName)

	rmSync(supersededSourcePath, { recursive: true, force: true })
	rmSync(sourcePath, { recursive: true, force: true })
	mkdirSync(sourcePath, { recursive: true })
	const inventory = copyPluginPayload(repositoryRoot, sourcePath)
	const sourcePayloadHash = payloadInventorySha256(sourcePath, inventory)
	const version = `${pluginConfig.version}+codex.local-${sourcePayloadHash.slice(0, 12)}`

	const manifestPath = join(sourcePath, ".codex-plugin", "plugin.json")
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
	manifest.name = developmentPluginName
	manifest.version = version
	manifest.interface = {
		...manifest.interface,
		displayName: `${pluginConfig.displayName} Dev`,
	}
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
	const payloadHash = payloadInventorySha256(sourcePath, inventory)

	const marketplace = {
		name: developmentPluginName,
		interface: { displayName: `${pluginConfig.displayName} Dev` },
		plugins: [
			{
				name: developmentPluginName,
				source: { source: "local", path: `./plugins/${developmentPluginName}` },
				policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
				category: "Developer Tools",
			},
		],
	}
	const marketplacePath = join(marketplaceRoot, ".agents", "plugins", "marketplace.json")
	mkdirSync(join(marketplaceRoot, ".agents", "plugins"), { recursive: true })
	writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)

	return {
		pluginId: `${developmentPluginName}@${developmentPluginName}`,
		supersededPluginId: `${pluginName}@${developmentPluginName}`,
		version,
		payloadHash,
		marketplaceRoot: resolve(marketplaceRoot),
		sourcePath: resolve(sourcePath),
	}
}

function inspect(
	input: CodexDevelopmentInstallationInput,
	candidate: PreparedCodexDevelopmentCandidate,
): CodexDevelopmentCurrent {
	const pluginName = loadPluginConfig(input.repositoryRoot).name
	const developmentMarketplaceName = `${pluginName}-dev`
	const supersededPluginId = candidate.supersededPluginId
	const marketplaces = jsonCommand<CodexMarketplaceList>(
		["codex", "plugin", "marketplace", "list", "--json"],
		input.repositoryRoot,
		input.environment,
		"Codex Marketplace inspection",
	).marketplaces.filter((entry) => entry.name === developmentMarketplaceName)
	const installed = jsonCommand<CodexPluginList>(
		["codex", "plugin", "list", "--json"],
		input.repositoryRoot,
		input.environment,
		"Codex Plugin Installation inspection",
	).installed
	const plugins = installed.filter(
		(entry) => entry.pluginId === candidate.pluginId || entry.pluginId === supersededPluginId,
	)
	const candidatePlugins = plugins.filter((entry) => entry.pluginId === candidate.pluginId)
	if (marketplaces.length > 1 || candidatePlugins.length > 1) {
		throw new CodexDevelopmentInstallationError(
			"CODEX_DEVELOPMENT_IDENTITY_AMBIGUOUS",
			"Codex reported more than one matching development identity",
			{
				nextAction: "Inspect Codex marketplaces and Plugin Installations, then reconcile the duplicate development identity.",
			},
		)
	}
	const marketplace = marketplaces[0]
	const plugin = candidatePlugins[0]
	if (marketplace && resolve(marketplace.root) !== candidate.marketplaceRoot) {
		throw new CodexDevelopmentInstallationError(
			"CODEX_DEVELOPMENT_MARKETPLACE_MISMATCH",
			`The ${developmentMarketplaceName} Marketplace belongs to ${marketplace.root}, not ${candidate.marketplaceRoot}`,
			{
				nextAction: "Use the owning checkout or remove its development installation before selecting this checkout.",
			},
		)
	}
	if (plugin && !marketplace) {
		throw new CodexDevelopmentInstallationError(
			"CODEX_DEVELOPMENT_STATE_INCOMPLETE",
			"Codex reports the development Plugin Installation without its Marketplace",
			{
				nextAction: "Inspect the Codex profile and reconcile the incomplete development identity before retrying.",
			},
		)
	}
	if (
		plugin &&
		(!plugin.installed ||
			plugin.name !== `${pluginName}-dev` ||
			plugin.marketplaceName !== developmentMarketplaceName)
	) {
		throw new CodexDevelopmentInstallationError(
			"CODEX_DEVELOPMENT_IDENTITY_AMBIGUOUS",
			"Codex reported contradictory development Plugin Installation identity",
			{
				nextAction: "Inspect the Codex Plugin Installation and reconcile its identity before retrying.",
			},
		)
	}

	const sourcePath = plugin?.source?.path ? resolve(plugin.source.path) : undefined
	const candidateCurrent = Boolean(
		plugin &&
			marketplace &&
			plugin.enabled &&
			plugin.version === candidate.version &&
			sourcePath === candidate.sourcePath,
	)
	return {
		development: plugin ? "installed" : marketplace ? "marketplace-only" : "absent",
		...(plugin
			? {
					pluginId: plugin.pluginId,
					version: plugin.version,
					enabled: plugin.enabled,
					sourcePath,
				}
			: {}),
		...(marketplace ? { marketplaceRoot: resolve(marketplace.root) } : {}),
		candidateCurrent,
		supersededIdentityPresent: plugins.some((entry) => entry.pluginId === supersededPluginId),
	}
}

function operationPlan(
	current: CodexDevelopmentCurrent,
	candidate: PreparedCodexDevelopmentCandidate,
): CodexDevelopmentPlanOperation[] {
	if (current.candidateCurrent && !current.supersededIdentityPresent) return []
	const operations: CodexDevelopmentPlanOperation[] = []
	if (current.development === "absent") {
		operations.push({
			kind: "marketplace_add",
			command: ["codex", "plugin", "marketplace", "add", candidate.marketplaceRoot],
			label: "Codex development Marketplace add",
			sideEffect: "development_marketplace_added",
		})
	}
	operations.push({
		kind: "plugin_add",
		command: ["codex", "plugin", "add", candidate.pluginId, "--json"],
		label: "Codex development Plugin install",
		sideEffect: "development_plugin_installed",
	})
	if (current.supersededIdentityPresent) {
		operations.push({
			kind: "plugin_remove",
			command: ["codex", "plugin", "remove", candidate.supersededPluginId, "--json"],
			label: "Codex superseded development Plugin removal",
			sideEffect: "superseded_development_plugin_removed",
		})
	}
	return operations
}

function renderPlan(operations: readonly CodexDevelopmentPlanOperation[]): string[] {
	return operations.map((operation) => operation.command.join(" "))
}

function candidateHash(
	candidate: PreparedCodexDevelopmentCandidate,
	operations: readonly CodexDevelopmentPlanOperation[],
): string {
	const hash = createHash("sha256")
	hash.update("codex-development-candidate-v1\0")
	hash.update(candidate.payloadHash)
	for (const operation of operations) {
		hash.update("\0")
		hash.update(JSON.stringify([operation.kind, operation.command]))
	}
	return hash.digest("hex")
}

function executePlan(
	operations: readonly CodexDevelopmentPlanOperation[],
	input: CodexDevelopmentInstallationInput,
): string[] {
	const sideEffects: string[] = []
	for (const operation of operations) {
		try {
			command([...operation.command], input.repositoryRoot, input.environment, operation.label)
		} catch (error) {
			const message = error instanceof Error ? error.message : `${operation.label} failed`
			throw new CodexDevelopmentInstallationError("CODEX_DEVELOPMENT_APPLY_FAILED", message, {
				action: "INSPECT_STATE",
				errorFamily: "runtime",
				changed: true,
				transactionState: "unknown",
				retrySafety: "inspect_required",
				sideEffects,
				nextAction: "Inspect the Codex development state before deciding whether to retry.",
			})
		}
		sideEffects.push(operation.sideEffect)
	}
	return sideEffects
}

function baseResult(
	input: CodexDevelopmentInstallationInput,
	candidate: CodexDevelopmentCandidate,
	current: CodexDevelopmentCurrent,
	mode: CodexDevelopmentMode,
	transactionState: CodexDevelopmentInstallationResult["transactionState"],
	options: { changed?: boolean; plan?: string[]; sideEffects?: string[]; nextAction: string },
): CodexDevelopmentInstallationResult {
	return {
		schemaVersion: 1,
		contractId: "plugin.development-installation",
		runId: input.runId,
		ok: true,
		harness: "codex",
		operation: input.operation,
		mode,
		changed: options.changed ?? false,
		transactionState,
		retrySafety: "safe",
		candidate,
		current,
		plan: options.plan ?? [],
		sideEffects: options.sideEffects ?? [],
		nextAction: options.nextAction,
	}
}

export function runCodexDevelopmentInstallation(
	input: CodexDevelopmentInstallationInput,
): CodexDevelopmentInstallationResult {
	build(input.repositoryRoot, input.environment)
	const preparedCandidate = prepareCandidate(input.repositoryRoot)
	const current = inspect(input, preparedCandidate)
	const operations = operationPlan(current, preparedCandidate)
	const commands = renderPlan(operations)
	const candidate: CodexDevelopmentCandidate = {
		...preparedCandidate,
		candidateHash: candidateHash(preparedCandidate, operations),
	}

	if (input.operation === "check") {
		return baseResult(input, candidate, current, "inspect", "ready", {
			plan: commands,
			nextAction:
				commands.length === 0
					? "The exact Codex Development Installation is current. Start a fresh Codex task to load it."
					: "Run `bun run dev -- codex install --json --no-input --no-launch` to preview the exact staged reinstall.",
		})
	}
	if (commands.length === 0) {
		return baseResult(input, candidate, current, input.apply ? "apply" : "preview", "no_op", {
			nextAction: "The exact Codex Development Installation is current. Start a fresh Codex task to load it.",
		})
	}
	if (!input.apply) {
		return baseResult(input, candidate, current, "preview", "previewed", {
			plan: commands,
			nextAction: `Review this exact plan, then run \`bun run dev -- codex install --apply --candidate-hash ${candidate.candidateHash} --json --no-input --no-launch\`.`,
		})
	}
	if (input.expectedCandidateHash !== candidate.candidateHash) {
		throw new CodexDevelopmentInstallationError(
			"CODEX_DEVELOPMENT_CANDIDATE_CHANGED",
			"The staged Plugin Payload or operation plan differs from the approved preview",
			{
				nextAction: "Run the Codex install preview again and approve its new candidate hash.",
			},
		)
	}

	let sideEffects: string[] = []
	try {
		sideEffects = executePlan(operations, input)
		const resulting = inspect(input, candidate)
		if (!resulting.candidateCurrent || resulting.supersededIdentityPresent) {
			throw new CodexDevelopmentInstallationError(
				"CODEX_DEVELOPMENT_VERIFICATION_FAILED",
				"Codex did not report the exact enabled staged Development Installation",
				{
					changed: true,
					transactionState: "unknown",
					retrySafety: "inspect_required",
					sideEffects,
					nextAction: "Run the Codex development check and inspect the reported native identity before retrying.",
				},
			)
		}
		return baseResult(input, candidate, resulting, "apply", "installed", {
			changed: true,
			plan: commands,
			sideEffects,
			nextAction: "Start a fresh Codex task so the harness loads the verified Development Installation.",
		})
	} catch (error) {
		if (error instanceof CodexDevelopmentInstallationError && error.changed) throw error
		const message = error instanceof Error ? error.message : "Codex development mutation failed"
		throw new CodexDevelopmentInstallationError("CODEX_DEVELOPMENT_APPLY_FAILED", message, {
			changed: sideEffects.length > 0,
			transactionState: sideEffects.length > 0 ? "unknown" : "blocked",
			retrySafety: sideEffects.length > 0 ? "inspect_required" : "safe",
			sideEffects,
			nextAction: "Run the Codex development check and inspect the reported native identity before retrying.",
		})
	}
}
