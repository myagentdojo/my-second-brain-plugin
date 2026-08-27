import {
	type BrowserProcessIdentity,
	type CliCommand,
	type CliOutcome,
	commandVocabulary,
	type ErrorEnvelope,
	type ResultCode,
	schemaVersion,
	type SliceCommand,
	SpawnCleanupUnverifiedError,
	type SuccessEnvelope,
	type TransactionState,
} from "./contract"
import type { WarmBrowserAdapter } from "./adapter"
import {
	chromeArgumentList,
	isOwnedLaunch,
	isSameProcess,
	launchOwnership,
} from "./ownership"
import { productionAdapter } from "./production-adapter"
import {
	acquireSessionLock,
	type BrowserSessionState,
	ensurePrivateState,
	lockAgeMs,
	readSessionState,
	removeNewEmptyLock,
	removeOwnedState,
	resolveStatePaths,
	type RunningBrowserSessionState,
	runningState,
	type StatePaths,
	UnsafeStateError,
	validateSessionLock,
	writeSessionState,
} from "./state"

const defaultPort = 9242
const startingTimeoutMs = 15_000
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const commandNames = new Set<string>(commandVocabulary.map(({ name }) => name))
/** Generated from the single Command Vocabulary owner; never restated. */
const usageLine = `warm-browser <${
	commandVocabulary.map(({ name }) => name).join("|")
}> [--run-id ID] [--port NUMBER]`

interface ParsedCommand {
	readonly command: CliCommand
	readonly runId: string
	readonly port?: number
}

class WarmBrowserFailure extends Error {
	readonly command: CliCommand | "unknown"
	readonly resultCode: ResultCode
	readonly exitCode: 1 | 2 | 20 | 21 | 22
	readonly runId: string
	readonly transactionState: TransactionState
	readonly retrySafe: boolean
	readonly nextAction: string

	constructor(options: {
		command: CliCommand | "unknown"
		resultCode: ResultCode
		exitCode: 1 | 2 | 20 | 21 | 22
		runId: string
		transactionState?: TransactionState
		retrySafe: boolean
		nextAction: string
		message: string
	}) {
		super(options.message)
		this.name = "WarmBrowserFailure"
		this.command = options.command
		this.resultCode = options.resultCode
		this.exitCode = options.exitCode
		this.runId = options.runId
		this.transactionState = options.transactionState ?? "unchanged"
		this.retrySafe = options.retrySafe
		this.nextAction = options.nextAction
	}
}

function success(envelope: SuccessEnvelope): CliOutcome {
	return { exitCode: 0, stdout: `${JSON.stringify(envelope)}\n`, stderr: "" }
}

function failure(error: WarmBrowserFailure): CliOutcome {
	const envelope: ErrorEnvelope = {
		schemaVersion,
		status: "error",
		command: error.command,
		resultCode: error.resultCode,
		runId: error.runId,
		transactionState: error.transactionState,
		retrySafe: error.retrySafe,
		nextAction: error.nextAction,
		message: error.message,
	}
	return { exitCode: error.exitCode, stdout: "", stderr: `${JSON.stringify(envelope)}\n` }
}

function candidateRunId(arguments_: readonly string[], adapter: WarmBrowserAdapter): string {
	const index = arguments_.indexOf("--run-id")
	const value = index >= 0 ? arguments_[index + 1] : undefined
	return value !== undefined && runIdPattern.test(value) ? value : adapter.createRunId()
}

function raise(options: ConstructorParameters<typeof WarmBrowserFailure>[0]): never {
	throw new WarmBrowserFailure(options)
}

function usage(runId: string, command: CliCommand | "unknown", message: string): never {
	raise({
		command,
		resultCode: "USAGE_ERROR",
		exitCode: 2,
		runId,
		retrySafe: false,
		nextAction: "Run warm-browser help --run-id ID and correct the command arguments.",
		message,
	})
}

