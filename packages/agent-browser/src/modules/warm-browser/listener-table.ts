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
 * One `lsof -Fp` process set begins with the letter `p` followed by a canonical
 * process identity and has one or more `f` file descriptor fields after it.
 * The `f` field is always selected by lsof's `-F` output, so a process identity
 * without a descriptor is not a reading lsof produces.
 */
const processIdentityField = /^p([1-9][0-9]*)$/
const fileDescriptorField = /^f(0|[1-9][0-9]*)$/

/**
 * Reads the one process set that starts at `index`: its process identity line
 * and the one or more file descriptor lines lsof always reports after it.
 * Answers the owner and the index of the next set, or null when the lines at
 * `index` are not exactly one process set.
 */
function readProcessSet(
	lines: readonly string[],
	index: number,
): { readonly owner: number; readonly next: number } | null {
	const processMatch = processIdentityField.exec(lines[index]!)
	if (!processMatch) return null
	const owner = Number(processMatch[1]!)
	if (!Number.isSafeInteger(owner)) return null
	let next = index + 1
	while (next < lines.length && fileDescriptorField.test(lines[next]!)) {
		next += 1
	}
	if (next === index + 1) return null
	return { owner, next }
}

/**
 * Interprets one reading as the single listening process, as proved absence, or
 * as unverifiable.
 *
 * The observation is all-or-nothing, exactly like the local process table's. A
 * failed or signalled read, an unexpected exit status, output that is truncated
 * before its final newline, any line that is not a canonical process identity
 * or file descriptor field in its required position, any identity outside the
 * safe-integer range, and any reading naming more than one distinct owner all
 * make the whole observation unverifiable. No line is ever skipped, because a
 * skipped line would let a second live listener read as one proved owner.
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
	const lines = stdout.slice(0, -1).split("\n")
	const owners = new Set<number>()
	for (let index = 0; index < lines.length; ) {
		const processSet = readProcessSet(lines, index)
		if (processSet === null) return "unverifiable"
		owners.add(processSet.owner)
		index = processSet.next
	}
	return owners.size === 1 ? [...owners][0]! : "unverifiable"
}
