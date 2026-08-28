import { mock } from "bun:test"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type {
	PrivateDeliveryReading,
	VaultCommandReading,
} from "../../src/modules/private-delivery/credential-effects"

/**
 * The single private test-owned substitute for Private Delivery's
 * `credential-effects` seam. It exists so the wrapper contract can be proved
 * from the outside without a 1Password account: the secret it delivers is a
 * test sentinel, and the child, its argument list, its environment, its CDP
 * conversation, and the page it types into are all real.
 *
 * `runVaultCommand` never spawns anything: it records the invocation and
 * answers with the reading the plan scripts, so the production interpretation
 * of op replies is exercised against bytes the test states. `runPrivateDelivery`
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
	/** Readings for `op item get <id>`, keyed by the item id. */
	readonly vaultGet?: Record<string, VaultCommandReading>
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

const fake: typeof import("../../src/modules/private-delivery/credential-effects") = {
	runVaultCommand: (wrapper, argumentList): VaultCommandReading => {
		action({ action: "vault", wrapper, argumentList: [...argumentList] })
		const current = plan()
		if (argumentList[2] === "list" && current.vaultList !== undefined) return current.vaultList
		if (argumentList[2] === "get") {
			const reading = current.vaultGet?.[argumentList[3] ?? ""]
			if (reading !== undefined) return reading
		}
		throw new Error("the private credential fake serves no reading for this vault command")
	},
	runPrivateDelivery: (input): PrivateDeliveryReading => {
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
				stderr: "",
			}
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
			stderr: typeof result.stderr === "string" ? result.stderr : null,
		}
	},
}

const seam = fileURLToPath(
	new URL("../../src/modules/private-delivery/credential-effects.ts", import.meta.url),
)

mock.module(seam, () => fake)
