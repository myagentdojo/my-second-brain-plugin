/**
 * An independent reader of one CDP endpoint.
 *
 * It shares no code with the Warm Browser Module: it performs its own loopback
 * reads and its own parsing, so what it reports about a browser process and its
 * Controlled Page is evidence about the endpoint rather than a restatement of
 * what Warm Browser concluded. A test compares the two.
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
