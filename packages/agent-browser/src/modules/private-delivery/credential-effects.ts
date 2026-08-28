import { spawnSync } from "node:child_process"

import { credentialWrapperOutputLimit } from "./contract"

/**
 * Every raw credential-wrapper effect Private Delivery performs: one vault
 * reading and one delivery, each as one child process of the one wrapper.
 *
 * This is the Module's internal seam, mirroring `warm-browser/host-effects.ts`
 * in spirit: raw effects only, with no policy, no vocabulary, no retry, and no
 * interpretation. Neither call places a secret in an argument list: a vault
 * command names items and formats, and the delivery names an `op://` reference
 * the wrapper itself resolves. Neither passes an `env` option, so the wrapper
 * receives the ordinary environment and performs its own documented scrubbing
 * before anything sensitive exists.
 *
 * The file also exists so a test can substitute it and prove the wrapper
 * contract from the outside without a 1Password account: everything above this
 * seam, the ordering, the matching, the child argument list, and the
 * interpretation of these readings, stays real.
 */

export interface VaultCommandReading {
	readonly status: number | null
	readonly signal: string | null
	readonly failed: boolean
	readonly stdout: string | null
}

/** Runs one wrapper-mediated op command and reads its reply without interpreting it. */
export function runVaultCommand(
	wrapper: string,
	argumentList: readonly string[],
): VaultCommandReading {
	const result = spawnSync(wrapper, [...argumentList], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: credentialWrapperOutputLimit,
	})
	return {
		status: result.status,
		signal: result.signal,
		failed: result.error !== undefined,
		stdout: typeof result.stdout === "string" ? result.stdout : null,
	}
}

export interface PrivateDeliveryReading {
	readonly status: number | null
	readonly signal: string | null
	readonly failed: boolean
	readonly stdout: string | null
	readonly stderr: string | null
}

/**
 * Runs one delivery through the wrapper's `inject-stdin` command, which
 * resolves the reference itself and hands the resolved value to the command on
 * its standard input, and reads back only what the processes said.
 */
export function runPrivateDelivery(input: {
	readonly wrapper: string
	readonly reference: string
	readonly command: readonly string[]
}): PrivateDeliveryReading {
	const result = spawnSync(
		input.wrapper,
		["inject-stdin", input.reference, "--", ...input.command],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: credentialWrapperOutputLimit,
		},
	)
	return {
		status: result.status,
		signal: result.signal,
		failed: result.error !== undefined,
		stdout: typeof result.stdout === "string" ? result.stdout : null,
		stderr: typeof result.stderr === "string" ? result.stderr : null,
	}
}
