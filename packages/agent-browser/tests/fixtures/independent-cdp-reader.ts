import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * An independent reader of one CDP endpoint and of the Browser Session behind
 * it.
 *
 * It shares no code with the Warm Browser Module: it performs its own loopback
 * reads and its own parsing, and it reads the raw effects the harness recorded
 * rather than anything the CLI concluded or printed. What it reports about a
 * browser process, its loopback listener, and its Controlled Page is therefore
 * evidence about the session, not a restatement of Warm Browser's answer. A
 * test compares the two, and can show the evidence refusing a wrong one.
 */

export interface IndependentTarget {
	readonly id: string
	readonly type: string
	readonly url: string
	readonly webSocketDebuggerUrl: string
}

export interface IndependentEndpointReading {
	readonly browser: string
	readonly protocolVersion: string
	readonly browserWebSocketHost: string
	readonly browserWebSocketPort: number
	readonly pageTargets: readonly IndependentTarget[]
	readonly targetIds: readonly string[]
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value === "") {
		throw new Error(`the independent CDP reading has no ${field}`)
	}
	return value
}

export async function readCdpEndpointIndependently(
	port: number,
): Promise<IndependentEndpointReading> {
	const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`, {
		signal: AbortSignal.timeout(2_000),
	})).json()) as Record<string, unknown>
	const socket = new URL(requireString(version.webSocketDebuggerUrl, "webSocketDebuggerUrl"))
	const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, {
		signal: AbortSignal.timeout(2_000),
	})).json()) as Array<Record<string, unknown>>
	if (!Array.isArray(list)) throw new Error("the independent CDP target list is not a list")
	const targets = list.map((target) => ({
		id: requireString(target.id, "target id"),
		type: requireString(target.type, "target type"),
		url: requireString(target.url, "target url"),
		webSocketDebuggerUrl: requireString(target.webSocketDebuggerUrl, "target socket"),
	}))
	return {
		browser: requireString(version.Browser, "Browser"),
		protocolVersion: requireString(version["Protocol-Version"], "Protocol-Version"),
		browserWebSocketHost: socket.hostname,
		browserWebSocketPort: Number(socket.port),
		pageTargets: targets.filter((target) => target.type === "page"),
		targetIds: targets.map((target) => target.id),
	}
}

export interface IndependentSessionEvidence {
	readonly endpoint: IndependentEndpointReading
	/** The leader identity the raw launch effect actually created. */
	readonly launchedProcessId: number | undefined
	/** The whole command line that leader was launched with. */
	readonly launchedCommandLine: string | undefined
	/** Every loopback port the listener was read for, in the order it was read. */
	readonly listenerPorts: readonly number[]
	/** Every loopback document that was read, in the order it was read. */
	readonly documentPaths: readonly string[]
}

function recordedEffects(fixtureRoot: string): Array<Record<string, unknown>> {
	const path = join(fixtureRoot, "actions.jsonl")
	if (!existsSync(path)) return []
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Reads the whole chain from the launched process to the Controlled Page,
 * without asking Warm Browser anything: the leader identity comes from the raw
 * launch record, the listener readings and loopback documents come from the raw
 * effect log, and the targets come from the endpoint itself.
 */
export async function readBrowserSessionEvidenceIndependently(
	fixtureRoot: string,
	port: number,
): Promise<IndependentSessionEvidence> {
	const spawnedPath = join(fixtureRoot, "spawned.json")
	const leaders = existsSync(spawnedPath)
		? (JSON.parse(readFileSync(spawnedPath, "utf8")) as Array<Record<string, unknown>>)
		: []
	const leader = leaders.at(-1)
	const effects = recordedEffects(fixtureRoot)
	return {
		endpoint: await readCdpEndpointIndependently(port),
		launchedProcessId: typeof leader?.pid === "number" ? leader.pid : undefined,
		launchedCommandLine: typeof leader?.commandLine === "string" ? leader.commandLine : undefined,
		listenerPorts: effects
			.filter((effect) => effect.action === "listener")
			.map((effect) => Number(effect.port)),
		documentPaths: effects
			.filter((effect) => effect.action === "http")
			.map((effect) => new URL(String(effect.url)).pathname),
	}
}
