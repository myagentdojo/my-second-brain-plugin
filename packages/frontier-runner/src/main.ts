import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const schemaVersion = 1
const receiptSchemaVersion = 1
const maximumPromptBytes = 32 * 1024
const unitIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const runIdPattern = /^fr-[a-f0-9]{16}$/
const sha256Pattern = /^[a-f0-9]{64}$/
const completedStatuses = new Set(["idle", "done"])
const agentStatuses = new Set(["idle", "working", "blocked", "done", "unknown"])
const promptUncertainCodes = new Set(["timeout", "agent_prompt_stalled"])
const effectOutcomeValues = ["planned", "unknown", "succeeded", "timed_out", "failed"] as const
const effectOutcomes = new Set<string>(effectOutcomeValues)
const runStateValues = [
	"prepared",
	"starting",
	"timed_out",
	"settled_unproved",
	"completed",
	"cleanup_pending",
	"cleaned",
	"failed",
] as const
const runStates = new Set<string>(runStateValues)
const initialEffectNames = [
	"editorPane",
	"editorLaunch",
	"browserPane",
	"browserLaunch",
	"workerPane",
	"workerStart",
	"promptDispatch",
] as const
const effectNameValues = [
	...initialEffectNames,
	"resumeWait",
	"workerPaneClose",
	"browserPaneClose",
	"editorPaneClose",
	"cleanupComplete",
] as const
const effectNames = new Set<string>(effectNameValues)

type CommandName = "run" | "resume" | "cleanup" | "unknown"
type EffectOutcome = (typeof effectOutcomeValues)[number]
type EffectName = (typeof effectNameValues)[number]
type RunState = (typeof runStateValues)[number]

interface EffectRecord {
	outcome: EffectOutcome
	observedAt: string
	code?: string
}

interface Receipt {
	schemaVersion: number
	runId: string
	unitId: string
	requestHash: string
	state: RunState
	createdAt: string
	updatedAt: string
	workspace: {
		path: string
		workspaceId: string
		tabId: string
		callerPaneId: string
	}
	inputs: {
		promptSha256: string
		browserUrlSha256: string
		resultFile: string
		resultBeforeSha256: string
		timeoutMs: number
	}
	resources: {
		workerName: string
		editorPaneId?: string
		browserPaneId?: string
		workerPaneId?: string
	}
	effects: Partial<Record<EffectName, EffectRecord>>
	observation?: {
		agentStatus?: string
		resultSha256?: string
		resultMarkerSha256?: string
	}
}

interface ParsedFlags {
	values: Map<string, string>
}

interface HerdrResult {
	exitCode: number
	stdout: string
	stderr: string
	json?: Record<string, unknown>
	errorCode?: string
}

interface CurrentPane {
	paneId: string
	workspaceId: string
	tabId: string
	foregroundCwd: string
}

interface AgentObservation {
	paneId: string
	status: string
}

interface ResultEnvelope {
	schemaVersion: number
	ok: boolean
	command: CommandName
	code: string
	runId?: string
	state?: RunState
	changedState: "none" | "partial" | "complete"
	sideEffects: string[]
	retrySafe: boolean
	nextAction: string
}

class FrontierError extends Error {
	readonly code: string
	readonly exitCode: number
	readonly runId?: string
	readonly state?: RunState
	readonly changedState: ResultEnvelope["changedState"]
	readonly sideEffects: string[]
	readonly retrySafe: boolean
	readonly nextAction: string

	constructor(options: {
		message: string
		code: string
		exitCode?: number
		runId?: string
		state?: RunState
		changedState?: ResultEnvelope["changedState"]
		sideEffects?: string[]
		retrySafe?: boolean
		nextAction: string
	}) {
		super(options.message)
		this.name = "FrontierError"
		this.code = options.code
		this.exitCode = options.exitCode ?? 1
		this.runId = options.runId
		this.state = options.state
		this.changedState = options.changedState ?? "none"
		this.sideEffects = options.sideEffects ?? []
		this.retrySafe = options.retrySafe ?? false
		this.nextAction = options.nextAction
	}
}

function help(): string {
	return `Frontier Runner - one receipt-backed Herdr worker run

Usage:
  frontier-runner run --unit-id ID --workspace PATH --prompt-file PATH \\
    --timeout-ms MS --browser-url URL --result-file RELATIVE_PATH
  frontier-runner resume --run-id ID
  frontier-runner cleanup --run-id ID
  frontier-runner --help

Commands:
  run      Create one Terminal Code pane, one Chromium pane, and one Codex worker.
  resume   Reconcile the recorded worker after timeout without resending the prompt.
  cleanup  Close only the panes recorded as owned by this run.

Output:
  Commands emit one schema-versioned JSON object on stdout. Diagnostics use stderr.
`
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex")
}

