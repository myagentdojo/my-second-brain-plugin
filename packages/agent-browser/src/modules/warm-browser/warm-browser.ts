import {
	type BrowserProcessIdentity,
	type CliCommand,
	type CliOutcome,
	type CommandOption,
	commandVocabulary,
	type ControlledPageBasis,
	type EndpointVerification,
	type ErrorEnvelope,
	type PageCapture,
	type PageCommand,
	refusedDestinationFlags,
	refusedSelectorFlags,
	type ResultCode,
	runIdOption,
	schemaVersion,
	type SliceCommand,
	SpawnCleanupUnverifiedError,
	type SuccessEnvelope,
	type TransactionState,
	type UndeliverableAct,
} from "./contract"
import type { WarmBrowserAdapter } from "./adapter"
import { fillValueLimit, startingTimeoutMs } from "./bounds"
import {
	actOnControlledPage,
	captureControlledPage,
	type ControlledPageAction,
	openControlledPage,
	readControlledPageSnapshot,
	sameBasis,
} from "./controlled-page"
import {
	chromeArgumentList,
	isOwnedLaunch,
	isSameProcess,
	launchOwnership,
} from "./ownership"
import { productionAdapter } from "./production-adapter"
import { readPortableNetworkGraphic } from "./screenshot"
import {
	publishedElements,
	type ReferenceResolution,
	resolveSnapshotReference,
	type SnapshotGeneration,
} from "./snapshot"
import {
	acquireSessionLock,
	type BrowserSessionState,
	ensurePrivateState,
	lockAgeMs,
	readSessionState,
	removeNewEmptyLock,
	removeOwnedScreenshots,
	removeOwnedState,
	resolveStatePaths,
	type RunningBrowserSessionState,
	runningState,
	type StatePaths,
	UnsafeStateError,
	validateSessionLock,
	writeOwnedScreenshot,
	writeSessionState,
} from "./state"

const defaultPort = 9242
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const controlCharacter = /\p{Cc}/u
const commandNames = new Set<string>(commandVocabulary.map(({ name }) => name))
const selectorFlags = new Set<string>(refusedSelectorFlags)
const destinationFlags = new Set<string>(refusedDestinationFlags)

/** One option rendered the way usage names it. */
function renderOption(option: CommandOption): string {
	return option.value === null ? `[${option.flag}]` : `[${option.flag} ${option.value}]`
}

/** Generated from the single Command Vocabulary owner; never restated. */
const usageLine = `warm-browser <${commandVocabulary.map(({ name }) => name).join("|")}> ${
	[
		runIdOption,
		...commandVocabulary.flatMap(({ options }) => options as readonly CommandOption[]),
	]
		.filter((option, index, all) => all.findIndex((other) => other.flag === option.flag) === index)
		.map(renderOption)
		.join(" ")
}`

