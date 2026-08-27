/**
 * One raw loopback listener reading, kept separate from its interpretation so
 * the observation rules stay provable without opening a loopback socket or
 * reading a host socket table.
 */
export interface ListenerReading {
	readonly status: number | null
	readonly signal: NodeJS.Signals | null
	readonly failed: boolean
	readonly stdout: string | null
}

/**
 * One `lsof -Fp` line is the letter `p` followed by a canonical process
 * identity. It is the only field this reading requests, so any other nonempty
 * line means the reading is not the one the observation rules were written for.
 */
const processIdentityField = /^p([1-9][0-9]*)$/

/**
 * Interprets one reading as the single listening process, as proved absence, or
 * as unverifiable.
 *
 * The observation is all-or-nothing, exactly like the local process table's. A
 * failed or signalled read, an unexpected exit status, output that is truncated
 * before its final newline, any nonempty line that is not a canonical process
 * identity field, any identity outside the safe-integer range, and any reading
 * naming more than one distinct owner all make the whole observation
 * unverifiable. No line is ever skipped, because a skipped line would let a
 * second live listener read as one proved owner.
 *
 * Exit status 1 is the documented "no matching files" result and is the only
 * status that proves absence. This reading cannot separate that result from a
 * read that failed with the same status, so absence is deliberately never used
 * as proof of a security property: its one caller treats absence as "not
 * listening yet" and still fails closed once its bound expires.
 */
export function observeLoopbackListener(
	reading: ListenerReading,
): "absent" | "unverifiable" | number {
	if (reading.failed || reading.signal !== null) return "unverifiable"
	const stdout = reading.stdout
	if (typeof stdout !== "string") return "unverifiable"
	if (reading.status === 1) return stdout === "" ? "absent" : "unverifiable"
	if (reading.status !== 0) return "unverifiable"
	if (stdout === "" || !stdout.endsWith("\n")) return "unverifiable"
	const owners = new Set<number>()
	for (const line of stdout.slice(0, -1).split("\n")) {
		const match = processIdentityField.exec(line)
		if (!match) return "unverifiable"
		const owner = Number(match[1]!)
		if (!Number.isSafeInteger(owner)) return "unverifiable"
		owners.add(owner)
	}
	return owners.size === 1 ? [...owners][0]! : "unverifiable"
}
