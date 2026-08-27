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

import type { BrowserProcessIdentity, VerifiedEndpoint } from "./contract"
import type { LaunchOwnership } from "./ownership"

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

export function ensurePrivateState(paths: StatePaths): void {
	mkdirSync(dirname(paths.root), { recursive: true, mode: 0o700 })
	exactPrivateDirectory(dirname(paths.root))
	exactPrivateDirectory(paths.root)
	if (readdirSync(paths.root).some((entry) => entry.startsWith(".cleanup-"))) {
		throw new UnsafeStateError()
	}
}

export function acquireSessionLock(paths: StatePaths): boolean {
	try {
		mkdirSync(paths.lock, { mode: 0o700 })
		chmodSync(paths.lock, 0o700)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		validateSessionLock(paths)
		return false
	}
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

function processShape(value: unknown): value is BrowserProcessIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const processIdentity = value as Partial<BrowserProcessIdentity>
	return (
		Number.isSafeInteger(processIdentity.pid) &&
		Number.isSafeInteger(processIdentity.processGroupId) &&
		typeof processIdentity.startedAtToken === "string" &&
		typeof processIdentity.executable === "string" &&
		typeof processIdentity.commandLine === "string"
	)
}

function launchShape(value: unknown): value is LaunchOwnership {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const launch = value as Partial<LaunchOwnership>
	return typeof launch.executable === "string" && typeof launch.commandLine === "string"
}

function stateShape(value: unknown): value is BrowserSessionState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const state = value as Partial<BrowserSessionState>
	const endpoint = state.endpoint as BrowserSessionBase["endpoint"] | undefined
	const common = state.schemaVersion === 1 &&
		(state.phase === "launching" || state.phase === "starting" || state.phase === "running") &&
		typeof state.sessionId === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(state.sessionId) &&
		typeof state.startRunId === "string" &&
		typeof state.launchMarker === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(state.launchMarker) &&
		Number.isSafeInteger(state.createdAtEpochMs) &&
		typeof state.profileRoot === "string" &&
		launchShape(state.launch) &&
		endpoint !== undefined &&
		endpoint.host === "127.0.0.1" &&
		Number.isSafeInteger(endpoint.port) &&
		(endpoint.browserVersion === undefined || typeof endpoint.browserVersion === "string") &&
		(endpoint.controlledPageTargetId === undefined ||
			typeof endpoint.controlledPageTargetId === "string")
	if (!common) return false
	if (state.phase === "launching") return !("process" in state)
	if (!processShape((state as Partial<StartingBrowserSessionState>).process)) return false
	return (
		state.phase !== "running" ||
		(typeof endpoint.browserVersion === "string" &&
			typeof endpoint.controlledPageTargetId === "string")
	)
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

export function writeSessionState(paths: StatePaths, state: BrowserSessionState): void {
	if (!validateSessionLock(paths)) throw new UnsafeStateError()
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

export function removeOwnedState(
	paths: StatePaths,
	sessionId: string,
	onDetached?: () => void,
): void {
	if (!validateSessionLock(paths)) throw new UnsafeStateError()
	const state = readSessionState(paths)
	if (state === undefined || state.sessionId !== sessionId) throw new UnsafeStateError()
	const detached = join(paths.root, `.cleanup-${sessionId}`)
	if (existsSync(detached)) throw new UnsafeStateError()
	renameSync(paths.lock, detached)
	const detachedSession = join(detached, "session.json")
	try {
		onDetached?.()
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
