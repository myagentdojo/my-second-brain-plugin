import { expect } from "bun:test"

/**
 * The one owner of how a Warm Browser refusal is checked, for every test that
 * drives the CLI as a process. Only the shape lives here: the envelope always
 * comes from the calling test, so no oracle is shared between tests.
 *
 * A synchronous child hands back byte buffers and an asynchronous one hands back
 * text, so both readings are accepted and normalised here rather than growing a
 * second owner for the same contract.
 */

export interface CliRunReading {
	readonly exitCode: number | null
	readonly stdout: unknown
	readonly stderr: unknown
}

function output(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)}\n`
}

function text(stream: unknown): string {
	return typeof stream === "string" ? stream : String(stream)
}

/** The exact refusal: one exit class, no stdout, and this literal envelope. */
export function expectError(
	result: CliRunReading,
	exitCode: 1 | 2 | 20 | 21 | 22,
	envelope: Record<string, unknown>,
): void {
	expect(result.exitCode).toBe(exitCode)
	expect(text(result.stdout)).toBe("")
	expect(text(result.stderr)).toBe(output(envelope))
}

/** The same refusal narrowed to the envelope fields one test names. */
export function expectRefusal(
	result: CliRunReading,
	exitCode: 1 | 2 | 20 | 21 | 22,
	envelope: Record<string, unknown>,
): void {
	expect(result.exitCode).toBe(exitCode)
	expect(text(result.stdout)).toBe("")
	expect(JSON.parse(text(result.stderr))).toMatchObject(envelope)
}
