import { lstatSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * The configured Credential Vault.
 *
 * One private file names the one 1Password vault Private Delivery may match
 * against, and this Module only ever reads it: a Module that could create or
 * repair the file could be steered into configuring itself, so an unsafe file
 * is refused rather than fixed. The permission checks are written here rather
 * than imported from `warm-browser/state.ts`, because the two Modules must
 * stay independent: sharing the check would let an edit meant for the Browser
 * Session receipt change what this Module accepts as its credential policy.
 */

export type CredentialVaultConfiguration =
	| { readonly kind: "configured"; readonly vault: string }
	| { readonly kind: "unconfigured" }
	| { readonly kind: "unsafe" }

/** The most characters a configured vault name or id may carry. */
const vaultNameLimit = 128

const controlCharacter = /\p{Cc}/u

/**
 * The one value this Module will hand to the wrapper as a vault. No control
 * character and no `/`, because the value becomes an argument and a reference
 * segment; no whitespace at either end, because a value that only names the
 * vault after trimming is not the value on disk.
 */
function isVaultName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value !== "" &&
		value.length <= vaultNameLimit &&
		!controlCharacter.test(value) &&
		!value.includes("/") &&
		value === value.trim()
	)
}

function ownedByCurrentUser(metadata: { readonly uid: number }): boolean {
	return typeof process.getuid !== "function" || metadata.uid === process.getuid()
}

/**
 * Reads the configured Credential Vault, or says why there is none to read.
 * An absent file is a caller that never configured one; a present file that
 * fails any safety or domain check is unsafe, and unsafe is never repaired,
 * rewritten, or acted on.
 */
export function readCredentialVaultConfiguration(
	environment: NodeJS.ProcessEnv = process.env,
): CredentialVaultConfiguration {
	// The base resolves exactly as Warm Browser resolves its own private state
	// base, so both Modules' state lives under one private root without either
	// importing the other's rules.
	const base = environment.XDG_STATE_HOME
		? resolve(environment.XDG_STATE_HOME)
		: environment.HOME
		? resolve(environment.HOME, ".local", "state")
		: undefined
	if (base === undefined) return { kind: "unsafe" }
	const directory = join(base, "my-second-brain", "private-delivery")
	const file = join(directory, "credential-vault.json")
	let fileMetadata: ReturnType<typeof lstatSync>
	try {
		fileMetadata = lstatSync(file)
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { kind: "unconfigured" }
			: { kind: "unsafe" }
	}
	let directoryMetadata: ReturnType<typeof lstatSync>
	try {
		directoryMetadata = lstatSync(directory)
	} catch {
		return { kind: "unsafe" }
	}
	if (
		!directoryMetadata.isDirectory() ||
		directoryMetadata.isSymbolicLink() ||
		!ownedByCurrentUser(directoryMetadata) ||
		(directoryMetadata.mode & 0o7777) !== 0o700
	) {
		return { kind: "unsafe" }
	}
	if (
		!fileMetadata.isFile() ||
		fileMetadata.isSymbolicLink() ||
		!ownedByCurrentUser(fileMetadata) ||
		(fileMetadata.mode & 0o7777) !== 0o600
	) {
		return { kind: "unsafe" }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"))
	} catch {
		return { kind: "unsafe" }
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "unsafe" }
	}
	const configuration = parsed as Record<string, unknown>
	// The file this Module vouches for carries exactly the keys it documents. A
	// key it never named is a file another writer shaped, and this Module does
	// not act on those.
	if (
		Object.keys(configuration).length !== 2 ||
		configuration.schemaVersion !== 1 ||
		!isVaultName(configuration.vault)
	) {
		return { kind: "unsafe" }
	}
	return { kind: "configured", vault: configuration.vault }
}