function now(): string {
	return new Date().toISOString()
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
	const value = record?.[field]
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function parseJson(text: string): Record<string, unknown> | undefined {
	try {
		return jsonObject(JSON.parse(text))
	} catch {
		return undefined
	}
}

function parseHerdrErrorCode(stderr: string): string | undefined {
	for (const line of stderr.trim().split(/\r?\n/).reverse()) {
		const parsed = parseJson(line)
		const error = jsonObject(parsed?.error)
		const code = stringField(error, "code")
		if (code) return code
	}
	return undefined
}

function emit(envelope: ResultEnvelope): void {
	process.stdout.write(`${JSON.stringify(envelope)}\n`)
}

function emitFailure(command: CommandName, error: FrontierError): never {
	process.stderr.write(`frontier-runner: ${error.message}\nrepair: ${error.nextAction}\n`)
	emit({
		schemaVersion,
		ok: false,
		command,
		code: error.code,
		runId: error.runId,
		state: error.state,
		changedState: error.changedState,
		sideEffects: error.sideEffects,
		retrySafe: error.retrySafe,
		nextAction: error.nextAction,
	})
	process.exit(error.exitCode)
}

function parseFlags(arguments_: string[], admitted: readonly string[]): ParsedFlags {
	const admittedSet = new Set(admitted)
	const values = new Map<string, string>()
	for (let index = 0; index < arguments_.length; index += 2) {
		const flag = arguments_[index]
		const value = arguments_[index + 1]
		if (!flag?.startsWith("--") || !admittedSet.has(flag)) {
			throw new FrontierError({
				message: `unknown option: ${flag ?? "<missing>"}`,
				code: "USAGE",
				exitCode: 2,
				nextAction: "Run frontier-runner --help and use only the documented flags.",
			})
		}
		if (value === undefined || value.startsWith("--")) {
			throw new FrontierError({
				message: `missing value for ${flag}`,
				code: "USAGE",
				exitCode: 2,
				nextAction: `Supply one value after ${flag}.`,
			})
		}
		if (values.has(flag)) {
			throw new FrontierError({
				message: `duplicate option: ${flag}`,
				code: "USAGE",
				exitCode: 2,
				nextAction: `Supply ${flag} exactly once.`,
			})
		}
		values.set(flag, value)
	}
	return { values }
}

function requiredFlag(flags: ParsedFlags, flag: string): string {
	const value = flags.values.get(flag)
	if (!value) {
		throw new FrontierError({
			message: `required option is missing: ${flag}`,
			code: "USAGE",
			exitCode: 2,
			nextAction: `Run frontier-runner --help and supply ${flag}.`,
		})
	}
	return value
}

function canonicalDirectory(input: string): string {
	if (!existsSync(input) || !statSync(input).isDirectory()) {
		throw new FrontierError({
			message: `workspace is not an existing directory: ${input}`,
			code: "WORKSPACE_INVALID",
			exitCode: 2,
			nextAction: "Supply one explicitly granted existing workspace directory.",
		})
	}
	return realpathSync(input)
}

function isSafeRelativeResultPath(input: string): boolean {
	if (input.length === 0 || isAbsolute(input) || /[\r\n\u2028\u2029]/.test(input)) return false
	const normalized = input.split(/[\\/]/)
	return normalized.every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function canonicalResultFile(workspace: string, input: string): { path: string; relativePath: string } {
	if (!isSafeRelativeResultPath(input)) {
		throw new FrontierError({
			message: "result file must be a safe workspace-relative path without line breaks or traversal",
			code: "RESULT_FILE_INVALID",
			exitCode: 2,
			nextAction: "Pass the existing fixture file as a relative path inside the granted workspace.",
		})
	}
	const candidate = resolve(workspace, input)
	if (!existsSync(candidate) || !statSync(candidate).isFile()) {
		throw new FrontierError({
			message: `result file is not an existing regular file: ${input}`,
			code: "RESULT_FILE_INVALID",
			exitCode: 2,
			nextAction: "Create the disposable fixture file inside the workspace, then retry.",
		})
	}
	const path = realpathSync(candidate)
	const relativePath = relative(workspace, path)
	if (!isSafeRelativeResultPath(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
		throw new FrontierError({
			message: "result file resolves outside the granted workspace",
			code: "RESULT_FILE_INVALID",
			exitCode: 2,
			nextAction: "Use a non-escaping fixture file inside the granted workspace.",
		})
	}
	return { path, relativePath }
}

function promptBytes(path: string): Uint8Array {
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new FrontierError({
			message: `prompt file is not an existing regular file: ${path}`,
			code: "PROMPT_INVALID",
			exitCode: 2,
			nextAction: "Write the bounded prompt to a file and pass that file path.",
		})
	}
	const bytes = readFileSync(path)
	if (bytes.length === 0 || bytes.length > maximumPromptBytes) {
		throw new FrontierError({
			message: `prompt must contain 1 to ${maximumPromptBytes} bytes`,
			code: "PROMPT_INVALID",
			exitCode: 2,
			nextAction: "Use one non-empty bounded prompt no larger than 32 KiB.",
		})
	}
	return bytes
}

function timeoutValue(input: string): number {
	if (!/^[1-9][0-9]*$/.test(input)) {
		throw new FrontierError({
			message: "timeout must be a positive integer in milliseconds",
			code: "TIMEOUT_INVALID",
			exitCode: 2,
			nextAction: "Supply --timeout-ms between 1 and 3600000.",
		})
	}
	const value = Number(input)
	if (!Number.isSafeInteger(value) || value > 3_600_000) {
		throw new FrontierError({
			message: "timeout is outside the supported range",
			code: "TIMEOUT_INVALID",
			exitCode: 2,
			nextAction: "Supply --timeout-ms between 1 and 3600000.",
		})
	}
	return value
}

function browserUrl(input: string): URL {
	let parsed: URL
	try {
		parsed = new URL(input)
	} catch {
		throw new FrontierError({
			message: "browser URL is invalid",
			code: "BROWSER_URL_INVALID",
			exitCode: 2,
			nextAction: "Supply one explicit http or https URL.",
		})
	}
	if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
		throw new FrontierError({
			message: `browser URL protocol is unsupported: ${parsed.protocol}`,
			code: "BROWSER_URL_INVALID",
			exitCode: 2,
			nextAction: "Supply one explicit http or https URL.",
		})
	}
	return parsed
}

function requireInsideHerdr(): void {
	if (process.env.HERDR_ENV !== "1") {
		throw new FrontierError({
			message: "this command is not running inside Herdr",
			code: "HERDR_REQUIRED",
			nextAction: "Invoke Frontier Runner from a Herdr-managed pane.",
		})
	}
	for (const variable of ["HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"]) {
		if (!process.env[variable]) {
			throw new FrontierError({
				message: `Herdr caller context is missing: ${variable}`,
				code: "HERDR_CONTEXT_MISSING",
				nextAction: "Invoke from a live Herdr-managed pane process, then retry.",
			})
		}
	}
}

function requireTools(tools: readonly string[]): void {
	for (const tool of tools) {
		if (!Bun.which(tool)) {
			throw new FrontierError({
				message: `required command is missing: ${tool}`,
				code: "TOOL_MISSING",
				nextAction: `Install or expose ${tool} on PATH inside Herdr, then retry.`,
			})
		}
	}
}

function proveToolContract(tool: "tode" | "terminal-browser", expected: RegExp, workspace: string): void {
	const result = Bun.spawnSync({
		cmd: [tool, "--help"],
		cwd: workspace,
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	})
	const helpText = `${result.stdout.toString()}\n${result.stderr.toString()}`
	if (result.exitCode !== 0 || !expected.test(helpText)) {
		throw new FrontierError({
			message: `installed ${tool} does not expose the required launch contract`,
			code: "TOOL_INCOMPATIBLE",
			nextAction:
				tool === "tode"
					? "Install a Terminal Code version whose help supports opening the current folder, then retry."
					: "Install a Terminal Browser version whose help supports `open <url>`, then retry.",
		})
	}
}

function runHerdr(arguments_: string[], cwd: string): HerdrResult {
	const result = Bun.spawnSync({
		cmd: ["herdr", ...arguments_],
		cwd,
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	})
	const stdout = result.stdout.toString()
	const stderr = result.stderr.toString()
	return {
		exitCode: result.exitCode ?? 1,
		stdout,
		stderr,
		json: parseJson(stdout.trim()),
		errorCode: parseHerdrErrorCode(stderr),
	}
}

function requireHerdrSuccess(result: HerdrResult, code: string, repair: string): Record<string, unknown> {
	if (result.exitCode !== 0) {
		throw new FrontierError({
			message: `Herdr command failed${result.errorCode ? `: ${result.errorCode}` : ""}`,
			code,
			nextAction: repair,
		})
	}
	if (!result.json) {
		throw new FrontierError({
			message: "Herdr returned malformed JSON",
			code: "HERDR_PROTOCOL_INVALID",
			nextAction: "Run the relevant Herdr command directly and verify client/server compatibility.",
		})
	}
	return result.json
}

function herdrResponseResult(result: HerdrResult, expectedType: string): Record<string, unknown> | undefined {
	if (result.exitCode !== 0 || !result.json) return undefined
	const response = jsonObject(result.json.result)
	return stringField(response, "type") === expectedType ? response : undefined
}

function paneRunAccepted(result: HerdrResult): boolean {
	if (result.exitCode !== 0) return false
	if (result.stdout.trim() === "" && result.stderr.trim() === "") return true
	return Boolean(herdrResponseResult(result, "ok"))
}

function responsePaneMatches(
	response: Record<string, unknown> | undefined,
	expected: { paneId?: string; workspaceId: string; tabId: string },
): response is Record<string, unknown> {
	const pane = jsonObject(response?.pane)
	const paneId = stringField(pane, "pane_id")
	return Boolean(
		paneId &&
			(expected.paneId === undefined || paneId === expected.paneId) &&
			stringField(pane, "workspace_id") === expected.workspaceId &&
			stringField(pane, "tab_id") === expected.tabId,
	)
}

function responseAgentMatches(
	response: Record<string, unknown> | undefined,
	receipt: Receipt,
): response is Record<string, unknown> {
	const agent = jsonObject(response?.agent)
	return Boolean(
		receipt.resources.workerPaneId &&
			stringField(agent, "name") === receipt.resources.workerName &&
			stringField(agent, "pane_id") === receipt.resources.workerPaneId &&
			stringField(agent, "workspace_id") === receipt.workspace.workspaceId &&
			stringField(agent, "tab_id") === receipt.workspace.tabId,
	)
}

function currentPane(workspace: string): CurrentPane {
	const json = requireHerdrSuccess(
		runHerdr(["pane", "current", "--current"], workspace),
		"HERDR_CURRENT_FAILED",
		"Run herdr pane current --current and repair the current session before retrying.",
	)
	const result = jsonObject(json.result)
	if (stringField(result, "type") !== "pane_current") {
		throw new FrontierError({
			message: "Herdr current pane returned an unexpected response type",
			code: "HERDR_CURRENT_INVALID",
			nextAction: "Run herdr pane current --current and verify the installed client/server schema.",
		})
	}
	const pane = jsonObject(result?.pane)
	const paneId = stringField(pane, "pane_id")
	const workspaceId = stringField(pane, "workspace_id")
	const tabId = stringField(pane, "tab_id")
	const foregroundCwd = stringField(pane, "foreground_cwd")
	if (!paneId || !workspaceId || !tabId || !foregroundCwd) {
		throw new FrontierError({
			message: "Herdr current pane omitted required identifiers or foreground cwd",
			code: "HERDR_CURRENT_INVALID",
			nextAction: "Use a pane whose foreground process cwd Herdr can resolve.",
		})
	}
	if (paneId !== process.env.HERDR_PANE_ID) {
		throw new FrontierError({
			message: "Herdr current pane conflicts with inherited caller identity",
			code: "HERDR_CONTEXT_CONFLICT",
			nextAction: "Invoke again from the intended managed pane without changing focus-based targets.",
		})
	}
	if (workspaceId !== process.env.HERDR_WORKSPACE_ID || tabId !== process.env.HERDR_TAB_ID) {
		throw new FrontierError({
			message: "Herdr current pane conflicts with inherited workspace or tab identity",
			code: "HERDR_CONTEXT_CONFLICT",
			nextAction: "Invoke again from the original Herdr workspace and tab.",
		})
	}
	if (canonicalDirectory(foregroundCwd) !== workspace) {
		throw new FrontierError({
			message: "granted workspace does not match the calling pane foreground cwd",
			code: "WORKSPACE_CONFLICT",
			exitCode: 2,
			nextAction: "Invoke from a pane whose foreground cwd is the explicitly granted workspace.",
		})
	}
	return { paneId, workspaceId, tabId, foregroundCwd: workspace }
}

function stateRoot(): string {
	const base = process.env.XDG_STATE_HOME
		? resolve(process.env.XDG_STATE_HOME)
		: process.env.HOME
			? join(resolve(process.env.HOME), ".local", "state")
			: undefined
	if (!base) {
		throw new FrontierError({
			message: "no private state home is available",
			code: "STATE_HOME_MISSING",
			nextAction: "Set XDG_STATE_HOME or HOME to a private writable location.",
		})
	}
	return join(base, "my-second-brain-vault", "frontier-runner")
}

function ensurePrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 })
	chmodSync(path, 0o700)
}

