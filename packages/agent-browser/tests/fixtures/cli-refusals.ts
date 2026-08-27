import { expect } from "bun:test"

/**
 * The one owner of how a Warm Browser refusal is checked, for every test that
 * drives the CLI as a process. Only the shape lives here: the envelope always
 * comes from the calling test, so no oracle is shared between tests.
 */

function output(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)}\n`
}

/** The exact refusal: one exit class, no stdout, and this literal envelope. */
export function expectError(
	result: Bun.ReadableSyncSubprocess,
	exitCode: 1 | 2 | 20 | 21 | 22,
	envelope: Record<string, unknown>,
): void {
	expect(result.exitCode).toBe(exitCode)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(output(envelope))
}

/** The same refusal narrowed to the envelope fields one test names. */
export function expectRefusal(
	result: Bun.ReadableSyncSubprocess,
	exitCode: 1 | 2 | 20 | 21 | 22,
	envelope: Record<string, unknown>,
): void {
	expect(result.exitCode).toBe(exitCode)
	expect(result.stdout.toString()).toBe("")
	expect(JSON.parse(result.stderr.toString())).toMatchObject(envelope)
}
