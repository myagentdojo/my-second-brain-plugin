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
		profileRoot: join(base, "Agent Chrome", "Chrome User Data"),
		launch: { executable: "/fixture/chrome", commandLine: "/fixture/chrome --fixture" },
		endpoint: { host: "127.0.0.1", port: 9242 },
	}
	writeSessionState(paths, state)
	return { paths, state }
}

test("a completed cleanup leaves no lock and lets one new owner acquire it", () => {
	const { paths } = ownedState("old-session")

	removeOwnedState(paths, "old-session")

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

test("a blocked cleanup detaches the lock, refuses a concurrent owner, and retains the receipt", () => {
	const { paths } = ownedState("failed-cleanup")
	const receipt = readFileSync(paths.session, "utf8")
	// A real filesystem obstruction stops the removal after the atomic detach,
	// which is exactly the window a concurrent owner could observe. No
	// production callback is involved: the boundary is the filesystem itself.
	writeFileSync(join(paths.lock, "unexpected-entry"), "block rmdir\n", { mode: 0o600 })

	expect(() => removeOwnedState(paths, "failed-cleanup")).toThrow()

	// The lock is gone rather than half-removed, so a concurrent owner is
	// refused instead of acquiring ownership of a session being cleaned up.
	expect(existsSync(paths.lock)).toBe(false)
	expect(() => ensurePrivateState(paths)).toThrow(UnsafeStateError)
	const tombstoneReceipt = join(paths.root, ".cleanup-failed-cleanup", "session.json")
	expect(readFileSync(tombstoneReceipt, "utf8")).toBe(receipt)
	expect(statSync(tombstoneReceipt).mode & 0o7777).toBe(0o600)
})