function receiptPath(runId: string): string {
	if (!runIdPattern.test(runId)) {
		throw new FrontierError({
			message: `run id is invalid: ${runId}`,
			code: "RUN_ID_INVALID",
			exitCode: 2,
			nextAction: "Use the runId returned by Frontier Runner.",
		})
	}
	return join(stateRoot(), `${runId}.json`)
}

function createReceipt(receipt: Receipt): void {
	const path = receiptPath(receipt.runId)
	ensurePrivateDirectory(dirname(path))
	try {
		writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 })
		chmodSync(path, 0o600)
	} catch (error) {
		if (existsSync(path)) {
			throw new FrontierError({
				message: `an active or completed receipt already exists for ${receipt.runId}`,
				code: "RUN_ALREADY_EXISTS",
				runId: receipt.runId,
				nextAction: `Run frontier-runner resume --run-id ${receipt.runId}, or use a new unit ID after cleanup.`,
			})
		}
		throw error
	}
}

function writeReceipt(receipt: Receipt): void {
	const path = receiptPath(receipt.runId)
	ensurePrivateDirectory(dirname(path))
	receipt.updatedAt = now()
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
	try {
		writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		})
		chmodSync(temporary, 0o600)
		renameSync(temporary, path)
		chmodSync(path, 0o600)
	} finally {
		if (existsSync(temporary)) rmSync(temporary)
	}
}

function readReceipt(runId: string): Receipt {
	const path = receiptPath(runId)
	if (!existsSync(path) || !lstatSync(path).isFile()) {
		throw new FrontierError({
			message: `receipt does not exist: ${runId}`,
			code: "RECEIPT_MISSING",
			exitCode: 2,
			runId,
			nextAction: "Use the runId returned by the original Frontier Runner run.",
		})
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"))
	} catch {
		throw new FrontierError({
			message: `receipt is malformed: ${runId}`,
			code: "RECEIPT_INVALID",
			runId,
			nextAction: `Inspect the private receipt at ${path}; do not rerun the worker until it is reconciled.`,
		})
	}
	if (!isReceipt(parsed) || parsed.runId !== runId) {
		throw new FrontierError({
			message: `receipt identity or schema is invalid: ${runId}`,
			code: "RECEIPT_INVALID",
			runId,
			nextAction: `Inspect the private receipt at ${path}; do not rerun the worker until it is reconciled.`,
		})
	}
	return parsed
}

function receiptHasRunResources(receipt: Receipt): boolean {
	return Boolean(
		receipt.resources.editorPaneId &&
			receipt.resources.browserPaneId &&
			receipt.resources.workerPaneId,
	)
}

