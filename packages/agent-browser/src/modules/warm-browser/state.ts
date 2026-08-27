import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

import { snapshotElementLimit, snapshotTextLimit } from "./bounds"
import type { BrowserProcessIdentity, ControlledPageElement, VerifiedEndpoint } from "./contract"
import type { LaunchOwnership } from "./ownership"
import type { SnapshotGeneration } from "./snapshot"

interface BrowserSessionBase {
	readonly schemaVersion: 1
	readonly sessionId: string
	readonly startRunId: string
	readonly launchMarker: string
	readonly createdAtEpochMs: number
	readonly profileRoot: string
	/** What this launch must be able to prove about itself before any signal. */
	readonly launch: LaunchOwnership
	readonly endpoint: {
		readonly host: "127.0.0.1"
		readonly port: number
		readonly browserVersion?: string
		readonly controlledPageTargetId?: string
	}
}

export interface LaunchingBrowserSessionState extends BrowserSessionBase {
	readonly phase: "launching"
}

export interface StartingBrowserSessionState extends BrowserSessionBase {
	readonly phase: "starting"
	readonly process: BrowserProcessIdentity
}

export interface RunningBrowserSessionState extends BrowserSessionBase {
	readonly phase: "running"
	readonly process: BrowserProcessIdentity
	readonly endpoint: BrowserSessionBase["endpoint"] & VerifiedEndpoint
	/**
	 * The one Snapshot Generation whose references are still live. Its absence
	 * is what invalidation looks like on disk: a session that has taken no
	 * snapshot and a session whose references were invalidated are the same
	 * state, so no dead reference can survive anywhere to be resolved later.
	 */
	readonly snapshot?: SnapshotGeneration
}

export type BrowserSessionState =
	| LaunchingBrowserSessionState
	| StartingBrowserSessionState
	| RunningBrowserSessionState

export interface StatePaths {
	readonly root: string
	readonly lock: string
	readonly session: string
}

export class UnsafeStateError extends Error {
	constructor() {
		super("Warm Browser private state could not be proved safe")
		this.name = "UnsafeStateError"
	}
}

function exactPrivateDirectory(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { mode: 0o700 })
		chmodSync(path, 0o700)
		return
	}
	const metadata = lstatSync(path)
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		(typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
		(metadata.mode & 0o7777) !== 0o700
	) {
		throw new UnsafeStateError()
	}
}

export function resolveStatePaths(environment: NodeJS.ProcessEnv = process.env): StatePaths {
	const base = environment.XDG_STATE_HOME
		? resolve(environment.XDG_STATE_HOME)
		: environment.HOME
		? resolve(environment.HOME, ".local", "state")
		: undefined
	if (base === undefined) throw new UnsafeStateError()
	const root = join(base, "my-second-brain", "warm-browser")
	const lock = join(root, "session.lock")
	return { root, lock, session: join(lock, "session.json") }
}

/** A cleanup that detached its lock and has not finished repairing it. */
function detachedCleanupExists(paths: StatePaths): boolean {
	return readdirSync(paths.root).some((entry) => entry.startsWith(".cleanup-"))
}

export function ensurePrivateState(paths: StatePaths): void {
	mkdirSync(dirname(paths.root), { recursive: true, mode: 0o700 })
	exactPrivateDirectory(dirname(paths.root))
	exactPrivateDirectory(paths.root)
	if (detachedCleanupExists(paths)) throw new UnsafeStateError()
}

/**
 * Takes exclusive ownership, or answers false when another owner already holds
 * it.
 *
 * Excluding a detached cleanup belongs to this acquisition, not to a check made
 * earlier: a cleanup releases its lock by renaming it away, so the only way this
 * creation succeeds while one is in flight is after that rename, and that rename
 * is what leaves the tombstone behind. Reading the root again after the creation
 * therefore always observes it. The lock just created is given straight back, so
 * a starter that passed the earlier check can never become a second owner beside
 * a session whose cleanup has not finished.
 */
