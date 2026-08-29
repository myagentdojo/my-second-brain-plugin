import { accessSync, constants, lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import type { ControlledPageBasis } from "../warm-browser/contract"
import { privateDeliveryChildArgument } from "./child"
import { readCredentialVaultConfiguration } from "./configuration"
import {
	type PrivateDeliveryChildOutcome,
	privateDeliveryChildOutcomes,
	privateDeliveryChildReplyLimit,
	type PrivateDeliveryOutcome,
} from "./contract"
import {
	type PrivateDeliveryReading,
	runPrivateDelivery,
	runSanitizedCredentialDetail,
	runSanitizedCredentialList,
} from "./credential-effects"
import {
	declaresExactOrigin,
	interpretSanitizedCredentialDetail,
	interpretSanitizedCredentialList,
} from "./credential-match"
import { successfulVaultReplyText } from "./credential-reading"
import type { CredentialFieldKind } from "./field-kind"

export type { PrivateDeliveryOutcome } from "./contract"

/**
 * The Private Delivery Module entry.
 *
 * It takes only non-secret inputs and answers only the closed outcome
 * vocabulary. The secret is never a value in this Module: the wrapper
 * resolves the one reference itself and hands the value to the disposable
 * child on its standard input, so no variable here holds it, nothing returns
 * it, and the child's streams are parsed into the closed outcome and dropped.
 * Nothing from those streams may ever be placed into an envelope.
 */

/**
 * The one credential wrapper this Module will invoke. Nothing else resolves a
 * 1Password value on this Module's behalf, so proving this exact path is
 * proving the custody chain the wrapper documents: the token stays with the
 * wrapper, the environment is scrubbed, and the secret travels on standard
 * input only.
 */
const credentialWrapperPath = join(homedir(), "code/dotfiles/bin/with-one-password-token")

/**
 * The wrapper's own reserved exit classes: usage, token custody, op
 * availability, an empty secret, and delivery bootstrap. One of these with no
 * child reply at all is the wrapper stopping before the child existed, so
 * nothing has touched the page.
 */
const reservedWrapperExits = [2, 3, 4, 5, 70] as const

/** The one exhaustive mapping from a requested credential half to its Login purpose. */
const credentialFieldPurposes: Record<CredentialFieldKind, "USERNAME" | "PASSWORD"> = {
	username: "USERNAME",
	password: "PASSWORD",
}

/**
 * The one shape a secret-reference segment may take.
 *
 * A secret reference is `op://<vault>/<item>/<field>`, and it carries no escape
 * syntax at all: `/` starts another segment the CLI reads as a section, `?`
 * starts the attribute selector, and a per-cent sign is read as an invalid
 * reference rather than as an encoding. An allow-list is used instead of a
 * list of forbidden characters so a syntax this Module has not met cannot pass
 * through it. Every id op itself issues is inside this set.
 */
const referenceSafeSegment = /^[A-Za-z0-9_.-]{1,128}$/

const writableByAnotherUserMask = 0o022
const stickyDirectoryMask = 0o1000

/** Every lexical directory from the filesystem root through one parent. */
function directoryChain(path: string): string[] {
	const chain: string[] = []
	let current = resolve(path)
	while (true) {
		chain.push(current)
		const parent = dirname(current)
		if (parent === current) return chain.reverse()
		current = parent
	}
}

/**
 * Whether one parent component cannot be replaced by another user.
 *
 * Root and the current user are the only trusted owners. A group- or
 * world-writable directory is safe only when the sticky bit prevents another
 * writer from replacing an entry it does not own. A trusted symlink is
 * admitted only because its containing chain and resolved target chain are
 * checked separately.
 */
function isTrustedParent(path: string, currentUserId: number): boolean {
	try {
		const metadata = lstatSync(path)
		if (metadata.uid !== 0 && metadata.uid !== currentUserId) return false
		if (metadata.isSymbolicLink()) return true
		if (!metadata.isDirectory()) return false
		return (
			(metadata.mode & writableByAnotherUserMask) === 0 ||
			(metadata.mode & stickyDirectoryMask) !== 0
		)
	} catch {
		return false
	}
}

/** Whether both the named and resolved parent chains are trusted. */
function hasTrustedParentChain(path: string, currentUserId: number): boolean {
	try {
		const parent = dirname(path)
		const resolvedParent = realpathSync(parent)
		const parents = new Set([...directoryChain(parent), ...directoryChain(resolvedParent)])
		return [...parents].every((candidate) => isTrustedParent(candidate, currentUserId))
	} catch {
		return false
	}
}

/**
 * Proves one credential-chain file and returns the exact absolute path proved.
 * The wrapper must be executable; Bun reads the entry as a regular file.
 */
function verifiedCredentialFile(
	path: string,
	role: "wrapper" | "entry",
): string | undefined {
	if (typeof process.getuid !== "function") return undefined
	const currentUserId = process.getuid()
	const absolutePath = resolve(path)
	try {
		const metadata = lstatSync(absolutePath)
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			metadata.uid !== currentUserId ||
			(metadata.mode & writableByAnotherUserMask) !== 0 ||
			!hasTrustedParentChain(absolutePath, currentUserId)
		) {
			return undefined
		}
		if (role === "wrapper") accessSync(absolutePath, constants.X_OK)
		return absolutePath
	} catch {
		return undefined
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

interface ChildReply {
	readonly outcome: PrivateDeliveryChildOutcome
	readonly fieldNowHoldsValue: boolean
}

/**
 * The child's one reply line: exactly one bounded line of JSON whose outcome
 * name comes from the closed set the two processes share. Anything else is no
 * proof, whatever else it says.
 */
function parseChildReply(raw: string): ChildReply | undefined {
	if (raw.length > privateDeliveryChildReplyLimit) return undefined
	const text = raw.trim()
	if (text === "" || text.includes("\n")) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	const reply = record(parsed)
	const outcome = reply?.outcome
	if (
		typeof outcome !== "string" ||
		!(privateDeliveryChildOutcomes as readonly string[]).includes(outcome)
	) {
		return undefined
	}
	return {
		outcome: outcome as PrivateDeliveryChildOutcome,
		fieldNowHoldsValue: reply?.fieldNowHoldsValue === true,
	}
}

/** What the wrapper-and-child conversation proved about the delivery. */
function interpretDelivery(reading: PrivateDeliveryReading): PrivateDeliveryOutcome {
	// A spawn that never started created no child, so nothing touched the page.
	if (reading.failed) return { kind: "vault_unverified" }
	const reply = reading.stdout === null ? undefined : parseChildReply(reading.stdout)
	if (reply === undefined) {
		// A reserved wrapper exit with no reply at all is the wrapper stopping
		// before the child could run: the secret never met a process that speaks
		// to the page.
		if (
			(reading.stdout === null || reading.stdout.trim() === "") &&
			reading.signal === null &&
			reading.status !== null &&
			(reservedWrapperExits as readonly number[]).includes(reading.status)
		) {
			return { kind: "vault_unverified" }
		}
		// A child that got as far as running may already have asked the page for
		// focus, so a reply that proves nothing never reads as the page left
		// alone.
		return { kind: "unverified", touchedPage: true }
	}
	switch (reply.outcome) {
		case "delivered":
			// Delivery is claimed only when the child also read the field holding a
			// value; a delivered reply without that proof is a fill this Module
			// cannot vouch for, on a page the child certainly touched.
			return reply.fieldNowHoldsValue
				? { kind: "delivered" }
				: { kind: "unverified", touchedPage: true }
		case "identity_changed":
			return { kind: "identity_changed" }
		case "origin_changed":
			return { kind: "origin_changed" }
		case "field_mismatch":
			return { kind: "field_mismatch" }
		case "field_not_empty":
			return { kind: "field_not_empty" }
		case "element_absent":
			return { kind: "element_absent" }
		case "superseded":
			// The value entered the page and the page then moved to a document the
			// fill could not have asked for. That is never delivery, and it is not
			// provable as this reference's fill either, so it is carried as the one
			// outcome that says the page was touched and the delivery unproved.
			return { kind: "unverified", touchedPage: true }
		case "usage":
			// The child refused its own argument list before it read anything or
			// spoke to anyone, and said so: only the delivery went unproved.
			return { kind: "unverified", touchedPage: false }
		case "unverified":
			return { kind: "unverified", touchedPage: true }
	}
}

/**
 * Delivers one Credential Vault Login field into one field of the Controlled
 * Page, or says exactly why it would not.
 *
 * The order is fixed and each step fails closed before the next: approval,
 * the configured Credential Vault, the wrapper, the metadata listing, the
 * exact-origin unique match, its one detail read, the one field, the proved
 * entry, and only then the delivery.
 */
export async function deliverPrivately(input: {
	readonly port: number
	readonly targetId: string
	readonly basis: ControlledPageBasis
	readonly backendNodeId: number
	readonly origin: string
	readonly field: CredentialFieldKind
	readonly humanApproved: boolean
}): Promise<PrivateDeliveryOutcome> {
	// Approval is the first gate inside the Module, so approval provably
	// precedes credential access: when it refuses, nothing has been read, no
	// wrapper has been invoked, and no process has been created.
	if (!input.humanApproved) return { kind: "approval_required" }
	const configuration = readCredentialVaultConfiguration()
	if (configuration.kind === "unconfigured") return { kind: "vault_unconfigured" }
	if (configuration.kind === "unsafe") return { kind: "vault_unsafe" }
	const vault = configuration.vault
	const wrapper = verifiedCredentialFile(credentialWrapperPath, "wrapper")
	if (wrapper === undefined) return { kind: "wrapper_unavailable" }
	const entryArgument = process.argv[1]
	const entry =
		entryArgument === undefined ? undefined : verifiedCredentialFile(entryArgument, "entry")
	if (entry === undefined) return { kind: "unverified", touchedPage: false }
	const listReading = await runSanitizedCredentialList({ wrapper, entry, vault })
	const listing = successfulVaultReplyText(listReading)
	const candidates = listing === undefined ? undefined : interpretSanitizedCredentialList(listing)
	if (candidates === undefined) return { kind: "vault_unverified" }
	for (const candidate of candidates) {
		if (candidate.vaultId !== vault && candidate.vaultName !== vault) {
			return { kind: "vault_mismatch" }
		}
	}
	const matches = candidates.filter((candidate) => declaresExactOrigin(candidate, input.origin))
	if (matches.length === 0) return { kind: "match_absent" }
	if (matches.length > 1) return { kind: "match_ambiguous" }
	const matchedCandidate = matches[0]!
	if (
		matchedCandidate.id.startsWith("-") ||
		!referenceSafeSegment.test(matchedCandidate.id)
	) {
		return { kind: "vault_unverified" }
	}
	// The complete Login listing proves this exact candidate unique before one
	// disposable sanitizer names it, so the wrapper and op calls stay constant
	// however many Login items the vault holds. No item's field values enter
	// this process, matched or unmatched.
	const detailReading = await runSanitizedCredentialDetail({
		wrapper,
		entry,
		itemId: matchedCandidate.id,
		vault,
	})
	const detail = successfulVaultReplyText(detailReading)
	const matched = detail === undefined ? undefined : interpretSanitizedCredentialDetail(detail)
	if (matched === undefined) return { kind: "vault_unverified" }
	if (matched.id !== matchedCandidate.id) return { kind: "vault_unverified" }
	if (matched.vaultId !== vault && matched.vaultName !== vault) return { kind: "vault_mismatch" }
	if (!declaresExactOrigin(matched, input.origin)) return { kind: "vault_unverified" }
	const purpose = credentialFieldPurposes[input.field]
	const selected = matched.fields.filter((field) => field.purpose === purpose && field.id !== "")
	if (selected.length !== 1) return { kind: "field_ambiguous" }
	// The reference names the vault, the item, and the field by id, never by
	// name or label. That is what closes the duplicate-label hazard the op CLI
	// has: two fields may share a label, and a label may carry reference
	// syntax, but an id names exactly one field. The vault id comes from the
	// detail read this Module already proved to be the configured vault, so the
	// delivery is pinned to that exact vault rather than to a name two vaults
	// could share.
	//
	// A segment outside the safe set is refused rather than escaped. A secret
	// reference has no escape syntax: the installed op CLI reads a per-cent
	// sign as an invalid reference rather than as an encoding, `/` would add a
	// segment it reads as a section, and `?` would add the attribute selector.
	// So an id this Module cannot name exactly is an id it does not name at all.
	const segments = [matched.vaultId, matched.id, selected[0]!.id]
	if (!segments.every((segment) => referenceSafeSegment.test(segment))) {
		return { kind: "vault_unverified" }
	}
	const reference = `op://${segments.join("/")}`
	// The child re-enters through the same entry this process was started from,
	// so one bundle still ships and the checked path is the one used.
	// Everything in this list is non-secret. The runtime flags keep the child
	// from reading any configuration or environment file and from installing
	// anything on its own account.
	const command = [
		process.execPath,
		"--config=/dev/null",
		"--no-install",
		"--env-file=/dev/null",
		entry,
		privateDeliveryChildArgument,
		"--port",
		String(input.port),
		"--target",
		input.targetId,
		"--node",
		String(input.backendNodeId),
		"--frame",
		input.basis.frameId,
		"--loader",
		input.basis.loaderId,
		"--url",
		input.basis.url,
		"--origin",
		input.origin,
		"--field",
		input.field,
	]
	return interpretDelivery(
		await runPrivateDelivery({ wrapper, reference, command }),
	)
}