function effectIs(receipt: Receipt, effect: EffectName, ...outcomes: EffectOutcome[]): boolean {
	const outcome = receipt.effects[effect]?.outcome
	return outcome !== undefined && outcomes.includes(outcome)
}

function splitResourceInvariants(receipt: Receipt): boolean {
	for (const [effect, resource] of [
		["editorPane", "editorPaneId"],
		["browserPane", "browserPaneId"],
		["workerPane", "workerPaneId"],
	] as const) {
		const hasResource = typeof receipt.resources[resource] === "string"
		if (effectIs(receipt, effect, "succeeded") !== hasResource) return false
	}
	return true
}

function completedRunEffects(receipt: Receipt): boolean {
	return (
		receiptHasRunResources(receipt) &&
		effectIs(receipt, "editorPane", "succeeded") &&
		effectIs(receipt, "editorLaunch", "succeeded") &&
		effectIs(receipt, "browserPane", "succeeded") &&
		effectIs(receipt, "browserLaunch", "succeeded") &&
		effectIs(receipt, "workerPane", "succeeded") &&
		effectIs(receipt, "workerStart", "succeeded") &&
		effectIs(receipt, "promptDispatch", "succeeded", "timed_out")
	)
}

function receiptStateInvariants(receipt: Receipt): boolean {
	if (!initialEffectNames.every((effect) => receipt.effects[effect] !== undefined)) return false
	if (!splitResourceInvariants(receipt)) return false

	if (receipt.state === "prepared") {
		return !receiptHasRunResources(receipt) && initialEffectNames.every((effect) => effectIs(receipt, effect, "planned"))
	}
	if (receipt.state === "timed_out") {
		return (
			completedRunEffects(receipt) &&
			((effectIs(receipt, "promptDispatch", "timed_out") &&
				promptUncertainCodes.has(receipt.effects.promptDispatch?.code ?? "")) ||
				(effectIs(receipt, "promptDispatch", "succeeded") &&
					effectIs(receipt, "resumeWait", "timed_out") &&
					receipt.effects.resumeWait?.code === "timeout"))
		)
	}
	if (receipt.state === "settled_unproved") {
		return (
			completedRunEffects(receipt) &&
			completedStatuses.has(receipt.observation?.agentStatus ?? "") &&
			sha256Pattern.test(receipt.observation?.resultSha256 ?? "") &&
			receipt.observation?.resultMarkerSha256 === undefined
		)
	}
	if (receipt.state === "completed") {
		const resultSha256 = receipt.observation?.resultSha256 ?? ""
		return (
			completedRunEffects(receipt) &&
			completedStatuses.has(receipt.observation?.agentStatus ?? "") &&
			sha256Pattern.test(resultSha256) &&
			resultSha256 !== receipt.inputs.resultBeforeSha256 &&
			receipt.observation?.resultMarkerSha256 === sha256(`frontier-result:${resultSha256}`)
		)
	}
	if (receipt.state === "cleanup_pending" || receipt.state === "cleaned") {
		for (const splitEffect of ["editorPane", "browserPane", "workerPane"] as const) {
			if (effectIs(receipt, splitEffect, "unknown")) return false
		}
		if (receipt.state === "cleanup_pending") return true
		if (!effectIs(receipt, "cleanupComplete", "succeeded")) return false
		for (const [resource, closeEffect] of [
			["editorPaneId", "editorPaneClose"],
			["browserPaneId", "browserPaneClose"],
			["workerPaneId", "workerPaneClose"],
		] as const) {
			if (receipt.resources[resource] && !effectIs(receipt, closeEffect, "succeeded")) return false
		}
		return true
	}
	return receipt.state === "starting" || receipt.state === "failed"
}

function isReceipt(value: unknown): value is Receipt {
	const receipt = jsonObject(value)
	const workspace = jsonObject(receipt?.workspace)
	const inputs = jsonObject(receipt?.inputs)
	const resources = jsonObject(receipt?.resources)
	const effects = jsonObject(receipt?.effects)
	if (
		receipt?.schemaVersion !== receiptSchemaVersion ||
		!runIdPattern.test(stringField(receipt, "runId") ?? "") ||
		!unitIdPattern.test(stringField(receipt, "unitId") ?? "") ||
		!sha256Pattern.test(stringField(receipt, "requestHash") ?? "") ||
		!runStates.has(stringField(receipt, "state") ?? "") ||
		!stringField(receipt, "createdAt") ||
		!stringField(receipt, "updatedAt") ||
		!stringField(workspace, "path") ||
		!stringField(workspace, "workspaceId") ||
		!stringField(workspace, "tabId") ||
		!stringField(workspace, "callerPaneId") ||
		!sha256Pattern.test(stringField(inputs, "promptSha256") ?? "") ||
		!sha256Pattern.test(stringField(inputs, "browserUrlSha256") ?? "") ||
		!isSafeRelativeResultPath(stringField(inputs, "resultFile") ?? "") ||
		!sha256Pattern.test(stringField(inputs, "resultBeforeSha256") ?? "") ||
		typeof inputs?.timeoutMs !== "number" ||
		!Number.isSafeInteger(inputs.timeoutMs) ||
		inputs.timeoutMs < 1 ||
		inputs.timeoutMs > 3_600_000 ||
		!stringField(resources, "workerName") ||
		!effects
	) {
		return false
	}
	if (!resources || !effects) return false
	for (const paneField of ["editorPaneId", "browserPaneId", "workerPaneId"]) {
		const paneId = resources[paneField]
		if (paneId !== undefined && (typeof paneId !== "string" || paneId.length === 0)) return false
	}
	for (const [effectName, effect] of Object.entries(effects)) {
		if (!effectNames.has(effectName)) return false
		const record = jsonObject(effect)
		if (!effectOutcomes.has(stringField(record, "outcome") ?? "") || !stringField(record, "observedAt")) {
			return false
		}
		if (record?.code !== undefined && !stringField(record, "code")) return false
	}
	return receiptStateInvariants(receipt as unknown as Receipt)
}

function recordEffect(receipt: Receipt, effect: EffectName, outcome: EffectOutcome, code?: string): void {
	receipt.effects[effect] = { outcome, observedAt: now(), ...(code ? { code } : {}) }
	writeReceipt(receipt)
}