function parseArguments(arguments_: readonly string[], adapter: WarmBrowserAdapter): ParsedCommand {
	const generatedRunId = candidateRunId(arguments_, adapter)
	const first = arguments_[0]
	const command: CliCommand | "unknown" =
		first === undefined || first === "--help" || first === "-h"
			? "help"
			: commandNames.has(first)
			? (first as CliCommand)
			: "unknown"
	if (command === "unknown") usage(generatedRunId, command, "Unknown Warm Browser command.")
	let runId = generatedRunId
	let port: number | undefined
	let runIdSeen = false
	let portSeen = false
	for (let index = first === undefined ? 0 : 1; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (argument === "--run-id") {
			if (runIdSeen) usage(runId, command, "The --run-id flag may appear only once.")
			const value = arguments_[index + 1]
			if (value === undefined || !runIdPattern.test(value)) {
				usage(runId, command, "The --run-id value is missing or invalid.")
			}
			runId = value
			runIdSeen = true
			index += 1
			continue
		}
		if (argument === "--port") {
			if (command !== "start") usage(runId, command, "The --port flag is accepted only by start.")
			if (portSeen) usage(runId, command, "The --port flag may appear only once.")
			const value = arguments_[index + 1]
			if (value === undefined || !/^[0-9]+$/.test(value)) {
				usage(runId, command, "The --port value must be a decimal port number.")
			}
			port = Number(value)
			if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
				usage(runId, command, "The --port value must be between 1024 and 65535.")
			}
			portSeen = true
			index += 1
			continue
		}
		usage(runId, command, "Warm Browser received an unsupported argument.")
	}
	return { command, runId, ...(port === undefined ? {} : { port }) }
}

function staticFailure(
	command: CliCommand,
	runId: string,
	resultCode: ResultCode,
	exitCode: 1 | 20 | 21 | 22,
	message: string,
	nextAction: string,
	retrySafe = false,
	transactionState: TransactionState = "unchanged",
): never {
	raise({ command, resultCode, exitCode, runId, retrySafe, nextAction, message, transactionState })
}

function inspectionFailure(
	command: SliceCommand,
	runId: string,
	tx: TransactionState = "unchanged",
): never {
	staticFailure(
		command,
		runId,
		"PROCESS_INSPECTION_UNVERIFIED",
		20,
		"Warm Browser could not verify the local process table.",
		"Inspect the host process table and private Warm Browser state before retrying.",
		false,
		tx,
	)
}

function identityFailure(command: SliceCommand, runId: string): never {
	staticFailure(
		command,
		runId,
		"PROCESS_IDENTITY_UNVERIFIED",
		20,
		"The stored browser process identity does not match the live process.",
		"Inspect the live process and private Warm Browser state; do not signal the stored process id.",
	)
}

function launchCleanupUnverified(runId: string, transactionState: TransactionState): never {
	staticFailure(
		"start",
		runId,
		"UNEXPECTED_FAILURE",
		1,
		"Warm Browser could not verify cleanup of its launched browser process group.",
		"Inspect the durable launch intent and marker-matched processes before retrying.",
		false,
		transactionState,
	)
}

/**
 * Removes the durable receipt for a process group Warm Browser has just proved
 * stopped. A cleanup failure keeps the retained repairable state and reports
 * the stop that already happened; it never claims the transaction unchanged.
 */
function removeStateAfterStop(
	command: SliceCommand,
	runId: string,
	paths: StatePaths,
	sessionId: string,
): void {
	try {
		removeOwnedState(paths, sessionId)
	} catch {
		staticFailure(
			command,
			runId,
			"STATE_UNSAFE",
			20,
			"Warm Browser stopped the owned browser process group but could not remove its private session state.",
			"Repair the retained private Warm Browser session state; the owned browser process group is already stopped.",
			false,
			"stopped",
		)
	}
}

function canonicalProcess(value: BrowserProcessIdentity): BrowserProcessIdentity {
	return {
		pid: value.pid,
		processGroupId: value.processGroupId,
		startedAtToken: value.startedAtToken,
		executable: value.executable,
		commandLine: value.commandLine,
	}
}

/**
 * What one lifecycle inspection concluded, and only what that conclusion
 * carries. An absent session has no state and stopped nothing, a running one
 * always has its verified state, and a recovered one always says whether it
 * stopped an owned process. None of those payloads is optional, so "running
 * without a state" and "recovered without an outcome" cannot be written.
 */
type SessionInspection =
	| { readonly kind: "absent" }
	| { readonly kind: "running"; readonly state: RunningBrowserSessionState }
	| { readonly kind: "recovered"; readonly stoppedOwnedProcess: boolean }

