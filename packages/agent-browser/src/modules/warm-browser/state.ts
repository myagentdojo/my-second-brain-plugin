import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

import type { BrowserProcessIdentity, VerifiedEndpoint } from "./contract"

export interface BrowserSessionState {
	readonly schemaVersion: 1
	readonly phase: "starting" | "running"
	readonly sessionId: string
	readonly startRunId: string
	readonly createdAtEpochMs: number
	readonly profileRoot: string
	readonly process: BrowserProcessIdentity
	readonly endpoint: {
		readonly host: "127.0.0.1"
		readonly port: number
		readonly browserVersion?: string
		readonly controlledPageTargetId?: string
	}
}

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

function privateDirectory(path: string): void {
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
		(metadata.mode & 0o077) !== 0
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
	return { root, lock: join(root, "session.lock"), session: join(root, "session.json") }
}

export function ensurePrivateState(paths: StatePaths): void {
	mkdirSync(dirname(paths.root), { recursive: true, mode: 0o700 })
	privateDirectory(dirname(paths.root))
	privateDirectory(paths.root)
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
		(metadata.mode & 0o777) !== 0o700
	) {
		throw new UnsafeStateError()
	}
	return true
}

export function lockAgeMs(paths: StatePaths, nowEpochMs: number): number {
	return Math.max(0, nowEpochMs - statSync(paths.lock).mtimeMs)
}

function stateShape(value: unknown): value is BrowserSessionState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const state = value as Partial<BrowserSessionState>
	const processIdentity = state.process as Partial<BrowserProcessIdentity> | undefined
	const endpoint = state.endpoint as BrowserSessionState["endpoint"] | undefined
	return (
		state.schemaVersion === 1 &&
		(state.phase === "starting" || state.phase === "running") &&
		typeof state.sessionId === "string" &&
		typeof state.startRunId === "string" &&
		Number.isSafeInteger(state.createdAtEpochMs) &&
		typeof state.profileRoot === "string" &&
		processIdentity !== undefined &&
		Number.isSafeInteger(processIdentity.pid) &&
		Number.isSafeInteger(processIdentity.processGroupId) &&
		typeof processIdentity.startedAtToken === "string" &&
		typeof processIdentity.executable === "string" &&
		typeof processIdentity.commandLine === "string" &&
		endpoint !== undefined &&
		endpoint.host === "127.0.0.1" &&
		Number.isSafeInteger(endpoint.port) &&
		(endpoint.browserVersion === undefined || typeof endpoint.browserVersion === "string") &&
		(endpoint.controlledPageTargetId === undefined ||
			typeof endpoint.controlledPageTargetId === "string")
	)
}

export function readSessionState(paths: StatePaths): BrowserSessionState | undefined {
	if (!existsSync(paths.session)) return undefined
	const metadata = lstatSync(paths.session)
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		(typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
		(metadata.mode & 0o177) !== 0
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
	state: BrowserSessionState,
	endpoint: VerifiedEndpoint,
): BrowserSessionState {
	return {
		...state,
		phase: "running",
		endpoint: { ...state.endpoint, ...endpoint },
	}
}

export function removeOwnedState(paths: StatePaths): void {
	try {
		rmdirSync(paths.lock)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	rmSync(paths.session, { force: true })
}