function splitPane(
	receipt: Receipt,
	effect: EffectName,
	resource: "editorPaneId" | "browserPaneId" | "workerPaneId",
	sourcePaneId: string,
	direction: "right" | "down",
): string {
	receipt.state = "starting"
	recordEffect(receipt, effect, "unknown")
	const result = runHerdr(
		["pane", "split", sourcePaneId, "--direction", direction, "--cwd", receipt.workspace.path, "--no-focus"],
		receipt.workspace.path,
	)
	const response = herdrResponseResult(result, "pane_info")
	if (
		!responsePaneMatches(response, {
			workspaceId: receipt.workspace.workspaceId,
			tabId: receipt.workspace.tabId,
		})
	) {
		throw new FrontierError({
			message: `Herdr could not prove the ${effect} pane response type and identity`,
			code: "PANE_SPLIT_UNKNOWN",
			runId: receipt.runId,
			state: receipt.state,
			changedState: "partial",
			nextAction: "Inspect the Herdr layout and private receipt before cleanup; the split outcome is unknown.",
		})
	}
	const pane = jsonObject(response.pane)
	const paneId = stringField(pane, "pane_id")
	const forbiddenPaneIds = new Set([
		receipt.workspace.callerPaneId,
		sourcePaneId,
		receipt.resources.editorPaneId,
		receipt.resources.browserPaneId,
		receipt.resources.workerPaneId,
	])
	if (!paneId || forbiddenPaneIds.has(paneId)) {
		throw new FrontierError({
			message: `Herdr returned a missing or conflicting pane ID for ${effect}`,
			code: "PANE_SPLIT_UNKNOWN",
			runId: receipt.runId,
			state: receipt.state,
			changedState: "partial",
			nextAction: "Inspect the Herdr layout and private receipt before cleanup; the split outcome is unknown.",
		})
	}
	receipt.resources[resource] = paneId
	recordEffect(receipt, effect, "succeeded")
	return paneId
}

function dispatchPaneCommand(receipt: Receipt, effect: EffectName, paneId: string, command: string): void {
	if (!paneExists(receipt, paneId)) {
		throw new FrontierError({
			message: `Herdr cannot find the recorded target pane for ${effect}`,
			code: "PANE_COMMAND_UNKNOWN",
			runId: receipt.runId,
			state: receipt.state,
			nextAction: `Inspect pane ${paneId}; do not dispatch the command to another pane.`,
		})
	}
	recordEffect(receipt, effect, "unknown")
	const result = runHerdr(["pane", "run", paneId, command], receipt.workspace.path)
	if (!paneRunAccepted(result)) {
		throw new FrontierError({
			message: `Herdr could not confirm ${effect}`,
			code: "PANE_COMMAND_UNKNOWN",
			runId: receipt.runId,
			state: receipt.state,
			changedState: "partial",
			nextAction: `Inspect pane ${paneId}; the command dispatch outcome is unknown.`,
		})
	}
	recordEffect(receipt, effect, "succeeded")
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

function workerPrompt(prompt: string, resultFile: string): string {
	const quotedResultFile = shellQuote(resultFile)
	return `${prompt.trimEnd()}\n\nFrontier Runner completion contract:\n- Modify the existing workspace-relative fixture file: ${resultFile}\n- The final bytes must differ from the initial bytes.\n- As your final shell action, run exactly: result_sha256=$(shasum -a 256 -- ${quotedResultFile} | awk '{print $1}') && printf 'frontier-result:%s\\n' "$result_sha256"\n- After that command prints the marker, do not repeat the marker in prose.\n`
}

function startWorker(receipt: Receipt): void {
	recordEffect(receipt, "workerStart", "unknown")
	const result = runHerdr(
		[
			"agent",
			"start",
			receipt.resources.workerName,
			"--kind",
			"codex",
			"--pane",
			receipt.resources.workerPaneId!,
		],
		receipt.workspace.path,
	)
	const response = herdrResponseResult(result, "agent_started")
	const startedAgent = jsonObject(response?.agent)
	if (
		!responseAgentMatches(response, receipt) ||
		!completedStatuses.has(stringField(startedAgent, "agent_status") ?? "")
	) {
		throw new FrontierError({
			message: `Herdr could not confirm Codex worker start${result.errorCode ? `: ${result.errorCode}` : ""}`,
			code: "WORKER_START_UNKNOWN",
			runId: receipt.runId,
			state: receipt.state,
			changedState: "partial",
			nextAction: `Inspect pane ${receipt.resources.workerPaneId} and the private receipt; do not start another worker.`,
		})
	}
	recordEffect(receipt, "workerStart", "succeeded")
}

function promptWorker(receipt: Receipt, prompt: string): void {
	recordEffect(receipt, "promptDispatch", "unknown")
	const result = runHerdr(
		[
			"agent",
			"prompt",
			receipt.resources.workerName,
			workerPrompt(prompt, receipt.inputs.resultFile),
			"--wait",
			"--timeout",
			String(receipt.inputs.timeoutMs),
		],
		receipt.workspace.path,
	)
	const response = herdrResponseResult(result, "agent_prompted")
	if (responseAgentMatches(response, receipt)) {
		recordEffect(receipt, "promptDispatch", "succeeded")
		return
	}
	if (result.errorCode && promptUncertainCodes.has(result.errorCode)) {
		receipt.state = "timed_out"
		recordEffect(receipt, "promptDispatch", "timed_out", result.errorCode)
		throw new FrontierError({
			message: `prompt delivery is classified but unsettled: ${result.errorCode}`,
			code: "PROMPT_TIMEOUT",
			exitCode: 124,
			runId: receipt.runId,
			state: receipt.state,
			changedState: "partial",
			sideEffects: ["receipt", "editor-pane", "browser-pane", "worker-pane", "codex-worker", "prompt-maybe-delivered"],
			nextAction: `Run frontier-runner resume --run-id ${receipt.runId}; do not rerun run or resend the prompt.`,
		})
	}
	throw new FrontierError({
		message: `prompt dispatch outcome is unknown${result.errorCode ? `: ${result.errorCode}` : ""}`,
		code: "PROMPT_EFFECT_UNKNOWN",
		runId: receipt.runId,
		state: receipt.state,
		changedState: "partial",
		nextAction: `Inspect ${receipt.resources.workerName} and the private receipt; do not resend the prompt.`,
	})
}

function agentObservation(receipt: Receipt): AgentObservation {
	const result = runHerdr(["agent", "get", receipt.resources.workerName], receipt.workspace.path)
	if (result.exitCode !== 0 || !result.json) {
		throw new FrontierError({
			message: `recorded worker identity is unavailable${result.errorCode ? `: ${result.errorCode}` : ""}`,
			code: "WORKER_IDENTITY_LOST",
			runId: receipt.runId,
			state: receipt.state,
			nextAction: `Inspect pane ${receipt.resources.workerPaneId}; do not create a replacement worker for this run.`,
		})
	}
	const resultObject = herdrResponseResult(result, "agent_info")
	if (!responseAgentMatches(resultObject, receipt)) {
		throw new FrontierError({
			message: "Herdr returned a worker observation for a conflicting identity",
			code: "WORKER_IDENTITY_CONFLICT",
			runId: receipt.runId,
			state: receipt.state,
			nextAction: "Stop and inspect the live agent and private receipt; do not prompt or clean a conflicting pane.",
		})
	}
	const agent = jsonObject(resultObject.agent)
	const paneId = stringField(agent, "pane_id")
	const status = stringField(agent, "agent_status")
	if (!paneId || !status) {
		throw new FrontierError({
			message: "Herdr returned an incomplete worker observation",
			code: "HERDR_PROTOCOL_INVALID",
			runId: receipt.runId,
			state: receipt.state,
			nextAction: "Inspect herdr agent get output and verify client/server compatibility.",
		})
	}
	if (paneId !== receipt.resources.workerPaneId) {
		throw new FrontierError({
			message: "recorded worker name now resolves to a conflicting pane",
			code: "WORKER_IDENTITY_CONFLICT",
			runId: receipt.runId,
			state: receipt.state,
			nextAction: "Stop and inspect the live agent and private receipt; do not prompt or clean a conflicting pane.",
		})
	}
	if (!agentStatuses.has(status)) {
		throw new FrontierError({
			message: `Herdr returned an unsupported worker state: ${status}`,
			code: "HERDR_PROTOCOL_INVALID",
			runId: receipt.runId,
			state: receipt.state,
			nextAction: "Verify the installed Herdr client and server versions, then inspect agent get output.",
		})
	}
	return { paneId, status }
}

function waitForWorker(receipt: Receipt): AgentObservation {
	const result = runHerdr(
		["agent", "wait", receipt.resources.workerName, "--timeout", String(receipt.inputs.timeoutMs)],
		receipt.workspace.path,
	)
	if (result.exitCode !== 0) {
		if (result.errorCode === "timeout") {
			receipt.state = "timed_out"
			recordEffect(receipt, "resumeWait", "timed_out", result.errorCode)
			throw new FrontierError({
				message: "recorded worker has not settled within the resume timeout",
				code: "PROMPT_TIMEOUT",
				exitCode: 124,
				runId: receipt.runId,
				state: receipt.state,
				changedState: "none",
				retrySafe: true,
				nextAction: `Run frontier-runner resume --run-id ${receipt.runId} again later; no prompt will be resent.`,
			})
		}
		throw new FrontierError({
			message: `worker wait failed${result.errorCode ? `: ${result.errorCode}` : ""}`,
			code: "WORKER_WAIT_FAILED",
			runId: receipt.runId,
			state: receipt.state,
			nextAction: `Inspect ${receipt.resources.workerName} with herdr agent get and agent read.`,
		})
	}
	recordEffect(receipt, "resumeWait", "succeeded")
	return agentObservation(receipt)
}

function exactMarkerCount(readback: string, marker: string): number {
	const lines = readback.split(/\r?\n/)
	let count = 0
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? ""
		const codexToolOutput = line.match(/^\s*└\s+(frontier-result:[a-f0-9]*)$/)
		let candidate = codexToolOutput?.[1] ?? line
		if (!candidate || !marker.startsWith(candidate)) continue
		let end = index
		while (candidate.length < marker.length) {
			end += 1
			const nextLine = lines[end] ?? ""
			const next = codexToolOutput ? (nextLine.match(/^\s+([a-f0-9]+)$/)?.[1] ?? "") : nextLine
			if (!next || !marker.startsWith(candidate + next)) break
			candidate += next
		}
		if (candidate !== marker) continue
		count += 1
		index = end
	}
	return count
}