export function acquireSessionLock(paths: StatePaths): boolean {
	try {
		mkdirSync(paths.lock, { mode: 0o700 })
		chmodSync(paths.lock, 0o700)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		validateSessionLock(paths)
		return false
	}
	if (detachedCleanupExists(paths)) {
		rmdirSync(paths.lock)
		throw new UnsafeStateError()
	}
	return true
}

export function validateSessionLock(paths: StatePaths): boolean {
	let metadata: ReturnType<typeof lstatSync>
	try {
		metadata = lstatSync(paths.lock)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw new UnsafeStateError()
	}
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		(typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
		(metadata.mode & 0o7777) !== 0o700
	) {
		throw new UnsafeStateError()
	}
	return true
}

export function lockAgeMs(paths: StatePaths, nowEpochMs: number): number {
	return Math.max(0, nowEpochMs - statSync(paths.lock).mtimeMs)
}

/**
 * The shared domain predicates every phase validator is built from. A durable
 * receipt is read back into decisions that signal processes and remove state,
 * so a value outside its domain is unsafe state, not a value to coerce.
 */
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && identifier.test(value)
}

/** A wall-clock reading, never before the epoch. */
function isEpochMs(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0
}

/** A process or process-group identity, which is always positive. */
function isProcessIdentifier(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1
}

/** A TCP port, which is 1 through 65535. */
function isPort(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== ""
}

function processShape(value: unknown): value is BrowserProcessIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const processIdentity = value as Partial<BrowserProcessIdentity>
	return (
		isProcessIdentifier(processIdentity.pid) &&
		isProcessIdentifier(processIdentity.processGroupId) &&
		isNonEmptyString(processIdentity.startedAtToken) &&
		isNonEmptyString(processIdentity.executable) &&
		isNonEmptyString(processIdentity.commandLine)
	)
}

function isBoundedText(value: unknown): value is string {
	return typeof value === "string" && value.length <= snapshotTextLimit
}

function basisShape(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const basis = value as Record<string, unknown>
	return (
		isNonEmptyString(basis.targetId) &&
		isNonEmptyString(basis.frameId) &&
		isNonEmptyString(basis.loaderId) &&
		isNonEmptyString(basis.url)
	)
}

function elementShape(value: unknown): value is ControlledPageElement {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const element = value as Partial<ControlledPageElement>
	return (
		isProcessIdentifier(element.backendNodeId) &&
		isBoundedText(element.role) &&
		isBoundedText(element.name) &&
		typeof element.credentialField === "boolean"
	)
}

/**
 * The Snapshot Generation a running receipt may carry. Every reference this
 * session will honour is resolved from these bytes, so a generation outside its
 * domain is unsafe state rather than a value to repair.
 */
function snapshotShape(value: unknown): value is SnapshotGeneration {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const generation = value as Partial<SnapshotGeneration>
	return (
		isIdentifier(generation.generationId) &&
		isEpochMs(generation.takenAtEpochMs) &&
		basisShape(generation.basis) &&
		typeof generation.truncated === "boolean" &&
		Array.isArray(generation.elements) &&
		generation.elements.length <= snapshotElementLimit &&
		generation.elements.every(elementShape)
	)
}

function launchShape(value: unknown): value is LaunchOwnership {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const launch = value as Partial<LaunchOwnership>
	return isNonEmptyString(launch.executable) && isNonEmptyString(launch.commandLine)
}

/**
 * The endpoint a phase may carry. Verification fields belong to a verified
 * endpoint and to nothing else, so a launching or starting receipt claiming a
 * browser version is a receipt that did not come from this code.
 */
function endpointShape(value: unknown, verified: boolean): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const endpoint = value as Partial<BrowserSessionBase["endpoint"]>
	if (endpoint.host !== "127.0.0.1" || !isPort(endpoint.port)) return false
	return verified
		? isNonEmptyString(endpoint.browserVersion) &&
			isNonEmptyString(endpoint.controlledPageTargetId)
		: endpoint.browserVersion === undefined && endpoint.controlledPageTargetId === undefined
}