async function recoverLaunching(
	command: SliceCommand,
	runId: string,
	paths: StatePaths,
	state: Extract<BrowserSessionState, { phase: "launching" }>,
	adapter: WarmBrowserAdapter,
): Promise<SessionInspection> {
	const first = adapter.findLaunchProcesses(state.launchMarker)
	if (first.kind === "unverifiable") inspectionFailure(command, runId)
	if (first.processes.length === 0) {
		removeOwnedState(paths, state.sessionId)
		return { kind: "recovered", stoppedOwnedProcess: false }
	}
	if (first.processes.length !== 1) {
		staticFailure(
			command,
			runId,
			"LAUNCH_PROCESS_AMBIGUOUS",
			20,
			"The stale launch marker does not identify exactly one browser leader.",
			"Inspect the marker-matched processes and private state; Warm Browser did not signal them.",
		)
	}
	const candidate = first.processes[0]!
	if (!isOwnedLaunch(candidate, state.launch)) identityFailure(command, runId)
	const second = adapter.findLaunchProcesses(state.launchMarker)
	if (second.kind === "unverifiable") inspectionFailure(command, runId)
	if (second.processes.length === 0) {
		removeOwnedState(paths, state.sessionId)
		return { kind: "recovered", stoppedOwnedProcess: false }
	}
	if (
		second.processes.length !== 1 ||
		!isSameProcess(candidate, second.processes[0]!) ||
		!isOwnedLaunch(second.processes[0]!, state.launch)
	) {
		staticFailure(
			command,
			runId,
			"LAUNCH_PROCESS_AMBIGUOUS",
			20,
			"The stale launch marker changed before cleanup.",
			"Inspect the marker-matched processes and private state; Warm Browser did not signal them.",
		)
	}
	if (!(await adapter.terminateProcessGroup(second.processes[0]!, state.launch))) {
		staticFailure(
			command,
			runId,
			"UNEXPECTED_FAILURE",
			1,
			"Warm Browser could not clean up its stale marked process group.",
			"Inspect the owned process group and private state before retrying.",
		)
	}
	removeStateAfterStop(command, runId, paths, state.sessionId)
	return { kind: "recovered", stoppedOwnedProcess: true }
}