function proveResult(receipt: Receipt, observation: AgentObservation): ResultEnvelope {
	if (observation.status === "blocked") {
		throw new FrontierError({
			message: "the recorded worker is blocked on human input",
			code: "AGENT_BLOCKED",
			runId: receipt.runId,
			state: receipt.state,
			retrySafe: true,
			nextAction: `Inspect ${receipt.resources.workerName} and let the user decide the visible approval or question.`,
		})
	}
	if (observation.status === "unknown") {
		throw new FrontierError({
			message: "Herdr cannot classify the recorded worker state",
			code: "AGENT_STATE_UNKNOWN",
			runId: receipt.runId,
			state: receipt.state,
			nextAction: `Inspect ${receipt.resources.workerName} with herdr agent get and agent read; terminal status does not prove completion.`,
		})
	}
	if (!completedStatuses.has(observation.status)) {
		throw new FrontierError({
			message: `recorded worker is not settled: ${observation.status}`,
			code: "AGENT_NOT_SETTLED",
			runId: receipt.runId,
			state: receipt.state,
			retrySafe: true,
			nextAction: `Run frontier-runner resume --run-id ${receipt.runId} to wait without resending the prompt.`,
		})
	}

	const resultFile = canonicalResultFile(receipt.workspace.path, receipt.inputs.resultFile)
	const resultSha256 = sha256(readFileSync(resultFile.path))
	const marker = `frontier-result:${resultSha256}`
	const read = runHerdr(
		["agent", "read", receipt.resources.workerName, "--source", "recent-unwrapped", "--lines", "120"],
		receipt.workspace.path,
	)
	if (read.exitCode !== 0) {
		throw new FrontierError({
			message: `could not read the recorded worker${read.errorCode ? `: ${read.errorCode}` : ""}`,
			code: "WORKER_READ_FAILED",
			runId: receipt.runId,
			state: receipt.state,
			retrySafe: true,
			nextAction: `Inspect ${receipt.resources.workerName} directly, then resume without resending the prompt.`,
		})
	}
	const exactMarkerLines = exactMarkerCount(read.stdout, marker)
	if (resultSha256 === receipt.inputs.resultBeforeSha256 || exactMarkerLines !== 1) {
		receipt.state = "settled_unproved"
		receipt.observation = { agentStatus: observation.status, resultSha256 }
		writeReceipt(receipt)
		throw new FrontierError({
			message: "worker settled without the independently derived result marker",
			code: "RESULT_NOT_PROVED",
			runId: receipt.runId,
			state: receipt.state,
			retrySafe: true,
			nextAction: `Inspect ${receipt.resources.workerName} and the fixture file; resume reads again but never resends the prompt.`,
		})
	}
	receipt.state = "completed"
	receipt.observation = {
		agentStatus: observation.status,
		resultSha256,
		resultMarkerSha256: sha256(marker),
	}
	writeReceipt(receipt)
	return {
		schemaVersion,
		ok: true,
		command: "resume",
		code: "RUN_COMPLETED",
		runId: receipt.runId,
		state: receipt.state,
		changedState: "complete",
		sideEffects: [],
		retrySafe: true,
		nextAction: `Run frontier-runner cleanup --run-id ${receipt.runId} when the panes are no longer needed.`,
	}
}

function validateReceiptContext(receipt: Receipt): void {
	requireInsideHerdr()
	requireTools(["herdr"])
	if (
		process.env.HERDR_WORKSPACE_ID !== receipt.workspace.workspaceId ||
		process.env.HERDR_TAB_ID !== receipt.workspace.tabId
	) {
		throw new FrontierError({
			message: "current Herdr workspace or tab conflicts with the recorded run",
			code: "WORKSPACE_CONFLICT",
			runId: receipt.runId,
			state: receipt.state,
			nextAction: "Invoke from the original Herdr workspace and tab recorded by the run.",
		})
	}
	canonicalDirectory(receipt.workspace.path)
}

