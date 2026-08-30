import { mock } from "bun:test"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type {
	PrivateDeliveryReading,
	VaultCommandReading,
} from "../../src/modules/private-delivery/credential-effects"
import {
	interpretLoginItemDetail,
	interpretLoginItemList,
	sanitizedCredentialDetailReply,
	sanitizedCredentialListReply,
} from "../../src/modules/private-delivery/credential-match"

/**
 * The single private test-owned substitute for Private Delivery's
 * `credential-effects` seam. It exists so the wrapper contract can be proved
 * from the outside without a 1Password account: the secret it delivers is a
 * test sentinel, and the child, its argument list, its environment, its CDP
 * conversation, and the page it types into are all real.
 *
 * `runVaultCommand` and `runSanitizedCredentialDetail` never reach a real
 * vault: they record their invocations and answer with the metadata-only
 * reading the plan scripts, so production interpretation is exercised against
 * bytes the test states. `runPrivateDelivery`
 * records the invocation and then does exactly what the real wrapper's
 * `inject-stdin` command does: it spawns the given command as a real process,
 * hands the sentinel over on the child's standard input alone, and scrubs the
 * child's environment to exactly the variables the real wrapper preserves.
 */

const root = process.env.WARM_BROWSER_FIXTURE_ROOT
if (!root) throw new Error("WARM_BROWSER_FIXTURE_ROOT is required by the private credential fake")
const planPath = join(root, "credential-effects.json")
const actionsPath = join(root, "actions.jsonl")

interface CredentialEffectsPlan {
	/** The literal reading served for `op item list`. */
	readonly vaultList?: VaultCommandReading
	/** The literal reading served for the one uniquely selected `op item get` detail read. */
	readonly vaultGet?: VaultCommandReading
	/** The exact text the fake wrapper delivers on the child's standard input. */
	readonly sentinel?: string
	/**
	 * Answers as a wrapper that exited before the child ran: the given status,
	 * no signal, and no child reply at all.
	 */
	readonly deliveryFails?: { readonly status: number }
}

function plan(): CredentialEffectsPlan {
	return existsSync(planPath) ? JSON.parse(readFileSync(planPath, "utf8")) : {}
}

function action(value: Record<string, unknown>): void {
	appendFileSync(actionsPath, `${JSON.stringify(value)}\n`)
}

/**
 * The variables the real wrapper preserves for the child, each only when the
 * parent has it. Everything else the parent holds never reaches the process
 * that holds the secret.
 */
const preservedVariables = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR"] as const

function scrubbedEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {}
	for (const name of preservedVariables) {
		const value = process.env[name]
		if (value !== undefined) environment[name] = value
	}
	return environment
}

/**
 * Whether the installed op CLI would parse this secret reference at all.
 *
 * This is the host grammar as it was measured, not a copy of the rule the
 * Module builds references to: `op://` names exactly three non-empty segments,
 * and a segment carrying a per-cent sign is read as an invalid reference
 * rather than as an encoding. It is deliberately wider than the Module's own
 * allow-list, so a reference the Module would refuse to build can still be
 * asked about here.
 */
function resolvableReference(reference: string): boolean {
	if (!reference.startsWith("op://")) return false
	const segments = reference.slice("op://".length).split("/")
	return segments.length === 3 &&
		segments.every((segment) => segment !== "" && !segment.includes("%"))
}

const fake: typeof import("../../src/modules/private-delivery/credential-effects") = {
	runVaultCommand: async (wrapper, argumentList): Promise<VaultCommandReading> => {
		action({ action: "vault", wrapper, argumentList: [...argumentList] })
		const current = plan()
		if (argumentList[2] === "list" && current.vaultList !== undefined) return current.vaultList
		throw new Error("the private credential fake serves no reading for this vault command")
	},
	runSanitizedCredentialList: async (input): Promise<VaultCommandReading> => {
		action({
			action: "vault",
			wrapper: input.wrapper,
			argumentList: [
				"op",
				"item",
				"list",
				"--vault",
				input.vault,
				"--categories",
				"Login",
				"--format",
				"json",
			],
		})
		const reading = plan().vaultList
		if (reading === undefined) {
			throw new Error("the private credential fake serves no list reading")
		}
		const raw = reading.status === 0 && reading.signal === null && !reading.failed
			? reading.stdout
			: null
		const candidates = raw === null ? undefined : interpretLoginItemList(raw)
		return candidates === undefined
			? { status: 20, signal: null, failed: false, stdout: "" }
			: {
				status: 0,
				signal: null,
				failed: false,
				stdout: sanitizedCredentialListReply(candidates),
			}
	},
	runSanitizedCredentialDetail: async (input): Promise<VaultCommandReading> => {
		action({
			action: "vault",
			wrapper: input.wrapper,
			argumentList: [
				"op",
				"item",
				"get",
				input.itemId,
				"--vault",
				input.vault,
				"--format",
				"json",
			],
		})
		const reading = plan().vaultGet
		if (reading === undefined) {
			throw new Error("the private credential fake serves no detail reading")
		}
		const raw = reading.status === 0 && reading.signal === null && !reading.failed
			? reading.stdout
			: null
		const detail = raw === null ? undefined : interpretLoginItemDetail(raw)
		return detail === undefined
			? { status: 20, signal: null, failed: false, stdout: "" }
			: {
				status: 0,
				signal: null,
				failed: false,
				stdout: sanitizedCredentialDetailReply(detail),
			}
	},
	runPrivateDelivery: async (input): Promise<PrivateDeliveryReading> => {
		const environment = scrubbedEnvironment()
		action({
			action: "deliver",
			wrapper: input.wrapper,
			reference: input.reference,
			command: [...input.command],
			environmentKeys: Object.keys(environment),
			environment,
		})
		const current = plan()
		if (current.deliveryFails !== undefined) {
			return {
				status: current.deliveryFails.status,
				signal: null,
				failed: false,
				stdout: "",
			}
		}
		// The installed op CLI resolves a reference before the target command
		// exists, and a reference it will not parse is answered by the wrapper
		// alone: exit 1, nothing on either stream, and no child. Serving a
		// delivery for a reference op would reject is what let an unusable
		// reference read as a healthy one here, so the fake refuses it the same
		// way the host does.
		if (!resolvableReference(input.reference)) {
			return { status: 1, signal: null, failed: false, stdout: "" }
		}
		const sentinel = current.sentinel
		if (sentinel === undefined) {
			throw new Error("the private credential fake was asked to deliver with no sentinel planned")
		}
		const result = spawnSync(input.command[0]!, input.command.slice(1), {
			input: sentinel,
			env: environment,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		})
		return {
			status: result.status,
			signal: result.signal,
			failed: result.error !== undefined,
			stdout: typeof result.stdout === "string" ? result.stdout : null,
		}
	},
}

const seam = fileURLToPath(
	new URL("../../src/modules/private-delivery/credential-effects.ts", import.meta.url),
)

mock.module(seam, () => fake)