async function inspectSession(
	command: SliceCommand,
	runId: string,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<SessionInspection> {
	const lockExists = validateSessionLock(paths)
	const state = readSessionState(paths)
	if (!lockExists && state !== undefined) {
		staticFailure(
			command,
			runId,
			"STATE_UNSAFE",
			20,
			"Warm Browser state has no ownership lock.",
			"Inspect the private Warm Browser state before retrying.",
		)
	}
	if (state === undefined) {
		if (!lockExists) return { kind: "absent" }
		if (lockAgeMs(paths, adapter.nowEpochMs()) <= startingTimeoutMs) {
			staticFailure(
				command,
				runId,
				"START_IN_PROGRESS",
				22,
				"Another Warm Browser start transaction owns the session lock.",
				"Wait briefly, then run warm-browser status --run-id ID.",
				true,
			)
		}
		staticFailure(
			command,
			runId,
			"PROCESS_IDENTITY_UNVERIFIED",
			20,
			"An expired ownership lock has no durable launch intent.",
			"Inspect the private lock and profile processes; Warm Browser will not remove or signal them.",
		)
	}
	if (state.phase === "launching") {
		if (adapter.nowEpochMs() - state.createdAtEpochMs <= startingTimeoutMs) {
			staticFailure(
				command,
				runId,
				"START_IN_PROGRESS",
				22,
				"The owned Warm Browser launch transaction has not completed.",
				"Wait briefly, then run warm-browser status --run-id ID.",
				true,
			)
		}
		return recoverLaunching(command, runId, paths, state, adapter)
	}
	const first = adapter.inspectProcess(state.process.pid)
	if (first.kind === "unverifiable") inspectionFailure(command, runId)
	if (first.kind === "absent") {
		removeOwnedState(paths, state.sessionId)
		return { kind: "recovered", stoppedOwnedProcess: false }
	}
	if (
		!isSameProcess(state.process, first.process) ||
		!isOwnedLaunch(first.process, state.launch)
	) identityFailure(command, runId)
	if (state.phase === "starting") {
		if (adapter.nowEpochMs() - state.createdAtEpochMs <= startingTimeoutMs) {
			staticFailure(
				command,
				runId,
				"START_IN_PROGRESS",
				22,
				"The owned Warm Browser start transaction has not completed.",
				"Wait briefly, then run warm-browser status --run-id ID.",
				true,
			)
		}
		const second = adapter.inspectProcess(state.process.pid)
		if (second.kind === "unverifiable") inspectionFailure(command, runId)
		if (second.kind === "absent") {
			removeOwnedState(paths, state.sessionId)
			return { kind: "recovered", stoppedOwnedProcess: false }
		}
		if (
			!isSameProcess(state.process, second.process) ||
			!isOwnedLaunch(second.process, state.launch)
		) identityFailure(command, runId)
		if (!(await adapter.terminateProcessGroup(second.process, state.launch))) {
			staticFailure(
				command,
				runId,
				"UNEXPECTED_FAILURE",
				1,
				"Warm Browser could not clean up its stale starting process group.",
				"Inspect the owned process group and private state before retrying.",
			)
		}
		removeStateAfterStop(command, runId, paths, state.sessionId)
		return { kind: "recovered", stoppedOwnedProcess: true }
	}
	const verification = await adapter.verifyEndpoint({
		host: "127.0.0.1",
		port: state.endpoint.port,
		process: first.process,
	})
	if (verification.kind === "process_unverifiable") inspectionFailure(command, runId)
	if (
		verification.kind !== "verified" ||
		verification.endpoint.browserVersion !== state.endpoint.browserVersion ||
		verification.endpoint.controlledPageTargetId !== state.endpoint.controlledPageTargetId
	) {
		staticFailure(
			command,
			runId,
			"CDP_IDENTITY_UNVERIFIED",
			20,
			"The stored CDP endpoint identity could not be verified.",
			"Inspect the Browser Session with its owned process still preserved.",
		)
	}
	return { kind: "running", state }
}

function sessionData(state: RunningBrowserSessionState, postcondition: "running" | "absent") {
	return {
		sessionId: state.sessionId,
		startRunId: state.startRunId,
		processId: state.process.pid,
		endpoint: { host: state.endpoint.host, port: state.endpoint.port },
		controlledPage: { targetId: state.endpoint.controlledPageTargetId },
		postcondition,
	}
}

function recoveredData(trigger: SliceCommand, stoppedOwnedProcess: boolean) {
	return { trigger, postcondition: "absent", removedState: true, stoppedOwnedProcess }
}

function recoveredStop(parsed: ParsedCommand, stoppedOwnedProcess: boolean): CliOutcome {
	return success({
		schemaVersion,
		status: "ok",
		command: "stop",
		resultCode: "STALE_SESSION_RECOVERED",
		runId: parsed.runId,
		transactionState: "recovered",
		retrySafe: true,
		nextAction: "Run warm-browser start --run-id ID when another Browser Session is needed.",
		data: recoveredData("stop", stoppedOwnedProcess),
	})
}

async function start(
	parsed: ParsedCommand,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
	const inspection = await inspectSession("start", parsed.runId, paths, adapter)
	const priorTx: TransactionState = inspection.kind === "recovered" ? "recovered" : "unchanged"
	if (inspection.kind === "running") {
		staticFailure(
			"start",
			parsed.runId,
			"SESSION_ALREADY_RUNNING",
			21,
			"A verified Browser Session already owns the Agent Chrome Profile.",
			"Run warm-browser status --run-id ID or warm-browser stop --run-id ID.",
		)
	}
	const executable = adapter.chromeExecutable()
	if (adapter.inspectChrome(executable) !== "installed") {
		staticFailure(
			"start",
			parsed.runId,
			"CHROME_UNAVAILABLE",
			20,
			"The fixed installed Google Chrome executable is unavailable.",
			"Install Google Chrome at the fixed macOS application path before retrying.",
			false,
			priorTx,
		)
	}
	const profileRoot = adapter.profileRoot()
	if (adapter.inspectProfile(profileRoot) !== "safe") {
		staticFailure(
			"start",
			parsed.runId,
			"PROFILE_UNSAFE",
			21,
			"The Agent Chrome Profile ownership or permissions are unsafe.",
			"Repair the Agent Chrome Profile ownership and private permissions before retrying.",
			false,
			priorTx,
		)
	}
	const profile = adapter.findProfileProcesses(profileRoot)
	if (profile.kind === "unverifiable") inspectionFailure("start", parsed.runId, priorTx)
	if (profile.processes.length > 1) {
		staticFailure(
			"start",
			parsed.runId,
			"PROFILE_PROCESS_AMBIGUOUS",
			20,
			"More than one live process claims the Agent Chrome Profile.",
			"Inspect the profile process owners before retrying; Warm Browser will not signal them.",
			false,
			priorTx,
		)
	}
	if (profile.processes.length === 1) {
		staticFailure(
			"start",
			parsed.runId,
			"PROFILE_IN_USE",
			21,
			"An unowned process is using the Agent Chrome Profile.",
			"Close the existing profile owner, then retry Warm Browser start.",
			false,
			priorTx,
		)
	}
	const port = parsed.port ?? defaultPort
	const portStatus = await adapter.inspectPort(port)
	if (portStatus === "occupied") {
		staticFailure(
			"start",
			parsed.runId,
			"PORT_OCCUPIED",
			20,
			"The requested loopback CDP port is already occupied.",
			"Inspect the port owner or choose one free start --port override.",
			false,
			priorTx,
		)
	}
	if (portStatus === "unverifiable") {
		staticFailure(
			"start",
			parsed.runId,
			"PORT_UNVERIFIABLE",
			20,
			"Warm Browser could not prove that the requested CDP port is free.",
			"Inspect loopback port state before retrying.",
			false,
			priorTx,
		)
	}
	if (!acquireSessionLock(paths)) {
		staticFailure(
			"start",
			parsed.runId,
			"START_IN_PROGRESS",
			22,
			"Another start transaction acquired Browser Session ownership.",
			"Wait briefly, then run warm-browser status --run-id ID.",
			true,
			priorTx,
		)
	}

	const sessionId = adapter.createSessionId()
	// The launch binds what it will be able to prove about itself before it
	// creates anything, so stale recovery compares bytes rather than guessing
	// which arguments mattered.
	const argumentList = chromeArgumentList({
		profileRoot,
		port,
		launchMarker: sessionId,
	})
	const launching: Extract<BrowserSessionState, { phase: "launching" }> = {
		schemaVersion: 1,
		phase: "launching",
		launch: launchOwnership({ executable, profileRoot, port, launchMarker: sessionId }),
		sessionId,
		startRunId: parsed.runId,
		launchMarker: sessionId,
		createdAtEpochMs: adapter.nowEpochMs(),
		profileRoot,
		endpoint: { host: "127.0.0.1", port },
	}
	let intentWritten = false
	let spawned: BrowserProcessIdentity | undefined
	try {
		writeSessionState(paths, launching)
		intentWritten = true
		spawned = await adapter.spawnChrome({
			executable,
			argumentList,
			ownership: launching.launch,
		})
		const starting: Extract<BrowserSessionState, { phase: "starting" }> = {
			...launching,
			phase: "starting",
			process: canonicalProcess(spawned),
		}
		writeSessionState(paths, starting)
		const verification = await adapter.verifyEndpoint({
			host: "127.0.0.1",
			port,
			process: spawned,
		})
		if (verification.kind === "process_unverifiable") {
			inspectionFailure("start", parsed.runId, priorTx)
		}
		if (verification.kind !== "verified") {
			const mapped = verification.kind === "controlled_page_unavailable"
				? ([
					"CONTROLLED_PAGE_UNAVAILABLE",
					"The verified CDP endpoint exposes no Controlled Page.",
				] as const)
				: verification.kind === "controlled_page_ambiguous"
				? ([
					"CONTROLLED_PAGE_AMBIGUOUS",
					"The verified CDP endpoint exposes more than one page.",
				] as const)
				: ([
					"CDP_IDENTITY_UNVERIFIED",
					"The launched Chrome CDP identity could not be verified.",
				] as const)
			if (!(await adapter.terminateProcessGroup(spawned, launching.launch))) {
				staticFailure(
					"start",
					parsed.runId,
					"UNEXPECTED_FAILURE",
					1,
					"Warm Browser could not roll back its unverified browser process group.",
					"Inspect the owned process group and private state before retrying.",
				)
			}
			// The group is proved stopped, so its cleanup reports the stop it
			// performed rather than escaping into a rollback that would signal
			// an already-stopped group a second time.
			removeStateAfterStop("start", parsed.runId, paths, sessionId)
			staticFailure(
				"start",
				parsed.runId,
				mapped[0] as ResultCode,
				20,
				mapped[1],
				"Inspect installed Chrome and the explicit CDP endpoint before retrying.",
				false,
				"rolled_back",
			)
		}
		const state = runningState(starting, verification.endpoint)
		writeSessionState(paths, state)
		return success({
			schemaVersion,
			status: "ok",
			command: "start",
			resultCode: "SESSION_STARTED",
			runId: parsed.runId,
			transactionState: "started",
			retrySafe: false,
			nextAction: "Run warm-browser status --run-id ID to inspect the Browser Session.",
			data: {
				...sessionData(state, "running"),
				recoveredFrom: inspection.kind === "recovered" ? "stale_session" : null,
			},
		})
	} catch (error) {
		if (error instanceof WarmBrowserFailure) throw error
		if (error instanceof SpawnCleanupUnverifiedError) {
			launchCleanupUnverified(parsed.runId, priorTx)
		}
		if (spawned !== undefined) {
			if (!(await adapter.terminateProcessGroup(spawned, launching.launch))) {
				launchCleanupUnverified(parsed.runId, priorTx)
			}
			removeStateAfterStop("start", parsed.runId, paths, sessionId)
		} else if (intentWritten) {
			removeOwnedState(paths, sessionId)
		} else {
			removeNewEmptyLock(paths)
		}
		staticFailure(
			"start",
			parsed.runId,
			"UNEXPECTED_FAILURE",
			1,
			"Warm Browser start failed unexpectedly.",
			"Inspect private state and the owned process group before retrying.",
			false,
			"rolled_back",
		)
	}
}

async function status(
	parsed: ParsedCommand,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
	const inspection = await inspectSession("status", parsed.runId, paths, adapter)
	if (inspection.kind === "running") {
		return success({
			schemaVersion,
			status: "ok",
			command: "status",
			resultCode: "SESSION_RUNNING",
			runId: parsed.runId,
			transactionState: "unchanged",
			retrySafe: true,
			nextAction:
				"Continue with an implemented Agent Browser command or run warm-browser stop --run-id ID.",
			data: sessionData(inspection.state, "running"),
		})
	}
	if (inspection.kind === "recovered") {
		return success({
			schemaVersion,
			status: "ok",
			command: "status",
			resultCode: "STALE_SESSION_RECOVERED",
			runId: parsed.runId,
			transactionState: "recovered",
			retrySafe: true,
			nextAction: "Run warm-browser start --run-id ID to create a new Browser Session.",
			data: recoveredData("status", inspection.stoppedOwnedProcess),
		})
	}
	return success({
		schemaVersion,
		status: "ok",
		command: "status",
		resultCode: "SESSION_ABSENT",
		runId: parsed.runId,
		transactionState: "unchanged",
		retrySafe: true,
		nextAction: "Run warm-browser start --run-id ID to create a Browser Session.",
		data: { postcondition: "absent" },
	})
}

async function stop(
	parsed: ParsedCommand,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
	const inspection = await inspectSession("stop", parsed.runId, paths, adapter)
	if (inspection.kind === "recovered") {
		return recoveredStop(parsed, inspection.stoppedOwnedProcess)
	}
	if (inspection.kind === "absent") {
		return success({
			schemaVersion,
			status: "ok",
			command: "stop",
			resultCode: "SESSION_ABSENT",
			runId: parsed.runId,
			transactionState: "unchanged",
			retrySafe: true,
			nextAction: "Run warm-browser start --run-id ID when a Browser Session is needed.",
			data: { postcondition: "absent" },
		})
	}
	const state = inspection.state
	const observed = adapter.inspectProcess(state.process.pid)
	if (observed.kind === "unverifiable") inspectionFailure("stop", parsed.runId)
	if (observed.kind === "absent") {
		removeOwnedState(paths, state.sessionId)
		return recoveredStop(parsed, false)
	}
	if (
		!isSameProcess(state.process, observed.process) ||
		!isOwnedLaunch(observed.process, state.launch)
	) identityFailure("stop", parsed.runId)
	if (!(await adapter.terminateProcessGroup(observed.process, state.launch))) {
		staticFailure(
			"stop",
			parsed.runId,
			"UNEXPECTED_FAILURE",
			1,
			"Warm Browser could not stop its verified browser process group.",
			"Inspect the owned process group and private state before retrying.",
		)
	}
	removeStateAfterStop("stop", parsed.runId, paths, state.sessionId)
	return success({
		schemaVersion,
		status: "ok",
		command: "stop",
		resultCode: "SESSION_STOPPED",
		runId: parsed.runId,
		transactionState: "stopped",
		retrySafe: true,
		nextAction: "Run warm-browser start --run-id ID when another Browser Session is needed.",
		data: {
			sessionId: state.sessionId,
			stoppedProcessId: state.process.pid,
			postcondition: "absent",
		},
	})
}

async function execute(parsed: ParsedCommand, adapter: WarmBrowserAdapter): Promise<CliOutcome> {
	if (parsed.command === "help") {
		return success({
			schemaVersion,
			status: "ok",
			command: "help",
			resultCode: "HELP",
			runId: parsed.runId,
			transactionState: "unchanged",
			retrySafe: true,
			nextAction: "Run warm-browser start --run-id ID to create the Browser Session.",
			data: {
				usage: usageLine,
				commands: commandVocabulary.map(({ name, sideEffects }) => ({ name, sideEffects })),
			},
		})
	}
	if (adapter.platform() !== "darwin") {
		staticFailure(
			parsed.command,
			parsed.runId,
			"PLATFORM_UNSUPPORTED",
			21,
			"Warm Browser supports macOS only.",
			"Run Warm Browser on a supported macOS host.",
		)
	}
	let paths: StatePaths
	try {
		paths = resolveStatePaths()
		ensurePrivateState(paths)
	} catch (error) {
		if (error instanceof UnsafeStateError) {
			return failure(
				new WarmBrowserFailure({
					command: parsed.command,
					resultCode: "STATE_UNSAFE",
					exitCode: 20,
					runId: parsed.runId,
					retrySafe: false,
					nextAction: "Repair the private XDG state ownership and permissions before retrying.",
					message: "Warm Browser private state is unsafe or unreadable.",
				}),
			)
		}
		throw error
	}
	if (parsed.command === "start") return start(parsed, paths, adapter)
	if (parsed.command === "status") return status(parsed, paths, adapter)
	return stop(parsed, paths, adapter)
}

/**
 * The Warm Browser entry. It takes an argument list and nothing else: the fixed
 * production Adapter is bound here, so no caller can inject one and no test
 * parameter exists on the production interface.
 */
export async function runWarmBrowserCli(arguments_: readonly string[]): Promise<CliOutcome> {
	const adapter: WarmBrowserAdapter = productionAdapter
	let parsed: ParsedCommand | undefined
	try {
		parsed = parseArguments(arguments_, adapter)
		return await execute(parsed, adapter)
	} catch (error) {
		if (error instanceof WarmBrowserFailure) return failure(error)
		const runId = parsed?.runId ?? candidateRunId(arguments_, adapter)
		const command = parsed?.command ?? "unknown"
		if (error instanceof UnsafeStateError) {
			return failure(
				new WarmBrowserFailure({
					command,
					resultCode: "STATE_UNSAFE",
					exitCode: 20,
					runId,
					retrySafe: false,
					nextAction: "Repair the private XDG state ownership and permissions before retrying.",
					message: "Warm Browser private state is unsafe or unreadable.",
				}),
			)
		}
		return failure(
			new WarmBrowserFailure({
				command,
				resultCode: "UNEXPECTED_FAILURE",
				exitCode: 1,
				runId,
				retrySafe: false,
				nextAction: "Inspect private Warm Browser state before retrying.",
				message: "Warm Browser failed unexpectedly.",
			}),
		)
	}
}