/** Everything every phase shares, before the phase decides the rest. */
function commonShape(state: Partial<BrowserSessionState>): boolean {
	return (
		state.schemaVersion === 1 &&
		isIdentifier(state.sessionId) &&
		isIdentifier(state.startRunId) &&
		isIdentifier(state.launchMarker) &&
		isEpochMs(state.createdAtEpochMs) &&
		isNonEmptyString(state.profileRoot) &&
		launchShape(state.launch)
	)
}

function stateShape(value: unknown): value is BrowserSessionState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const state = value as Partial<BrowserSessionState>
	if (!commonShape(state)) return false
	// A Snapshot Generation belongs to a verified Controlled Page and to nothing
	// else, so a receipt that carries one before the page exists did not come
	// from this code.
	if (state.phase !== "running" && "snapshot" in state) return false
	if (state.phase === "launching") {
		return !("process" in state) && endpointShape(state.endpoint, false)
	}
	if (state.phase === "starting") {
		return (
			processShape((state as Partial<StartingBrowserSessionState>).process) &&
			endpointShape(state.endpoint, false)
		)
	}
	if (state.phase === "running") {
		const running = state as Partial<RunningBrowserSessionState>
		return (
			processShape(running.process) &&
			endpointShape(state.endpoint, true) &&
			(running.snapshot === undefined || snapshotShape(running.snapshot))
		)
	}
	return false
}

export function readSessionState(paths: StatePaths): BrowserSessionState | undefined {
	let metadata: ReturnType<typeof lstatSync>
	try {
		metadata = lstatSync(paths.session)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw new UnsafeStateError()
	}
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		(typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
		(metadata.mode & 0o7777) !== 0o600
	) {
		throw new UnsafeStateError()
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(paths.session, "utf8"))
	} catch {
		throw new UnsafeStateError()
	}
	if (!stateShape(parsed)) throw new UnsafeStateError()
	return parsed
}

/**
 * Writes one durable receipt, having proved it is a receipt this code could
 * read back. State is validated on the way out as well as on the way in: a
 * receipt that would be rejected on read must never be published as a success,
 * and must never reach the disk to be repaired later.
 */
export function writeSessionState(paths: StatePaths, state: BrowserSessionState): void {
	if (!validateSessionLock(paths)) throw new UnsafeStateError()
	if (!stateShape(state)) throw new UnsafeStateError()
	const temporary = `${paths.session}.tmp-${process.pid}`
	try {
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 })
		chmodSync(temporary, 0o600)
		renameSync(temporary, paths.session)
		chmodSync(paths.session, 0o600)
	} finally {
		rmSync(temporary, { force: true })
	}
}

export function runningState(
	state: StartingBrowserSessionState,
	endpoint: VerifiedEndpoint,
): RunningBrowserSessionState {
	return {
		...state,
		phase: "running",
		endpoint: { ...state.endpoint, ...endpoint },
	}
}

export function removeNewEmptyLock(paths: StatePaths): void {
	if (!validateSessionLock(paths) || readSessionState(paths) !== undefined) {
		throw new UnsafeStateError()
	}
	rmdirSync(paths.lock)
}

/**
 * Removes one owned session's durable state. The lock is detached by a single
 * atomic rename before anything inside it is touched, so a concurrent owner
 * never observes a half-removed lock: it sees the lock gone and is refused.
 */
export function removeOwnedState(paths: StatePaths, sessionId: string): void {
	if (!validateSessionLock(paths)) throw new UnsafeStateError()
	const state = readSessionState(paths)
	if (state === undefined || state.sessionId !== sessionId) throw new UnsafeStateError()
	const detached = join(paths.root, `.cleanup-${sessionId}`)
	if (existsSync(detached)) throw new UnsafeStateError()
	renameSync(paths.lock, detached)
	const detachedSession = join(detached, "session.json")
	try {
		unlinkSync(detachedSession)
		rmdirSync(detached)
	} catch (error) {
		if (existsSync(detached) && !existsSync(detachedSession)) {
			writeFileSync(detachedSession, `${JSON.stringify(state, null, 2)}\n`, {
				flag: "wx",
				mode: 0o600,
			})
			chmodSync(detachedSession, 0o600)
		}
		throw error
	}
}