function unknownEffect(receipt: Receipt): string | undefined {
	return Object.entries(receipt.effects).find(([, effect]) => effect.outcome === "unknown")?.[0]
}

function runCommand(arguments_: string[]): ResultEnvelope {
	const flags = parseFlags(arguments_, [
		"--unit-id",
		"--workspace",
		"--prompt-file",
		"--timeout-ms",
		"--browser-url",
		"--result-file",
	])
	const unitId = requiredFlag(flags, "--unit-id")
	if (!unitIdPattern.test(unitId)) {
		throw new FrontierError({
			message: "unit ID must contain 1 to 64 safe identifier characters",
			code: "UNIT_ID_INVALID",
			exitCode: 2,
			nextAction: "Use letters, digits, dot, underscore, or hyphen, beginning with a letter or digit.",
		})
	}
	const workspace = canonicalDirectory(requiredFlag(flags, "--workspace"))
	const prompt = promptBytes(requiredFlag(flags, "--prompt-file"))
	const promptText = prompt.toString()
	if (/frontier-result:[a-f0-9]{64}/.test(promptText)) {
		throw new FrontierError({
			message: "prompt already contains a complete Frontier Runner result marker",
			code: "PROMPT_MARKER_CONFLICT",
			exitCode: 2,
			nextAction: "Remove the complete marker from the prompt so echoed input cannot satisfy the result proof.",
		})
	}
	const timeoutMs = timeoutValue(requiredFlag(flags, "--timeout-ms"))
	const url = browserUrl(requiredFlag(flags, "--browser-url"))
	const resultFile = canonicalResultFile(workspace, requiredFlag(flags, "--result-file"))
	requireInsideHerdr()
	requireTools(["herdr", "tode", "terminal-browser", "codex"])
	proveToolContract("tode", /Usage:\s+tode|tode\s+<folder>/, workspace)
	proveToolContract("terminal-browser", /\bopen\b/, workspace)
	const caller = currentPane(workspace)
	const promptSha256 = sha256(prompt)
	const browserUrlSha256 = sha256(url.toString())
	const resultBeforeSha256 = sha256(readFileSync(resultFile.path))
	const requestHash = sha256(
		[
			unitId,
			workspace,
			promptSha256,
			String(timeoutMs),
			browserUrlSha256,
			resultFile.relativePath,
			resultBeforeSha256,
		].join("\0"),
	)
	const runId = `fr-${sha256(`${unitId}\0${workspace}`).slice(0, 16)}`
	const createdAt = now()
	const receipt: Receipt = {
		schemaVersion: receiptSchemaVersion,
		runId,
		unitId,
		requestHash,
		state: "prepared",
		createdAt,
		updatedAt: createdAt,
		workspace: {
			path: workspace,
			workspaceId: caller.workspaceId,
			tabId: caller.tabId,
			callerPaneId: caller.paneId,
		},
		inputs: {
			promptSha256,
			browserUrlSha256,
			resultFile: resultFile.relativePath,
			resultBeforeSha256,
			timeoutMs,
		},
		resources: { workerName: `fr_${sha256(runId).slice(0, 12)}` },
		effects: {
			editorPane: { outcome: "planned", observedAt: createdAt },
			editorLaunch: { outcome: "planned", observedAt: createdAt },
			browserPane: { outcome: "planned", observedAt: createdAt },
			browserLaunch: { outcome: "planned", observedAt: createdAt },
			workerPane: { outcome: "planned", observedAt: createdAt },
			workerStart: { outcome: "planned", observedAt: createdAt },
			promptDispatch: { outcome: "planned", observedAt: createdAt },
		},
	}
	createReceipt(receipt)

	receipt.resources.editorPaneId = splitPane(
		receipt,
		"editorPane",
		"editorPaneId",
		caller.paneId,
		"right",
	)
	dispatchPaneCommand(receipt, "editorLaunch", receipt.resources.editorPaneId, "exec tode .")
	receipt.resources.browserPaneId = splitPane(
		receipt,
		"browserPane",
		"browserPaneId",
		receipt.resources.editorPaneId,
		"down",
	)
	dispatchPaneCommand(
		receipt,
		"browserLaunch",
		receipt.resources.browserPaneId,
		`exec terminal-browser open ${shellQuote(url.toString())}`,
	)
	receipt.resources.workerPaneId = splitPane(
		receipt,
		"workerPane",
		"workerPaneId",
		caller.paneId,
		"down",
	)
	startWorker(receipt)
	promptWorker(receipt, promptText)

	let observation = agentObservation(receipt)
	if (observation.status === "working") observation = waitForWorker(receipt)
	const completed = proveResult(receipt, observation)
	return { ...completed, command: "run", sideEffects: ["receipt", "editor-pane", "browser-pane", "worker-pane", "codex-worker", "prompt"] }
}

function resumeCommand(arguments_: string[]): ResultEnvelope {
	const flags = parseFlags(arguments_, ["--run-id"])
	const runId = requiredFlag(flags, "--run-id")
	const receipt = readReceipt(runId)
	validateReceiptContext(receipt)
	if (receipt.state === "cleaned") {
		return {
			schemaVersion,
			ok: true,
			command: "resume",
			code: "RUN_CLEANED",
			runId,
			state: receipt.state,
			changedState: "none",
			sideEffects: [],
			retrySafe: true,
			nextAction: "Use a new unit ID for another run.",
		}
	}
	if (receipt.state === "completed") {
		return {
			schemaVersion,
			ok: true,
			command: "resume",
			code: "RUN_COMPLETED",
			runId,
			state: receipt.state,
			changedState: "none",
			sideEffects: [],
			retrySafe: true,
			nextAction: `Run frontier-runner cleanup --run-id ${runId} when the panes are no longer needed.`,
		}
	}
	const uncertainEffect = unknownEffect(receipt)
	if (uncertainEffect) {
		throw new FrontierError({
			message: `receipt contains an unknown external effect: ${uncertainEffect}`,
			code: "EFFECT_UNKNOWN",
			runId,
			state: receipt.state,
			nextAction: "Inspect the recorded panes and effect before any retry; automatic replay is unsafe.",
		})
	}
	if (!receipt.resources.workerPaneId || receipt.effects.workerStart?.outcome !== "succeeded") {
		throw new FrontierError({
			message: "receipt has no confirmed worker identity",
			code: "WORKER_IDENTITY_LOST",
			runId,
			state: receipt.state,
			nextAction: "Inspect the private receipt and Herdr layout; do not create a replacement worker.",
		})
	}
	reconcileRunPanes(receipt)
	let observation = agentObservation(receipt)
	if (observation.status === "working") observation = waitForWorker(receipt)
	return proveResult(receipt, observation)
}

