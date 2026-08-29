import { spawn } from "node:child_process"

import {
	credentialDetailSanitizerTimeoutMs,
	credentialWrapperKillSignal,
	credentialWrapperOutputLimit,
	credentialWrapperTimeoutMs,
	privateDeliveryDetailSanitizerArgument,
	privateDeliveryListSanitizerArgument,
} from "./contract"

/**
 * Every raw credential-wrapper effect Private Delivery performs: one
 * disposable list sanitizer, one disposable detail sanitizer, and one
 * delivery.
 *
 * This is the Module's internal seam, mirroring `warm-browser/host-effects.ts`
 * in spirit: raw effects only, with no policy, no vocabulary, no retry, and no
 * interpretation. No call places a secret in an argument list: a vault
 * command names items and formats, and the delivery names an `op://` reference
 * the wrapper itself resolves. Every outer process receives only the five
 * basic process variables; each wrapper invocation performs its own documented
 * scrubbing again before anything sensitive exists.
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

type ProcessGroupOwnership = "child" | "current"

/**
 * Sends SIGKILL to the exact process group this Module created. A detached
 * child leads a fresh group on the supported Unix hosts, so a wrapper cannot
 * leave its op subprocess or delivery child behind when the bound fires.
 */
function killOwnedProcessGroup(
	child: ReturnType<typeof spawn>,
	ownership: ProcessGroupOwnership,
): boolean {
	const pid = ownership === "child" ? child.pid : process.pid
	if (pid === undefined) return false
	try {
		process.kill(-pid, credentialWrapperKillSignal)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
			try {
				return child.kill(credentialWrapperKillSignal)
			} catch {
				return false
			}
		}
		return false
	}
}

/** One bounded process tree and its bounded public readings. */
function runBoundedProcess(input: {
	readonly command: string
	readonly argumentList: readonly string[]
	readonly timeoutMs: number
	readonly environment?: NodeJS.ProcessEnv
	readonly processGroupOwnership: ProcessGroupOwnership
}): Promise<VaultCommandReading> {
	return new Promise((resolveReading) => {
		const child = spawn(input.command, [...input.argumentList], {
			detached: input.processGroupOwnership === "child",
			env: input.environment,
			stdio: ["ignore", "pipe", "ignore"],
		})
		const stdout: Buffer[] = []
		let stdoutBytes = 0
		let failed = false
		let settled = false

		const stopAsFailure = (): void => {
			failed = true
			killOwnedProcessGroup(child, input.processGroupOwnership)
		}
		const capture = (chunk: Buffer): void => {
			if (stdoutBytes + chunk.length > credentialWrapperOutputLimit) {
				stopAsFailure()
				return
			}
			stdout.push(chunk)
			stdoutBytes += chunk.length
		}

		child.stdout?.on("data", capture)
		child.on("error", () => {
			failed = true
		})
		const timeout = setTimeout(stopAsFailure, input.timeoutMs)
		child.on("close", (status, signal) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			// A successful signal here means the leader exited while another member
			// of its owned group survived. Remove it and refuse the reading.
			if (
				input.processGroupOwnership === "child" &&
				killOwnedProcessGroup(child, input.processGroupOwnership)
			) {
				failed = true
			}
			resolveReading({
				status,
				signal,
				failed,
				stdout: Buffer.concat(stdout).toString("utf8"),
			})
		})
	})
}

/**
 * Runs one wrapper-mediated op command and reads its reply without
 * interpreting it. The parent uses this for the metadata listing; the
 * disposable sanitizer uses it for the one uniquely selected detail read.
 * Neither command writes anything to the wrapper, so the wrapper reads no
 * standard input at all.
 */
export async function runVaultCommand(
	wrapper: string,
	argumentList: readonly string[],
	processGroupOwnership: ProcessGroupOwnership = "child",
): Promise<VaultCommandReading> {
	const result = await runBoundedProcess({
		command: wrapper,
		argumentList,
		timeoutMs: credentialWrapperTimeoutMs,
		processGroupOwnership,
	})
	return {
		status: result.status,
		signal: result.signal,
		failed: result.failed,
		stdout: typeof result.stdout === "string" ? result.stdout : null,
	}
}

/** The ambient names the sanitizer may inherit before its wrapper scrubs again. */
const sanitizerEnvironmentNames = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR"] as const

function sanitizerEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {}
	for (const name of sanitizerEnvironmentNames) {
		const value = process.env[name]
		if (value !== undefined) environment[name] = value
	}
	return environment
}

/**
 * Runs one disposable sanitizer entry with only non-secret arguments. The
 * parent captures only the sanitizer's bounded metadata reply; wrapper stderr
 * and the original op stream never enter it.
 */
async function runCredentialSanitizer(
	entry: string,
	argumentList: readonly string[],
): Promise<VaultCommandReading> {
	const result = await runBoundedProcess({
		command: process.execPath,
		argumentList: [
			"--config=/dev/null",
			"--no-install",
			"--env-file=/dev/null",
			entry,
			...argumentList,
		],
		environment: sanitizerEnvironment(),
		timeoutMs: credentialDetailSanitizerTimeoutMs,
		processGroupOwnership: "child",
	})
	return {
		status: result.status,
		signal: result.signal,
		failed: result.failed,
		stdout: typeof result.stdout === "string" ? result.stdout : null,
	}
}

/** Runs the disposable sanitizer that owns the complete item-detail read. */
export function runSanitizedCredentialDetail(input: {
	readonly wrapper: string
	readonly entry: string
	readonly itemId: string
	readonly vault: string
}): Promise<VaultCommandReading> {
	return runCredentialSanitizer(input.entry, [
		privateDeliveryDetailSanitizerArgument,
		input.wrapper,
		input.itemId,
		input.vault,
	])
}

/** Runs the disposable sanitizer that owns the complete Login listing. */
export function runSanitizedCredentialList(input: {
	readonly wrapper: string
	readonly entry: string
	readonly vault: string
}): Promise<VaultCommandReading> {
	return runCredentialSanitizer(input.entry, [
		privateDeliveryListSanitizerArgument,
		input.wrapper,
		input.vault,
	])
}

export interface PrivateDeliveryReading {
	readonly status: number | null
	readonly signal: string | null
	readonly failed: boolean
	readonly stdout: string | null
}

/**
 * Runs one delivery through the wrapper's `inject-stdin` command, which
 * resolves the reference itself and hands the resolved value to the command on
 * its standard input. Only the child's closed stdout reply is retained;
 * stderr is discarded before it can enter the parent process.
 */
export async function runPrivateDelivery(input: {
	readonly wrapper: string
	readonly reference: string
	readonly command: readonly string[]
}): Promise<PrivateDeliveryReading> {
	const result = await runBoundedProcess({
		command: input.wrapper,
		argumentList: ["inject-stdin", input.reference, "--", ...input.command],
		environment: sanitizerEnvironment(),
		timeoutMs: credentialWrapperTimeoutMs,
		processGroupOwnership: "child",
	})
	return {
		status: result.status,
		signal: result.signal,
		failed: result.failed,
		stdout: typeof result.stdout === "string" ? result.stdout : null,
	}
}