interface ParsedCommand {
	readonly command: CliCommand
	readonly runId: string
	readonly port?: number
	readonly url?: string
	readonly reference?: string
	readonly value?: string
	readonly adoptPage: boolean
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

/**
 * Refuses a public selector by name. A selector is not a mistyped argument: the
 * interface has no selector at any command, and the answer is always the same
 * one, so the caller is told that rather than being told its argument was
 * unrecognised.
 */
function selectorRefusal(runId: string, command: CliCommand | "unknown", flag: string): never {
	raise({
		command,
		resultCode: "SELECTOR_UNSUPPORTED",
		exitCode: 21,
		runId,
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID and act through the references it issues.",
		message: `Warm Browser acts through Snapshot References, not the ${flag} selector.`,
	})
}

/**
 * Refuses an output destination by name. No command anywhere accepts one: a
 * Screenshot is written where the Browser Session owns it and nowhere else, so
 * the caller is told that rather than being told its argument was unrecognised.
 */
function destinationRefusal(runId: string, command: CliCommand | "unknown", flag: string): never {
	raise({
		command,
		resultCode: "SCREENSHOT_PATH_UNSUPPORTED",
		exitCode: 21,
		runId,
		retrySafe: false,
		nextAction: "Run warm-browser screenshot --run-id ID and read the owned path it returns.",
		message: `Warm Browser writes a Screenshot where its Browser Session owns it, not to the ${flag} destination.`,
	})
}

/** The shape of an option name, which is the only argument text ever repeated. */
const optionFlag = /^--[a-z][a-z0-9-]{0,31}$/

/**
 * Says which argument was rejected, without saying what came with it.
 *
 * An option is named, because its name is the thing the caller has to correct
 * and an option name carries nothing private. Anything else is described rather
 * than repeated: a bare argument is where a value would be, and a value may be
 * anything at all, so it is never echoed into a result a caller may log.
 */
function unsupportedArgument(argument: string): string {
	return optionFlag.test(argument)
		? `Warm Browser does not accept the ${argument} option here.`
		: "Warm Browser accepts options here, and this argument is not one."
}

function safeUrl(value: string): URL | undefined {
	try {
		return new URL(value)
	} catch {
		return undefined
	}
}

/**
 * What each option's value must be, declared once per flag. A command that
 * accepts a flag accepts exactly the same values for it as every other command
 * that does, because the rule belongs to the flag and not to the command.
 */
type OptionValidator = (runId: string, command: CliCommand, raw: string) => string | number

const optionValidators: Readonly<Record<string, OptionValidator>> = {
	"--run-id": (runId, command, raw) => {
		if (!runIdPattern.test(raw)) usage(runId, command, "The --run-id value is missing or invalid.")
		return raw
	},
	"--port": (runId, command, raw) => {
		if (!/^[0-9]+$/.test(raw)) usage(runId, command, "The --port value must be a decimal port number.")
		const port = Number(raw)
		if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
			usage(runId, command, "The --port value must be between 1024 and 65535.")
		}
		return port
	},
	"--url": (runId, command, raw) => {
		const parsed = raw.length > 2_048 || controlCharacter.test(raw) ? undefined : safeUrl(raw)
		if (parsed === undefined) usage(runId, command, "The --url value must be an absolute URL.")
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			raise({
				command,
				resultCode: "NAVIGATION_TARGET_REFUSED",
				exitCode: 21,
				runId,
				retrySafe: false,
				nextAction: "Run warm-browser open --url URL --run-id ID with an http or https address.",
				message: "Warm Browser opens http and https pages only.",
			})
		}
		return raw
	},
	"--ref": (runId, command, raw) => {
		if (raw === "" || raw.length > 160 || /\s/u.test(raw) || controlCharacter.test(raw)) {
			usage(runId, command, "The --ref value is missing or invalid.")
		}
		return raw
	},
	"--value": (runId, command, raw) => {
		if (raw === "" || raw.length > fillValueLimit || controlCharacter.test(raw)) {
			usage(runId, command, "The --value text is missing or invalid.")
		}
		return raw
	},
}

/**
 * Reads the options one command was given. Every rejection names the flag it is
 * about, so the run identity is tracked as it is read: a later refusal already
 * carries the identity the caller asked for.
 */
