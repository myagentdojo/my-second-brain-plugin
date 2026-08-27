import type { BrowserProcessIdentity, ProcessListInspection } from "./contract"

/**
 * One raw local process-table reading, kept separate from its interpretation so
 * the observation rules stay provable without reading a host process table.
 */
export interface ProcessTableReading {
	readonly status: number | null
	readonly signal: NodeJS.Signals | null
	readonly failed: boolean
	readonly stdout: string | null
}

/**
 * One row is `pid`, `pgid`, the fixed-width start token, then the command line.
 * The command line is the only free-form field and it is last, so a row is
 * framed only by its own newline.
 */
const rowPattern = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(\S.*)$/
const canonicalIdentifier = /^(?:0|[1-9][0-9]*)$/
const unframedCharacter = /\p{Cc}/u
const unverifiable = { kind: "unverifiable" } as const

function safeIdentifier(digits: string): number | undefined {
	if (!canonicalIdentifier.test(digits)) return undefined
	const value = Number(digits)
	return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Classifies a row's executable at a whole-token boundary. A known executable
 * claims the row only when the row is exactly that path or that path followed
 * by an argument separator, so a neighbouring path that merely begins with it,
 * such as one suffixed `-evil`, never classifies as the known executable.
 */
function classifyExecutable(commandLine: string, knownExecutable: string): string {
	return commandLine === knownExecutable || commandLine.startsWith(`${knownExecutable} `)
		? knownExecutable
		: commandLine.split(" ")[0]!
}

/**
 * Interprets one reading as the whole live process table or as unverifiable.
 *
 * The observation is all-or-nothing. A failed or signalled read, output that is
 * empty or truncated, any nonempty row that does not parse, any row carrying a
 * control character, any process identity outside the canonical safe-integer
 * range, and any repeated process identity all make the whole observation
 * unverifiable. No row is ever skipped, because a skipped row would let a live
 * process read as proved absence.
 */
export function observeProcessTable(
	reading: ProcessTableReading,
	knownExecutable: string,
): ProcessListInspection {
	if (reading.failed || reading.signal !== null || reading.status !== 0) return unverifiable
	const stdout = reading.stdout
	if (typeof stdout !== "string" || stdout === "" || !stdout.endsWith("\n")) return unverifiable
	const processes: BrowserProcessIdentity[] = []
	const claimed = new Set<number>()
	for (const line of stdout.slice(0, -1).split("\n")) {
		if (unframedCharacter.test(line)) return unverifiable
		const match = rowPattern.exec(line)
		if (!match) return unverifiable
		const pid = safeIdentifier(match[1]!)
		const processGroupId = safeIdentifier(match[2]!)
		if (pid === undefined || processGroupId === undefined || claimed.has(pid)) return unverifiable
		claimed.add(pid)
		const commandLine = match[4]!
		processes.push({
			pid,
			processGroupId,
			startedAtToken: match[3]!,
			executable: classifyExecutable(commandLine, knownExecutable),
			commandLine,
		})
	}
	return { kind: "verified", processes }
}