function paneExists(receipt: Receipt, paneId: string): boolean {
	const result = runHerdr(["pane", "get", paneId], receipt.workspace.path)
	if (result.exitCode === 0 && result.json) {
		const response = herdrResponseResult(result, "pane_info")
		if (!response) {
			throw new FrontierError({
				message: `Herdr returned an unexpected pane response type: ${paneId}`,
				code: "HERDR_PROTOCOL_INVALID",
				runId: receipt.runId,
				state: receipt.state,
				nextAction: "Inspect herdr pane get output and verify client/server compatibility.",
			})
		}
		const pane = jsonObject(response.pane)
		const observedPaneId = stringField(pane, "pane_id")
		const workspaceId = stringField(pane, "workspace_id")
		const tabId = stringField(pane, "tab_id")
		if (
			observedPaneId !== paneId ||
			workspaceId !== receipt.workspace.workspaceId ||
			tabId !== receipt.workspace.tabId
		) {
			throw new FrontierError({
				message: `owned pane identity conflicts with the receipt: ${paneId}`,
				code: "PANE_IDENTITY_CONFLICT",
				runId: receipt.runId,
				state: receipt.state,
				nextAction: "Inspect the pane and receipt; do not prompt or close a conflicting target.",
			})
		}
		return true
	}
	if (result.errorCode === "pane_not_found" || result.errorCode === "not_found") return false
	throw new FrontierError({
		message: `could not reconcile owned pane ${paneId}${result.errorCode ? `: ${result.errorCode}` : ""}`,
		code: "PANE_RECONCILIATION_FAILED",
		runId: receipt.runId,
		state: receipt.state,
		nextAction: "Inspect the Herdr session before cleanup; do not close an unverified target.",
	})
}

function reconcileRunPanes(receipt: Receipt): void {
	for (const [role, paneId] of [
		["Terminal Code", receipt.resources.editorPaneId],
		["Chromium", receipt.resources.browserPaneId],
		["worker", receipt.resources.workerPaneId],
	] as const) {
		if (!paneId || !paneExists(receipt, paneId)) {
			throw new FrontierError({
				message: `recorded ${role} pane identity is unavailable`,
				code: "PANE_IDENTITY_LOST",
				runId: receipt.runId,
				state: receipt.state,
				nextAction: "Inspect the Herdr layout and private receipt; do not recreate or retarget this run automatically.",
			})
		}
	}
}

function closeOwnedPane(receipt: Receipt, resource: keyof Receipt["resources"], effect: EffectName): boolean {
	const paneId = receipt.resources[resource]
	if (typeof paneId !== "string") return false
	if (!paneExists(receipt, paneId)) {
		recordEffect(receipt, effect, "succeeded", "already_absent")
		return false
	}
	recordEffect(receipt, effect, "unknown")
	const result = runHerdr(["pane", "close", paneId], receipt.workspace.path)
	if (
		(result.exitCode === 0 && !herdrResponseResult(result, "ok")) ||
		(result.exitCode !== 0 && result.errorCode !== "pane_not_found" && result.errorCode !== "not_found")
	) {
		throw new FrontierError({
			message: `could not confirm closure of owned pane ${paneId}`,
			code: "CLEANUP_EFFECT_UNKNOWN",
			runId: receipt.runId,
			state: receipt.state,
			changedState: "partial",
			nextAction: `Inspect pane ${paneId}; repeat cleanup only after its identity is clear.`,
		})
	}
	recordEffect(receipt, effect, "succeeded")
	return true
}

function cleanupCommand(arguments_: string[]): ResultEnvelope {
	const flags = parseFlags(arguments_, ["--run-id"])
	const runId = requiredFlag(flags, "--run-id")
	const receipt = readReceipt(runId)
	validateReceiptContext(receipt)
	if (receipt.state === "cleaned") {
		return {
			schemaVersion,
			ok: true,
			command: "cleanup",
			code: "CLEANUP_CONVERGED",
			runId,
			state: receipt.state,
			changedState: "none",
			sideEffects: [],
			retrySafe: true,
			nextAction: "Use a new unit ID for another bounded run.",
		}
	}
	if (
		[
			receipt.resources.editorPaneId,
			receipt.resources.browserPaneId,
			receipt.resources.workerPaneId,
		].includes(process.env.HERDR_PANE_ID)
	) {
		throw new FrontierError({
			message: "cleanup was invoked from a pane owned by the run",
			code: "CLEANUP_CALLER_OWNED",
			runId,
			state: receipt.state,
			nextAction: "Invoke cleanup from the original caller pane so the controller cannot close itself mid-receipt.",
		})
	}
	for (const splitEffect of ["editorPane", "browserPane", "workerPane"] as const) {
		if (receipt.effects[splitEffect]?.outcome === "unknown") {
			throw new FrontierError({
				message: `cannot clean an unaddressed pane after unknown split: ${splitEffect}`,
				code: "CLEANUP_TARGET_UNKNOWN",
				runId,
				state: receipt.state,
				nextAction: "Inspect the Herdr layout and receipt; close only panes whose IDs can be proved owned.",
			})
		}
	}
	receipt.state = "cleanup_pending"
	writeReceipt(receipt)
	const closed = [
		closeOwnedPane(receipt, "workerPaneId", "workerPaneClose"),
		closeOwnedPane(receipt, "browserPaneId", "browserPaneClose"),
		closeOwnedPane(receipt, "editorPaneId", "editorPaneClose"),
	].filter(Boolean).length
	recordEffect(receipt, "cleanupComplete", "succeeded")
	receipt.state = "cleaned"
	writeReceipt(receipt)
	return {
		schemaVersion,
		ok: true,
		command: "cleanup",
		code: "CLEANUP_CONVERGED",
		runId,
		state: receipt.state,
		changedState: closed > 0 ? "complete" : "none",
		sideEffects: closed > 0 ? ["owned-panes-closed"] : [],
		retrySafe: true,
		nextAction: "Use a new unit ID for another bounded run.",
	}
}

const [commandInput, ...commandArguments] = process.argv.slice(2)
if (commandInput === undefined || commandInput === "--help" || commandInput === "-h") {
	process.stdout.write(help())
	process.exit(0)
}
if (!["run", "resume", "cleanup"].includes(commandInput))
	emitFailure(
		"unknown",
		new FrontierError({
			message: `unknown command: ${commandInput}`,
			code: "USAGE",
			exitCode: 2,
			nextAction: "Run frontier-runner --help.",
		}),
	)
const command = commandInput as CommandName
try {
	const envelope =
		command === "run"
			? runCommand(commandArguments)
			: command === "resume"
				? resumeCommand(commandArguments)
				: cleanupCommand(commandArguments)
	emit(envelope)
} catch (error) {
	if (error instanceof FrontierError) emitFailure(command, error)
	const nextAction = "Inspect the private receipt and report this unexpected failure before retrying."
	emitFailure(
		command,
		new FrontierError({
			message: error instanceof Error ? error.message : "unexpected failure",
			code: "INTERNAL_ERROR",
			nextAction,
		}),
	)
}