function readOptions(
	arguments_: readonly string[],
	firstOptionIndex: number,
	command: CliCommand,
	accepted: ReadonlyMap<string, CommandOption>,
	generatedRunId: string,
): { readonly seen: ReadonlyMap<string, string | number | true>; readonly runId: string } {
	const seen = new Map<string, string | number | true>()
	let runId = generatedRunId
	for (let index = firstOptionIndex; index < arguments_.length; index += 1) {
		const argument = arguments_[index]!
		if (selectorFlags.has(argument)) selectorRefusal(runId, command, argument)
		if (destinationFlags.has(argument)) destinationRefusal(runId, command, argument)
		const option = accepted.get(argument)
		if (option === undefined) usage(runId, command, unsupportedArgument(argument))
		if (seen.has(option.flag)) usage(runId, command, `The ${option.flag} flag may appear only once.`)
		if (option.value === null) {
			seen.set(option.flag, true)
			continue
		}
		const raw = arguments_[index + 1]
		if (raw === undefined) usage(runId, command, `The ${option.flag} value is missing.`)
		const value = optionValidators[option.flag]!(runId, command, raw)
		seen.set(option.flag, value)
		if (option.flag === runIdOption.flag) runId = value as string
		index += 1
	}
	return { seen, runId }
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
	if (command === "unknown") {
		// A selector in the command position is still a selector, and this caller
		// named no command at all, so the refusal says so rather than answering on
		// behalf of a command it never ran.
		if (first !== undefined && selectorFlags.has(first)) {
			selectorRefusal(generatedRunId, command, first)
		}
		// A destination in the command position is still a destination, for the
		// same reason.
		if (first !== undefined && destinationFlags.has(first)) {
			destinationRefusal(generatedRunId, command, first)
		}
		usage(generatedRunId, command, "Unknown Warm Browser command.")
	}
	// The options this command accepts, from the one vocabulary that declares
	// them. A flag another command accepts is not accepted here.
	const accepted = new Map<string, CommandOption>([
		[runIdOption.flag, runIdOption],
		...(commandVocabulary.find(({ name }) => name === command)!.options as readonly CommandOption[])
			.map((option) => [option.flag, option] as const),
	])
	const { seen, runId } = readOptions(
		arguments_,
		first === undefined ? 0 : 1,
		command,
		accepted,
		generatedRunId,
	)
	for (const option of accepted.values()) {
		if (option.required && !seen.has(option.flag)) {
			usage(runId, command, `The ${option.flag} option is required by ${command}.`)
		}
	}
	const port = seen.get("--port")
	const url = seen.get("--url")
	const reference = seen.get("--ref")
	const value = seen.get("--value")
	return {
		command,
		runId,
		adoptPage: seen.get("--adopt-page") === true,
		...(port === undefined ? {} : { port: port as number }),
		...(url === undefined ? {} : { url: url as string }),
		...(reference === undefined ? {} : { reference: reference as string }),
		...(value === undefined ? {} : { value: value as string }),
	}
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

/**
 * The one owner of what an endpoint that did not verify means. A page that is
 * missing and a page that is one of several are findings about the Controlled
 * Page, not about the browser, and every command names them the same way
 * because they all read this table. Only the subject differs: a start is
 * describing the browser it just launched, and every later command is
 * describing the endpoint its receipt already names.
 */
function endpointRefusal(
	verification: Exclude<EndpointVerification["kind"], "verified" | "process_unverifiable">,
	subject: "launched Chrome CDP" | "stored CDP endpoint",
): readonly [ResultCode, string] {
	if (verification === "controlled_page_unavailable") {
		return ["CONTROLLED_PAGE_UNAVAILABLE", "The verified CDP endpoint exposes no Controlled Page."]
	}
	if (verification === "controlled_page_ambiguous") {
		return ["CONTROLLED_PAGE_AMBIGUOUS", "The verified CDP endpoint exposes more than one page."]
	}
	return ["CDP_IDENTITY_UNVERIFIED", `The ${subject} identity could not be verified.`]
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
	| {
		readonly kind: "running"
		readonly state: RunningBrowserSessionState
		/** Whether this inspection bound a replacement page it was asked to adopt. */
		readonly adoptedPage: boolean
	}
	| { readonly kind: "recovered"; readonly stoppedOwnedProcess: boolean }

/**
 * How one inspection answers a Controlled Page that is not the one the receipt
 * names. Adoption is only ever asked for by a caller that said so on its own
 * command line, so a page can never be replaced under a caller that did not.
 */
type PageReplacementPolicy = "refuse" | "adopt"

/**
 * Rebinds the Browser Session to a replacement Controlled Page and drops the
 * Snapshot Generation with it. Every reference this session issued was issued
 * against the page that is gone, so none of them may survive the rebinding.
 */
function adoptControlledPage(
	state: RunningBrowserSessionState,
	controlledPageTargetId: string,
): RunningBrowserSessionState {
	const rebound = withoutSnapshot(state)
	return { ...rebound, endpoint: { ...rebound.endpoint, controlledPageTargetId } }
}

/**
 * Removes a stale launch receipt only when its absence is proved twice over: no
 * process still carries the launch marker, and no process still owns the Agent
 * Chrome Profile.
 *
 * A marker is one argument on a command line. It can be lost or rewritten while
 * the browser it named is still running, so a marker that matches nothing does
 * not prove the launch gone. Removing the receipt on that alone would leave a
 * live browser holding the Agent Chrome Profile with nothing accounting for it.
 */
function recoverAbsentLaunch(
	command: SliceCommand,
	runId: string,
	paths: StatePaths,
	state: Extract<BrowserSessionState, { phase: "launching" }>,
	adapter: WarmBrowserAdapter,
): SessionInspection {
	const owners = adapter.findProfileProcesses(state.profileRoot)
	if (owners.kind === "unverifiable") inspectionFailure(command, runId)
	if (owners.processes.length > 0) identityFailure(command, runId)
	removeOwnedState(paths, state.sessionId)
	return { kind: "recovered", stoppedOwnedProcess: false }
}

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
		return recoverAbsentLaunch(command, runId, paths, state, adapter)
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
		return recoverAbsentLaunch(command, runId, paths, state, adapter)
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

/**
 * Proves a durable receipt is one this code could have written, before anything
 * is observed, removed, or signalled on its behalf.
 *
 * Everything the receipt says about the launch is also derivable from the fixed
 * production Adapter and its own session identity. A receipt that disagrees was
 * rebound after it was written, by an edit, a restore, or a different build, and
 * acting on it would mean signalling or deleting on behalf of a session this
 * process never owned. Each disagreement fails closed and leaves the receipt and
 * the lock exactly as they are.
 */
function proveReceiptContract(
	command: SliceCommand,
	runId: string,
	state: BrowserSessionState,
	adapter: WarmBrowserAdapter,
): void {
	const port = state.endpoint.port
	if (
		state.profileRoot !== adapter.profileRoot() ||
		state.launchMarker !== state.sessionId ||
		port < 1024 ||
		port > 65_535
	) {
		throw new UnsafeStateError()
	}
	const canonical = launchOwnership({
		executable: adapter.chromeExecutable(),
		profileRoot: state.profileRoot,
		port,
		launchMarker: state.launchMarker,
	})
	if (
		state.launch.executable !== canonical.executable ||
		state.launch.commandLine !== canonical.commandLine
	) {
		throw new UnsafeStateError()
	}
	if (
		state.phase !== "launching" &&
		(state.process.executable !== state.launch.executable ||
			state.process.commandLine !== state.launch.commandLine)
	) {
		identityFailure(command, runId)
	}
}

async function inspectSession(
	command: SliceCommand,
	runId: string,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
	pageReplacement: PageReplacementPolicy = "refuse",
): Promise<SessionInspection> {
	const lockExists = validateSessionLock(paths)
	const state = readSessionState(paths)
	if (state !== undefined) proveReceiptContract(command, runId, state, adapter)
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
	const preservedProcessAction = "Inspect the Browser Session with its owned process still preserved."
	if (verification.kind !== "verified") {
		const [resultCode, message] = endpointRefusal(verification.kind, "stored CDP endpoint")
		staticFailure(command, runId, resultCode, 20, message, preservedProcessAction)
	}
	if (verification.endpoint.browserVersion !== state.endpoint.browserVersion) {
		const [resultCode, message] = endpointRefusal("browser_unverified", "stored CDP endpoint")
		staticFailure(command, runId, resultCode, 20, message, preservedProcessAction)
	}
	// The verified browser still exposes exactly one page, and it is a different
	// one. That is a page replacement, and it is never adopted silently: every
	// reference this session issued belongs to the page that is gone.
	if (verification.endpoint.controlledPageTargetId !== state.endpoint.controlledPageTargetId) {
		if (pageReplacement === "refuse") {
			// The refusal comes after the invalidation, not instead of it. Every
			// reference this session issued belongs to a page that is gone, so it
			// stops existing here whether or not the caller ever adopts the
			// replacement, and a later command reloading this receipt cannot find
			// one to resolve.
			const transaction = invalidationState(state)
			invalidateReferences(command, runId, paths, state, "invalidated")
			staticFailure(
				command,
				runId,
				"CONTROLLED_PAGE_REPLACED",
				20,
				"The Browser Session's Controlled Page was replaced by another page.",
				"Run warm-browser open --url URL --adopt-page --run-id ID to bind the replacement Controlled Page.",
				false,
				transaction,
			)
		}
		const adopted = adoptControlledPage(state, verification.endpoint.controlledPageTargetId)
		writeSessionState(paths, adopted)
		return { kind: "running", state: adopted, adoptedPage: true }
	}
	return { kind: "running", state, adoptedPage: false }
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
			const mapped = endpointRefusal(verification.kind, "launched Chrome CDP")
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
				mapped[0],
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

/**
 * The Browser Session a page command is allowed to act through, and whether
 * this command bound a replacement Controlled Page on its way in.
 */
interface ControlledSession {
	readonly state: RunningBrowserSessionState
	readonly adoptedPage: boolean
}

/**
 * A required option is declared required by the one vocabulary the parser reads,
 * so a command missing it never reaches execution. Reaching here means those two
 * disagree, which is a defect rather than a caller mistake.
 */
function requiredArgument(value: string | undefined): string {
	if (value === undefined) throw new Error("a required option reached execution unset")
	return value
}

async function requireControlledPage(
	parsed: ParsedCommand,
	command: PageCommand,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<ControlledSession> {
	const inspection = await inspectSession(
		command,
		parsed.runId,
		paths,
		adapter,
		parsed.adoptPage ? "adopt" : "refuse",
	)
	if (inspection.kind === "running") {
		return { state: inspection.state, adoptedPage: inspection.adoptedPage }
	}
	staticFailure(
		command,
		parsed.runId,
		"SESSION_ABSENT",
		21,
		"No verified Browser Session owns a Controlled Page.",
		"Run warm-browser start --run-id ID to create a Browser Session.",
		false,
		inspection.kind === "recovered" ? "recovered" : "unchanged",
	)
}

/**
 * Records what a page command left behind. A command that has already reached
 * the Controlled Page never reports itself unchanged because its receipt could
 * not be written; it names the state that needs repairing instead.
 */
function recordAfterAction(
	command: SliceCommand,
	runId: string,
	paths: StatePaths,
	state: RunningBrowserSessionState,
	transactionState: Extract<TransactionState, "acted" | "invalidated">,
): void {
	try {
		writeSessionState(paths, state)
	} catch {
		staticFailure(
			command,
			runId,
			"STATE_UNSAFE",
			20,
			"Warm Browser could not record the Snapshot Generation its Controlled Page left behind.",
			"Repair the private Warm Browser session state; the Snapshot References it holds are already dead.",
			false,
			transactionState,
		)
	}
}

/** The same Browser Session with no live Snapshot Generation. */
function withoutSnapshot(state: RunningBrowserSessionState): RunningBrowserSessionState {
	const { snapshot: _invalidated, ...rest } = state
	return rest
}

/**
 * What a refusal that drops this session's references may truthfully call
 * itself.
 *
 * A session that held a generation really did lose durable state and says so. A
 * session that held none lost nothing, and calling that `invalidated` would
 * claim a loss the caller never suffered.
 */
function invalidationState(
	state: RunningBrowserSessionState,
): Extract<TransactionState, "invalidated" | "unchanged"> {
	return state.snapshot === undefined ? "unchanged" : "invalidated"
}

/**
 * Drops every reference this session issued. Invalidation is durable and it is
 * total: there is no list of dead references to consult later, because the
 * generation they name stops existing.
 *
 * The transaction the caller will report is passed in rather than guessed here.
 * `acted` says the command had already reached the Controlled Page when it
 * dropped the references; `invalidated` says it had not, and that only the
 * references are gone.
 */
function invalidateReferences(
	command: SliceCommand,
	runId: string,
	paths: StatePaths,
	state: RunningBrowserSessionState,
	transactionState: Extract<TransactionState, "acted" | "invalidated">,
): RunningBrowserSessionState {
	if (state.snapshot === undefined) return state
	const cleared = withoutSnapshot(state)
	recordAfterAction(command, runId, paths, cleared, transactionState)
	return cleared
}

function controlledPageData(basis: ControlledPageBasis): Record<string, unknown> {
	return { targetId: basis.targetId, url: basis.url }
}

const freshSnapshotAction =
	"Run warm-browser snapshot --run-id ID to issue fresh Snapshot References."

function pageControlUnverified(
	command: PageCommand,
	runId: string,
	message: string,
	transactionState: TransactionState,
): never {
	staticFailure(
		command,
		runId,
		"PAGE_CONTROL_UNVERIFIED",
		20,
		message,
		"Inspect the Browser Session and its CDP endpoint before retrying.",
		false,
		transactionState,
	)
}

/**
 * The one owner of why a reference cannot be used. Each answer is distinct on
 * purpose: a caller that held no generation, one that named something that is
 * not a reference, one that named an element this generation does not have, and
 * one whose reference belongs to a generation that is gone all need different
 * next steps.
 */
function refuseReference(
	command: PageCommand,
	runId: string,
	resolution: Exclude<ReferenceResolution["kind"], "resolved">,
): never {
	if (resolution === "absent") {
		staticFailure(
			command,
			runId,
			"SNAPSHOT_ABSENT",
			21,
			"This Browser Session holds no Snapshot Generation.",
			"Run warm-browser snapshot --run-id ID before acting on the Controlled Page.",
		)
	}
	const [resultCode, message] = resolution === "malformed"
		? ([
			"SNAPSHOT_REFERENCE_INVALID",
			"Warm Browser acts through a Snapshot Reference, and this is not one.",
		] as const)
		: resolution === "unknown"
		? ([
			"SNAPSHOT_REFERENCE_INVALID",
			"The Snapshot Reference names no element of the current Snapshot Generation.",
		] as const)
		: ([
			"SNAPSHOT_REFERENCE_STALE",
			"The Snapshot Reference belongs to another Snapshot Generation, another Controlled Page, or a generation that has expired.",
		] as const)
	staticFailure(command, runId, resultCode, 21, message, freshSnapshotAction)
}

/**
 * The one owner of what an act that could not be delivered says to its caller.
 *
 * Each reason is a different thing the live page did, and each is said plainly,
 * because "not actionable" alone would leave the caller guessing between an
 * element something is covering, a field that would not hold focus, and a field
 * that already has content in it. All of them are answered by taking a fresh
 * snapshot and looking again, so they share one result code and one next step.
 */
const undeliverableMessages: Readonly<Record<UndeliverableAct, string>> = {
	click_target_unproved: "Warm Browser could not prove the click would reach the referenced element.",
	field_unreadable: "Warm Browser could not read the referenced field before typing into it.",
	field_not_empty: "Warm Browser fills an empty field, and the referenced one already holds a value.",
	field_not_focusable: "Warm Browser could not focus the referenced field.",
	field_focus_moved: "Warm Browser could not prove the referenced field holds focus.",
}

/**
 * What an act that dispatched nothing did to the Controlled Page.
 *
 * A refusal decided before the page was asked for anything left it alone. One
 * that got as far as scrolling an element into view or asking a field for focus
 * did not, and `unchanged` would deny the scroll, the moved focus, and every
 * handler the page ran because of them.
 */
function actTransaction(touchedPage: boolean): TransactionState {
	return touchedPage ? "acted" : "unchanged"
}

function undeliverableAct(
	command: PageCommand,
	runId: string,
	reason: UndeliverableAct,
	touchedPage: boolean,
): never {
	staticFailure(
		command,
		runId,
		"ELEMENT_NOT_ACTIONABLE",
		21,
		undeliverableMessages[reason],
		freshSnapshotAction,
		false,
		actTransaction(touchedPage),
	)
}

function credentialRefusal(command: PageCommand, runId: string): never {
	staticFailure(
		command,
		runId,
		"CREDENTIAL_FIELD_REFUSED",
		21,
		"Warm Browser does not type credentials into the Controlled Page.",
		"Use the Warm Browser login command for a credential field; it is not callable in this slice.",
	)
}

async function open(
	parsed: ParsedCommand,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
	const session = await requireControlledPage(parsed, "open", paths, adapter)
	// Every open invalidates first. A navigation that the browser refuses, and
	// one whose outcome cannot be verified, both leave a page nobody has re-read,
	// so no reference issued before it may survive either outcome.
	const state = invalidateReferences("open", parsed.runId, paths, session.state, "acted")
	const navigation = await openControlledPage({
		port: state.endpoint.port,
		targetId: state.endpoint.controlledPageTargetId,
		url: requiredArgument(parsed.url),
	})
	if (navigation.kind === "refused") {
		staticFailure(
			"open",
			parsed.runId,
			"NAVIGATION_FAILED",
			20,
			"The Controlled Page did not complete the requested navigation.",
			"Run warm-browser snapshot --run-id ID to read where the Controlled Page actually is.",
			false,
			"acted",
		)
	}
	if (navigation.kind === "superseded") {
		staticFailure(
			"open",
			parsed.runId,
			"PAGE_IDENTITY_CHANGED",
			21,
			"The Controlled Page is showing a document this navigation did not request.",
			freshSnapshotAction,
			false,
			"acted",
		)
	}
	if (navigation.kind === "unverified") {
		pageControlUnverified(
			"open",
			parsed.runId,
			"Warm Browser could not verify what its Controlled Page did with the navigation.",
			"acted",
		)
	}
	return success({
		schemaVersion,
		status: "ok",
		command: "open",
		resultCode: "PAGE_OPENED",
		runId: parsed.runId,
		transactionState: "acted",
		retrySafe: false,
		nextAction: freshSnapshotAction,
		data: {
			controlledPage: controlledPageData(navigation.basis),
			adoptedPage: session.adoptedPage,
			invalidatedReferences: true,
			postcondition: "running",
		},
	})
}

async function snapshot(
	parsed: ParsedCommand,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
	const session = await requireControlledPage(parsed, "snapshot", paths, adapter)
	const state = session.state
	const reading = await readControlledPageSnapshot({
		port: state.endpoint.port,
		targetId: state.endpoint.controlledPageTargetId,
	})
	if (reading.kind === "identity_changed") {
		// The page moved, so the generation this session was still holding
		// described a page that is gone. No new reference was issued and none of
		// the old ones survives the reading that proved the page moved.
		const transaction = invalidationState(state)
		invalidateReferences("snapshot", parsed.runId, paths, state, "invalidated")
		staticFailure(
			"snapshot",
			parsed.runId,
			"PAGE_IDENTITY_CHANGED",
			21,
			"The Controlled Page moved while it was being read, so no Snapshot Reference was issued.",
			freshSnapshotAction,
			false,
			transaction,
		)
	}
	if (reading.kind === "unverified") {
		pageControlUnverified(
			"snapshot",
			parsed.runId,
			"Warm Browser could not read the Controlled Page.",
			"unchanged",
		)
	}
	const generation: SnapshotGeneration = {
		generationId: adapter.createSnapshotId(),
		takenAtEpochMs: adapter.nowEpochMs(),
		basis: reading.basis,
		truncated: reading.truncated,
		elements: reading.elements,
	}
	recordAfterAction("snapshot", parsed.runId, paths, { ...state, snapshot: generation }, "acted")
	return success({
		schemaVersion,
		status: "ok",
		command: "snapshot",
		resultCode: "SNAPSHOT_TAKEN",
		runId: parsed.runId,
		transactionState: "acted",
		retrySafe: true,
		nextAction:
			"Run warm-browser click --ref REFERENCE --run-id ID or warm-browser fill --ref REFERENCE --value TEXT --run-id ID.",
		data: {
			generationId: generation.generationId,
			controlledPage: controlledPageData(generation.basis),
			elementCount: generation.elements.length,
			truncated: generation.truncated,
			elements: publishedElements(generation),
			postcondition: "running",
		},
	})
}

/**
 * Captures the Controlled Page to the one Screenshot its Browser Session owns.
 * The success path deliberately calls nothing that writes the durable receipt:
 * leaving it untouched is what makes it provable that capturing does not
 * change the Snapshot Generation, and does not invalidate a single reference
 * it issued.
 */
async function screenshot(
	parsed: ParsedCommand,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
	const session = await requireControlledPage(parsed, "screenshot", paths, adapter)
	const state = session.state
	const capture: PageCapture = await captureControlledPage({
		port: state.endpoint.port,
		targetId: state.endpoint.controlledPageTargetId,
	})
	if (capture.kind === "identity_changed") {
		// The page moved, so the generation this session was still holding
		// described a page that is gone. No Screenshot was kept and none of the
		// old references survives the reading that proved the page moved.
		const transaction = invalidationState(state)
		invalidateReferences("screenshot", parsed.runId, paths, state, "invalidated")
		staticFailure(
			"screenshot",
			parsed.runId,
			"PAGE_IDENTITY_CHANGED",
			21,
			"The Controlled Page moved while it was being captured, so no Screenshot was kept.",
			freshSnapshotAction,
			false,
			transaction,
		)
	}
	if (capture.kind === "unverified") {
		pageControlUnverified(
			"screenshot",
			parsed.runId,
			"Warm Browser could not capture the Controlled Page.",
			"unchanged",
		)
	}
	const image = readPortableNetworkGraphic(capture.png)
	if (image === undefined) {
		pageControlUnverified(
			"screenshot",
			parsed.runId,
			"The Controlled Page answered with something that is not one complete PNG image.",
			"unchanged",
		)
	}
	const name = adapter.createScreenshotId()
	// Clear then write, so at most one artifact ever exists and a failure leaves
	// less rather than more.
	const removal = removeOwnedScreenshots(paths)
	// The two removal failures differ only in what the module can still prove
	// about its own state, which is exactly what the transaction names: a refusal
	// deleted nothing, an incomplete removal may have.
	if (removal.kind === "refused") {
		staticFailure(
			"screenshot",
			parsed.runId,
			"STATE_UNSAFE",
			20,
			"Warm Browser could not remove the Screenshot its Browser Session already owned.",
			"Repair the private Warm Browser Screenshot state before capturing again.",
			false,
			"unchanged",
		)
	}
	if (removal.kind === "incomplete") {
		staticFailure(
			"screenshot",
			parsed.runId,
			"STATE_UNSAFE",
			20,
			"Warm Browser began removing the Screenshot its Browser Session owned and could not finish.",
			"Repair the private Warm Browser Screenshot state before capturing again.",
			false,
			"acted",
		)
	}
	let path: string
	try {
		path = writeOwnedScreenshot(paths, name, capture.png)
	} catch {
		staticFailure(
			"screenshot",
			parsed.runId,
			"STATE_UNSAFE",
			20,
			"Warm Browser removed the Screenshot its Browser Session owned and could not write the new one.",
			"Repair the private Warm Browser Screenshot state before capturing again.",
			false,
			"acted",
		)
	}
	return success({
		schemaVersion,
		status: "ok",
		command: "screenshot",
		resultCode: "SCREENSHOT_CAPTURED",
		runId: parsed.runId,
		transactionState: "acted",
		retrySafe: true,
		nextAction:
			"Read the Screenshot at the private path this result names; Warm Browser removes it when the Browser Session stops.",
		data: {
			screenshot: { path, width: image.width, height: image.height, sha256: image.sha256 },
			controlledPage: controlledPageData(capture.basis),
			invalidatedReferences: false,
			postcondition: "running",
		},
	})
}

async function actOnPage(
	parsed: ParsedCommand,
	command: Extract<PageCommand, "click" | "fill">,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
): Promise<CliOutcome> {
	const session = await requireControlledPage(parsed, command, paths, adapter)
	const state = session.state
	const reference = requiredArgument(parsed.reference)
	const resolution = resolveSnapshotReference({
		reference,
		generation: state.snapshot,
		controlledPageTargetId: state.endpoint.controlledPageTargetId,
		nowEpochMs: adapter.nowEpochMs(),
	})
	if (resolution.kind !== "resolved") refuseReference(command, parsed.runId, resolution.kind)
	// A resolved reference always came from the generation this session holds.
	const generation = state.snapshot!
	if (command === "fill" && resolution.element.credentialField) {
		credentialRefusal(command, parsed.runId)
	}
	const action: ControlledPageAction = command === "click"
		? { kind: "click" }
		: { kind: "fill", value: requiredArgument(parsed.value) }
	const outcome = await actOnControlledPage({
		port: state.endpoint.port,
		targetId: state.endpoint.controlledPageTargetId,
		basis: generation.basis,
		backendNodeId: resolution.element.backendNodeId,
		action,
	})
	if (outcome.kind === "identity_changed") {
		// Nothing was dispatched, and nothing survives either: the references were
		// issued against a page this command has just proved is gone.
		const transaction = invalidationState(state)
		invalidateReferences(command, parsed.runId, paths, state, "invalidated")
		staticFailure(
			command,
			parsed.runId,
			"PAGE_IDENTITY_CHANGED",
			21,
			"The Controlled Page is no longer the page this Snapshot Reference was issued against.",
			freshSnapshotAction,
			false,
			transaction,
		)
	}
	if (outcome.kind === "undeliverable") {
		undeliverableAct(command, parsed.runId, outcome.reason, outcome.touchedPage)
	}
	if (outcome.kind === "element_absent") {
		staticFailure(
			command,
			parsed.runId,
			"SNAPSHOT_REFERENCE_STALE",
			21,
			"The referenced element is no longer part of the Controlled Page.",
			freshSnapshotAction,
			false,
			actTransaction(outcome.touchedPage),
		)
	}
	if (outcome.kind === "superseded") {
		// The act reached the page and the page then moved somewhere the act could
		// not have sent it. Nothing about that document is reported as success, and
		// the references that described the one before it do not survive.
		invalidateReferences(command, parsed.runId, paths, state, "acted")
		staticFailure(
			command,
			parsed.runId,
			"PAGE_IDENTITY_CHANGED",
			21,
			"The Controlled Page moved to a document this action did not ask for.",
			freshSnapshotAction,
			false,
			"acted",
		)
	}
	if (outcome.kind === "credential_field") credentialRefusal(command, parsed.runId)
	if (outcome.kind === "unverified") {
		// The conversation stopped without an answer, so what reached the page is
		// unknown. Unknown is never reported as unchanged, and the references that
		// described the page before it are not kept.
		invalidateReferences(command, parsed.runId, paths, state, "acted")
		pageControlUnverified(
			command,
			parsed.runId,
			"Warm Browser could not verify what its Controlled Page did with the action.",
			"acted",
		)
	}
	const invalidatedReferences = !sameBasis(outcome.basis, generation.basis)
	if (invalidatedReferences) invalidateReferences(command, parsed.runId, paths, state, "acted")
	return success({
		schemaVersion,
		status: "ok",
		command,
		resultCode: command === "click" ? "ELEMENT_CLICKED" : "FIELD_FILLED",
		runId: parsed.runId,
		transactionState: "acted",
		retrySafe: false,
		nextAction: freshSnapshotAction,
		data: {
			reference,
			...(command === "fill" ? { valueLength: requiredArgument(parsed.value).length } : {}),
			controlledPage: controlledPageData(outcome.basis),
			invalidatedReferences,
			postcondition: "running",
		},
	})
}

type SliceHandler = (
	parsed: ParsedCommand,
	paths: StatePaths,
	adapter: WarmBrowserAdapter,
) => Promise<CliOutcome>

/**
 * One handler per product command, so adding a command is declaring it rather
 * than editing a chain that another command could fall through.
 */
const sliceCommands: Readonly<Record<SliceCommand, SliceHandler>> = {
	start,
	status,
	open,
	snapshot,
	screenshot,
	click: (parsed, paths, adapter) => actOnPage(parsed, "click", paths, adapter),
	fill: (parsed, paths, adapter) => actOnPage(parsed, "fill", paths, adapter),
	stop,
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
				commands: commandVocabulary.map(({ name, sideEffects, options }) => ({
					name,
					sideEffects,
					options: (options as readonly CommandOption[]).map(({ flag, value, required }) => ({
						flag,
						value,
						required,
					})),
				})),
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
	return sliceCommands[parsed.command](parsed, paths, adapter)
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
