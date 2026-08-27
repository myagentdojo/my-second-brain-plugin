import {
	schemaVersion,
	type BrowserProcessIdentity,
	type CliCommand,
	type CliOutcome,
	type ErrorEnvelope,
	type ResultCode,
	type SliceCommand,
	SpawnCleanupUnverifiedError,
	type SuccessEnvelope,
	type TransactionState,
	type WarmBrowserAdapter,
} from "./contract"
import {
	acquireSessionLock,
	ensurePrivateState,
	lockAgeMs,
	readSessionState,
	removeOwnedState,
	resolveStatePaths,
	runningState,
	type BrowserSessionState,
	type StatePaths,
	UnsafeStateError,
	validateSessionLock,
	writeSessionState,
} from "./state"

const defaultPort = 9242
const minimumPort = 1024
const maximumPort = 65_535
const startingStateTimeoutMs = 15_000
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

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
		readonly command: CliCommand | "unknown"
		readonly resultCode: ResultCode
		readonly exitCode: 1 | 2 | 20 | 21 | 22
		readonly runId: string
		readonly transactionState?: TransactionState
		readonly retrySafe: boolean
		readonly nextAction: string
		readonly message: string
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

function usage(runId: string, command: CliCommand | "unknown", message: string): never {
	throw new WarmBrowserFailure({
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
		first === undefined || first === "help" || first === "--help" || first === "-h"
			? "help"
			: first === "start" || first === "status" || first === "stop"
				? first
				: "unknown"
	if (command === "unknown") usage(generatedRunId, command, "Unknown Warm Browser command.")

	let runId = generatedRunId
	let port: number | undefined
	let runIdSeen = false
	let portSeen = false
	const startIndex = first === undefined ? 0 : 1
	for (let index = startIndex; index < arguments_.length; index += 1) {
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
			if (!Number.isSafeInteger(port) || port < minimumPort || port > maximumPort) {
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

function requireMacOs(command: CliCommand, runId: string, adapter: WarmBrowserAdapter): void {
	if (adapter.platform() === "darwin") return
	throw new WarmBrowserFailure({
		command,
		resultCode: "PLATFORM_UNSUPPORTED",
		exitCode: 21,
		runId,
		retrySafe: false,
		nextAction: "Run Warm Browser on a supported macOS host.",
		message: "Warm Browser supports macOS only.",
	})
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
	throw new WarmBrowserFailure({
		command,
		resultCode,
		exitCode,
		runId,
		retrySafe,
		nextAction,
		message,
		transactionState,
	})
}

function identityMatches(
	expected: BrowserProcessIdentity,
	observed: BrowserProcessIdentity,
	profileRoot: string,
	port: number,
): boolean {
	const userDataFlag = `--user-data-dir=${profileRoot}`
	const quotedUserDataFlag = `--user-data-dir="${profileRoot}"`
	return (
		observed.pid === expected.pid &&
		observed.processGroupId === expected.processGroupId &&
		observed.processGroupId === observed.pid &&
		observed.startedAtToken === expected.startedAtToken &&
		observed.executable === expected.executable &&
		observed.commandLine.startsWith(expected.executable) &&
		(observed.commandLine.includes(userDataFlag) || observed.commandLine.includes(quotedUserDataFlag)) &&
		observed.commandLine.includes("--remote-debugging-address=127.0.0.1") &&
		observed.commandLine.includes(`--remote-debugging-port=${port}`)
	)
}

function canonicalProcess(processIdentity: BrowserProcessIdentity): BrowserProcessIdentity {
	return {
		pid: processIdentity.pid,
		processGroupId: processIdentity.processGroupId,
		startedAtToken: processIdentity.startedAtToken,
		executable: processIdentity.executable,
		commandLine: processIdentity.commandLine,
	}
}

interface SessionInspection {
	readonly kind: "absent" | "running" | "recovered"
	readonly state?: BrowserSessionState
	readonly stoppedOwnedProcess?: boolean
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
		if (lockAgeMs(paths, adapter.nowEpochMs()) <= startingStateTimeoutMs) {
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
			"An expired ownership lock has no process identity receipt.",
			"Inspect the private lock and profile processes; Warm Browser will not remove or signal them.",
		)
	}

	const observed = adapter.inspectProcess(state.process.pid)
	if (observed === undefined) {
		removeOwnedState(paths)
		return { kind: "recovered", stoppedOwnedProcess: false }
	}
	if (!identityMatches(state.process, observed, state.profileRoot, state.endpoint.port)) {
		staticFailure(
			command,
			runId,
			"PROCESS_IDENTITY_UNVERIFIED",
			20,
			"The stored browser process identity does not match the live process.",
			"Inspect the live process and private Warm Browser state; do not signal the stored process id.",
		)
	}

	if (state.phase === "starting") {
		if (adapter.nowEpochMs() - state.createdAtEpochMs <= startingStateTimeoutMs) {
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
		if (!(await adapter.terminateProcessGroup(observed))) {
			staticFailure(
				command,
				runId,
				"UNEXPECTED_FAILURE",
				1,
				"Warm Browser could not clean up its stale starting process group.",
				"Inspect the owned process group and private state before retrying.",
			)
		}
		removeOwnedState(paths)
		return { kind: "recovered", stoppedOwnedProcess: true }
	}

	const verification = await adapter.verifyEndpoint({
		host: "127.0.0.1",
		port: state.endpoint.port,
		process: observed,
	})
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

function sessionData(state: BrowserSessionState, postcondition: "running" | "absent") {
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

async function start(
	parsed: ParsedCommand,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
	const inspection = await inspectSession("start", parsed.runId, paths, adapter)
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
	const recovered = inspection.kind === "recovered"
	const chromeExecutable = adapter.chromeExecutable()
	if (adapter.inspectChrome(chromeExecutable) !== "installed") {
		staticFailure(
			"start",
			parsed.runId,
			"CHROME_UNAVAILABLE",
			20,
			"The fixed installed Google Chrome executable is unavailable.",
			"Install Google Chrome at the fixed macOS application path before retrying.",
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
		)
	}
	const profileProcesses = adapter.findProfileProcesses(profileRoot)
	if (profileProcesses.length > 1) {
		staticFailure(
			"start",
			parsed.runId,
			"PROFILE_PROCESS_AMBIGUOUS",
			20,
			"More than one live process claims the Agent Chrome Profile.",
			"Inspect the profile process owners before retrying; Warm Browser will not signal them.",
		)
	}
	if (profileProcesses.length === 1) {
		staticFailure(
			"start",
			parsed.runId,
			"PROFILE_IN_USE",
			21,
			"An unowned process is using the Agent Chrome Profile.",
			"Close the existing profile owner, then retry Warm Browser start.",
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
		)
	}

	let spawned: BrowserProcessIdentity | undefined
	try {
		spawned = await adapter.spawnChrome({
			executable: chromeExecutable,
			profileRoot,
			port,
		})
		const startingState: BrowserSessionState = {
			schemaVersion: 1,
			phase: "starting",
			sessionId: adapter.createSessionId(),
			startRunId: parsed.runId,
			createdAtEpochMs: adapter.nowEpochMs(),
			profileRoot,
			process: canonicalProcess(spawned),
			endpoint: { host: "127.0.0.1", port },
		}
		writeSessionState(paths, startingState)
		const verification = await adapter.verifyEndpoint({
			host: "127.0.0.1",
			port,
			process: spawned,
		})
		if (verification.kind !== "verified") {
			const mapped =
				verification.kind === "controlled_page_unavailable"
					? (["CONTROLLED_PAGE_UNAVAILABLE", "The verified CDP endpoint exposes no Controlled Page."] as const)
					: verification.kind === "controlled_page_ambiguous"
						? (["CONTROLLED_PAGE_AMBIGUOUS", "The verified CDP endpoint exposes more than one page."] as const)
						: (["CDP_IDENTITY_UNVERIFIED", "The launched Chrome CDP identity could not be verified."] as const)
			if (!(await adapter.terminateProcessGroup(spawned))) {
				staticFailure(
					"start",
					parsed.runId,
					"UNEXPECTED_FAILURE",
					1,
					"Warm Browser could not roll back its unverified browser process group.",
					"Inspect the owned process group and private state before retrying.",
				)
			}
			removeOwnedState(paths)
			staticFailure(
				"start",
				parsed.runId,
				mapped[0],
				20,
				mapped[1],
				"Inspect installed Chrome and the explicit CDP endpoint before retrying.",
				false,
				"rolled_back",
			)
		}
		const state = runningState(startingState, verification.endpoint)
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
				recoveredFrom: recovered ? "stale_session" : null,
			},
		})
	} catch (error) {
		if (error instanceof WarmBrowserFailure) throw error
		const cleanupUnverified = error instanceof SpawnCleanupUnverifiedError
		if (spawned !== undefined) {
			const terminated = await adapter.terminateProcessGroup(spawned)
			if (terminated) removeOwnedState(paths)
		} else if (!(error instanceof SpawnCleanupUnverifiedError)) {
			removeOwnedState(paths)
		}
		staticFailure(
			"start",
			parsed.runId,
			"UNEXPECTED_FAILURE",
			1,
			"Warm Browser start failed unexpectedly.",
			"Inspect private state and the owned process group before retrying.",
			false,
			spawned === undefined && !cleanupUnverified ? "rolled_back" : "unchanged",
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
			nextAction: "Continue with an implemented Agent Browser command or run warm-browser stop --run-id ID.",
			data: sessionData(inspection.state!, "running"),
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
			data: recoveredData("status", inspection.stoppedOwnedProcess ?? false),
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
		return success({
			schemaVersion,
			status: "ok",
			command: "stop",
			resultCode: "STALE_SESSION_RECOVERED",
			runId: parsed.runId,
			transactionState: "recovered",
			retrySafe: true,
			nextAction: "Run warm-browser start --run-id ID when another Browser Session is needed.",
			data: recoveredData("stop", inspection.stoppedOwnedProcess ?? false),
		})
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
	const state = inspection.state!
	const observed = adapter.inspectProcess(state.process.pid)
	if (
		observed === undefined ||
		!identityMatches(state.process, observed, state.profileRoot, state.endpoint.port)
	) {
		staticFailure(
			"stop",
			parsed.runId,
			"PROCESS_IDENTITY_UNVERIFIED",

			20,
			"The owned browser process identity changed before stop.",
			"Inspect the live process and private state; Warm Browser did not signal it.",
		)
	}
	if (!(await adapter.terminateProcessGroup(observed))) {
		staticFailure(
			"stop",
			parsed.runId,
			"UNEXPECTED_FAILURE",
			1,
			"Warm Browser could not stop its verified browser process group.",
			"Inspect the owned process group and private state before retrying.",
		)
	}
	removeOwnedState(paths)
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

async function execute(
	parsed: ParsedCommand,
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
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
				usage: "warm-browser <help|start|status|stop> [--run-id ID] [--port NUMBER]",
				commands: [
					{ name: "help", sideEffects: "none" },
					{ name: "start", sideEffects: "starts one owned browser process group" },
					{ name: "status", sideEffects: "may remove proved stale private state" },
					{ name: "stop", sideEffects: "stops one verified owned browser process group" },
				],
			},
		})
	}
	requireMacOs(parsed.command, parsed.runId, adapter)
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

export async function runWarmBrowserCli(
	arguments_: readonly string[],
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
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
					transactionState: "unchanged",
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
				transactionState: "unchanged",
				retrySafe: false,
				nextAction: "Inspect private Warm Browser state before retrying.",
				message: "Warm Browser failed unexpectedly.",
			}),
		)
	}
}
