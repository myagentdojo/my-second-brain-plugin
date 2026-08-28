import { accessSync, constants, lstatSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { ControlledPageBasis } from "../warm-browser/contract"
import { privateDeliveryChildArgument } from "./child"
import { readCredentialVaultConfiguration } from "./configuration"
import {
	credentialWrapperOutputLimit,
	type PrivateDeliveryChildOutcome,
	privateDeliveryChildOutcomes,
	privateDeliveryChildReplyLimit,
	type PrivateDeliveryOutcome,
} from "./contract"
import {
	type PrivateDeliveryReading,
	runPrivateDelivery,
	runVaultCommand,
	type VaultCommandReading,
} from "./credential-effects"
import {
	type CredentialItemReading,
	declaresExactOrigin,
	interpretLoginItem,
	interpretLoginItemList,
} from "./credential-match"
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

/** Whether one path is a regular, non-symlink file owned by the current user. */
function isOwnedRegularFile(path: string): boolean {
	try {
		const metadata = lstatSync(path)
		return (
			metadata.isFile() &&
			!metadata.isSymbolicLink() &&
			(typeof process.getuid !== "function" || metadata.uid === process.getuid())
		)
	} catch {
		return false
	}
}

/** Whether the wrapper is that same kind of file and executable as well. */
function isOwnedExecutable(path: string): boolean {
	if (!isOwnedRegularFile(path)) return false
	try {
		accessSync(path, constants.X_OK)
		return true
	} catch {
		return false
	}
}

/**
 * One vault reading reduced to the text it may be interpreted from. A
 * non-zero status, a signal, a failed spawn, a missing stream, and output
 * over the bound are all the same answer: a reply that proves nothing.
 */
function vaultReplyText(reading: VaultCommandReading): string | undefined {
	if (reading.failed || reading.signal !== null || reading.status !== 0) return undefined
	if (reading.stdout === null || reading.stdout.length > credentialWrapperOutputLimit) {
		return undefined
	}
	return reading.stdout
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
 * the configured Credential Vault, the wrapper, the candidate listing, the
 * per-item readings, the exact-origin unique match, the one field, the proved
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
	if (!isOwnedExecutable(credentialWrapperPath)) return { kind: "wrapper_unavailable" }
	const listing = vaultReplyText(
		runVaultCommand(credentialWrapperPath, [
			"op",
			"item",
			"list",
			"--vault",
			vault,
			"--categories",
			"Login",
			"--format",
			"json",
		]),
	)
	const candidates = listing === undefined ? undefined : interpretLoginItemList(listing)
	if (candidates === undefined) return { kind: "vault_unverified" }
	const matches: CredentialItemReading[] = []
	for (const candidate of candidates) {
		const replyText = vaultReplyText(
			runVaultCommand(credentialWrapperPath, [
				"op",
				"item",
				"get",
				candidate,
				"--vault",
				vault,
				"--format",
				"json",
			]),
		)
		const item = replyText === undefined ? undefined : interpretLoginItem(replyText)
		if (item === undefined) return { kind: "vault_unverified" }
		// An item neither of whose vault names is the configured one answered for
		// a vault this Module never asked about, and nothing from it is used.
		if (item.vaultId !== vault && item.vaultName !== vault) return { kind: "vault_mismatch" }
		if (declaresExactOrigin(item, input.origin)) matches.push(item)
	}
	if (matches.length === 0) return { kind: "match_absent" }
	// Two items declaring one exact origin is a question for the vault's owner,
	// never a choice this Module makes: it does not pick a winner.
	if (matches.length > 1) return { kind: "match_ambiguous" }
	const matched = matches[0]!
	const purpose = input.field === "username" ? "USERNAME" : "PASSWORD"
	const selected = matched.fields.filter((field) => field.purpose === purpose && field.id !== "")
	if (selected.length !== 1) return { kind: "field_ambiguous" }
	// The field is named by id, never by label, and every segment is
	// URL-path-encoded. This is what closes the duplicate-label hazard the op
	// CLI has: two fields may share a label, and a label may carry reference
	// syntax, but an encoded id names exactly one field.
	const reference = `op://${encodeURIComponent(vault)}/${encodeURIComponent(matched.id)}/${
		encodeURIComponent(selected[0]!.id)
	}`
	// The child re-enters through the same entry this process was started from,
	// so one bundle still ships. The entry is proved owned before the wrapper
	// is asked to hand a secret to it.
	const entry = process.argv[1]
	if (entry === undefined || !isOwnedRegularFile(entry)) {
		return { kind: "unverified", touchedPage: false }
	}
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
		runPrivateDelivery({ wrapper: credentialWrapperPath, reference, command }),
	)
}
