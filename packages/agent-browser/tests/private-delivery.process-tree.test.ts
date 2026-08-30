import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
	runSanitizedCredentialList,
	runVaultCommand,
} from "../src/modules/private-delivery/credential-effects"

const roots: string[] = []
const ownedDescendants: number[] = []
const entry = resolve(import.meta.dir, "../src/main.ts")

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"
	}
}

afterEach(() => {
	for (const pid of ownedDescendants.splice(0)) {
		if (!processExists(pid)) continue
		try {
			process.kill(pid, "SIGKILL")
		} catch {
			// The exact test-owned process may have exited between the two calls.
		}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function overlongWrapper(): { readonly path: string; readonly descendantPidPath: string } {
	const root = mkdtempSync(join(tmpdir(), "private-delivery-process-group-"))
	roots.push(root)
	const descendantPidPath = join(root, "descendant.pid")
	const wrapper = join(root, "credential-wrapper")
	writeFileSync(
		wrapper,
		`#!/bin/sh\n/bin/sh -c 'printf "%s\\n" "$$" > "${descendantPidPath}"; exec /bin/sleep 300' &\nwhile [ ! -s "${descendantPidPath}" ]; do :; done\nwhile :; do printf '0123456789abcdef0123456789abcdef\\n'; done\n`,
		{ mode: 0o700 },
	)
	chmodSync(wrapper, 0o700)
	return { path: wrapper, descendantPidPath }
}

function recordedDescendant(path: string): number {
	const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
	ownedDescendants.push(pid)
	return pid
}

test("an overlong wrapper reply leaves no descendant process alive", async () => {
	const wrapper = overlongWrapper()

	const result = await runVaultCommand(wrapper.path, ["op", "item", "list"])
	const descendantPid = recordedDescendant(wrapper.descendantPidPath)

	expect(result.failed).toBe(true)
	expect(result.stdout === null || result.stdout.length <= 1_048_576).toBe(true)
	expect(processExists(descendantPid)).toBe(false)
})

test("a sanitizer failure leaves no nested wrapper descendant alive", async () => {
	const wrapper = overlongWrapper()

	const result = await runSanitizedCredentialList({
		wrapper: wrapper.path,
		entry,
		vault: "Agent Vault",
	})
	const descendantPid = recordedDescendant(wrapper.descendantPidPath)

	expect(result.status).toBeNull()
	expect(result.signal).toBe("SIGKILL")
	expect(processExists(descendantPid)).toBe(false)
})
