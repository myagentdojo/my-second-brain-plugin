import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { hostEffects, type ProductionCliProbe } from "./production-cli-harness"

/**
 * Helpers for driving the login command against one probe. Only fixture input
 * and independent observation live here: every expected envelope, sentinel,
 * and reference stays inside the test that asserts it, so no oracle is shared
 * between tests.
 */

/**
 * Writes the configured Credential Vault exactly as production requires it: a
 * private directory at `0700` holding a private file at `0600`. Tests that
 * prove the safety rules perturb what this wrote.
 */
export function configureCredentialVault(probe: ProductionCliProbe, vault: string): void {
	const stateHome = probe.environment.XDG_STATE_HOME!
	const directory = join(stateHome, "my-second-brain", "private-delivery")
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	chmodSync(directory, 0o700)
	const file = join(directory, "credential-vault.json")
	writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, vault })}\n`, { mode: 0o600 })
	chmodSync(file, 0o600)
}

/** Where the configured Credential Vault file lives, for tests that perturb it. */
export function credentialVaultPath(probe: ProductionCliProbe): string {
	return join(
		probe.environment.XDG_STATE_HOME!,
		"my-second-brain",
		"private-delivery",
		"credential-vault.json",
	)
}

/** Writes the plan the private credential fake reads. */
export function writeCredentialPlan(
	probe: ProductionCliProbe,
	planned: Record<string, unknown>,
): void {
	writeFileSync(
		join(probe.fakeRoot, "credential-effects.json"),
		`${JSON.stringify(planned, null, 2)}\n`,
	)
}

/**
 * One successful raw vault reading, rendered from a value this helper
 * serialises, so a test states op's reply as data rather than as bytes.
 */
export function vaultReading(value: unknown): Record<string, unknown> {
	return { status: 0, signal: null, failed: false, stdout: JSON.stringify(value) }
}

/**
 * One `op item get` reply body. It is fixture input, never an expected value:
 * every expectation about what the Module makes of it is restated by its test.
 */
export function loginItem(input: {
	readonly id: string
	readonly vault: { readonly id: string; readonly name: string }
	readonly websites?: readonly string[]
	readonly fields?: readonly { readonly id: string; readonly purpose: string }[]
}): Record<string, unknown> {
	return {
		id: input.id,
		vault: input.vault,
		urls: (input.websites ?? []).map((href) => ({ href })),
		fields: input.fields ?? [],
	}
}

export interface PrivateStateFile {
	readonly path: string
	readonly bytes: string
}

/**
 * Every regular file under the probe's private state root, read with an
 * independent recursive walk that imports nothing from `src`, so a scan for a
 * secret cannot share a blind spot with the code that must not write it.
 */
export function filesUnderPrivateState(probe: ProductionCliProbe): readonly PrivateStateFile[] {
	const files: PrivateStateFile[] = []
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) walk(path)
			else if (entry.isFile()) files.push({ path, bytes: readFileSync(path, "utf8") })
		}
	}
	walk(probe.sessionRoot)
	return files
}

/** Every recorded invocation of the delivery half of the credential seam. */
export function deliveryActions(probe: ProductionCliProbe): Array<Record<string, unknown>> {
	return hostEffects(probe).filter((entry) => entry.action === "deliver")
}

/** Every recorded invocation of the vault half of the credential seam. */
export function vaultActions(probe: ProductionCliProbe): Array<Record<string, unknown>> {
	return hostEffects(probe).filter((entry) => entry.action === "vault")
}
