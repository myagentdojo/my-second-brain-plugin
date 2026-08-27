import { afterEach, expect, test } from "bun:test"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
	acquireSessionLock,
	ensurePrivateState,
	type LaunchingBrowserSessionState,
	readSessionState,
	removeOwnedState,
	resolveStatePaths,
	UnsafeStateError,
	writeSessionState,
} from "../src/modules/warm-browser/state"

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function ownedState(sessionId: string) {
	const base = mkdtempSync(join(tmpdir(), "warm-browser-state-"))
	roots.push(base)
	chmodSync(base, 0o700)
	const paths = resolveStatePaths({ XDG_STATE_HOME: base })
	ensurePrivateState(paths)
	expect(acquireSessionLock(paths)).toBe(true)
	const state: LaunchingBrowserSessionState = {
		schemaVersion: 1,
		phase: "launching",
		sessionId,
		startRunId: `run-${sessionId}`,
		launchMarker: sessionId,
		createdAtEpochMs: 1_800_000_000_000,
		profileRoot: join(base, ".agent-warm-profile"),
		launch: { executable: "/fixture/chrome", commandLine: "/fixture/chrome --fixture" },
		endpoint: { host: "127.0.0.1", port: 9242 },
	}
	writeSessionState(paths, state)
	return { paths, state }
}

test("detached cleanup blocks a concurrent owner until old state is gone, then preserves the new owner", () => {
	const { paths } = ownedState("old-session")
	let concurrentBlocked = false
	removeOwnedState(paths, "old-session", () => {
		try {
			ensurePrivateState(paths)
		} catch (error) {
			concurrentBlocked = error instanceof UnsafeStateError
		}
	})
	expect(concurrentBlocked).toBe(true)
	expect(existsSync(paths.lock)).toBe(false)

	ensurePrivateState(paths)
	expect(acquireSessionLock(paths)).toBe(true)
	const newState: LaunchingBrowserSessionState = {
		schemaVersion: 1,
		phase: "launching",
		sessionId: "new-session",
		startRunId: "run-new-session",
		launchMarker: "new-session",
		createdAtEpochMs: 1_800_000_000_001,
		profileRoot: join(paths.root, "profile"),
		launch: { executable: "/fixture/chrome", commandLine: "/fixture/chrome --fixture" },
		endpoint: { host: "127.0.0.1", port: 9242 },
	}
	writeSessionState(paths, newState)
	expect(readSessionState(paths)).toEqual(newState)
})

test("cleanup failure preserves the exact receipt inside a fail-closed tombstone", () => {
	const { paths } = ownedState("failed-cleanup")
	const receipt = readFileSync(paths.session, "utf8")
	writeFileSync(join(paths.lock, "unexpected-entry"), "block rmdir\n", { mode: 0o600 })
	expect(() => removeOwnedState(paths, "failed-cleanup")).toThrow()
	const tombstoneReceipt = join(paths.root, ".cleanup-failed-cleanup", "session.json")
	expect(readFileSync(tombstoneReceipt, "utf8")).toBe(receipt)
	expect(statSync(tombstoneReceipt).mode & 0o7777).toBe(0o600)
	expect(() => ensurePrivateState(paths)).toThrow(UnsafeStateError)
})
