import { randomUUID } from "node:crypto"
import { existsSync, lstatSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { SpawnCleanupUnverifiedError } from "./contract"
import type {
	BrowserProcessIdentity,
	EndpointVerification,
	ProcessListInspection,
} from "./contract"
import type { WarmBrowserAdapter } from "./adapter"
import {
	connectLoopbackPort,
	hostPlatform,
	isExecutableFile,
	readLoopbackJson,
	readLoopbackListener,
	readProcessTable,
	signalProcessGroup,
	startDetachedProcess,
} from "./host-effects"
import { observeLoopbackListener } from "./listener-table"
import { observeProcessTable } from "./process-table"
import {
	commandHasArgument,
	isOwnedLaunch,
	isSameProcess,
	type LaunchOwnership,
	ownsProcess,
} from "./ownership"

const installedChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

function privateOwnedDirectory(path: string): boolean {
	if (!existsSync(path)) return false
	const metadata = lstatSync(path)
	return (
		metadata.isDirectory() &&
		!metadata.isSymbolicLink() &&
		(typeof process.getuid !== "function" || metadata.uid === process.getuid()) &&
		(metadata.mode & 0o077) === 0
	)
}

function processTable(): ProcessListInspection {
	return observeProcessTable(readProcessTable(), installedChrome)
}

function loopbackListenerOwner(port: number): "absent" | "unverifiable" | number {
	return observeLoopbackListener(readLoopbackListener(port))
}

type ProcessGroupObservation = "present" | "absent" | "unverified"

/**
 * Observes one process group without signalling it. A delivered or denied probe
 * proves the group is present, and only the "no such process" outcome proves it
 * absent. Every other outcome, including an unsafe identity or an unexpected
 * error, is an uncertain observation: it never reads as proved absence, because
 * proved absence is what lets the caller remove durable ownership state.
 */
function observeProcessGroup(processGroupId: number): ProcessGroupObservation {
	const outcome = signalProcessGroup(processGroupId, 0)
	if (outcome === "delivered" || outcome === "denied") return "present"
	return outcome === "absent" ? "absent" : "unverified"
}

async function pause(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Waits for one signalled process group to be observed absent, and reports what
 * it last observed. An uncertain observation ends the wait immediately: the
 * group is neither proved gone nor proved present, so neither escalation nor a
 * claimed stop is admissible.
 */
async function awaitProcessGroupAbsence(
	processGroupId: number,
	attempts: number,
): Promise<ProcessGroupObservation> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const observed = observeProcessGroup(processGroupId)
		if (observed !== "present") return observed
		await pause(50)
	}
	return "present"
}

/**
 * Stops one process group and answers whether the stop is proved. Only an
 * observed absence answers true; a group still present after its bound is
 * escalated once, and an unverifiable observation ends the attempt without
 * signalling further.
 */
async function terminateProcessGroupWithEscalation(
	expected: BrowserProcessIdentity,
	ownership: LaunchOwnership,
): Promise<boolean> {
	const processGroupId = expected.processGroupId
	const requested = signalProcessGroup(processGroupId, "SIGTERM")
	if (requested === "absent") return true
	if (requested !== "delivered") return false
	const afterTermination = await awaitProcessGroupAbsence(processGroupId, 40)
	if (afterTermination !== "present") return afterTermination === "absent"
	// The bounded probes only proved that something answers to this process
	// group. Between the request and now the identity may have exited and its
	// number been reused, so the table is read again and the whole ownership
	// re-proved. Escalation is the last irreversible act available, and it is
	// never taken on an identity that is merely still numerically present.
	const table = processTable()
	if (table.kind === "unverifiable") return false
	const observed = table.processes.find(
		(processIdentity) => processIdentity.pid === expected.pid,
	)
	if (observed === undefined) return true
	if (!ownsProcess(expected, observed, ownership)) return false
	const escalated = signalProcessGroup(processGroupId, "SIGKILL")
	if (escalated === "absent") return true
	if (escalated !== "delivered") return false
	return (await awaitProcessGroupAbsence(processGroupId, 20)) === "absent"
}

async function readEndpoint(
	port: number,
	expected: BrowserProcessIdentity,
): Promise<EndpointVerification> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const table = processTable()
		if (table.kind === "unverifiable") return { kind: "process_unverifiable" }
		const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid)
		if (!isSameProcess(expected, observed)) return { kind: "browser_unverified" }
		const owner = loopbackListenerOwner(port)
		if (owner === "unverifiable" || (owner !== "absent" && owner !== expected.pid)) {
			return { kind: "listener_unverified" }
		}
		if (owner === "absent") {
			if (attempt === 39) return { kind: "listener_unverified" }
			await pause(100)
			continue
		}
		try {
			const versionReading = await readLoopbackJson(`http://127.0.0.1:${port}/json/version`)
			const version = versionReading.body as {
				Browser?: unknown
				webSocketDebuggerUrl?: unknown
			}
			if (
				!versionReading.ok ||
				typeof version.Browser !== "string" ||
				!version.Browser.startsWith("Chrome/") ||
				typeof version.webSocketDebuggerUrl !== "string"
			) {
				return { kind: "browser_unverified" }
			}
			const webSocket = new URL(version.webSocketDebuggerUrl)
			if (
				webSocket.protocol !== "ws:" ||
				webSocket.hostname !== "127.0.0.1" ||
				Number(webSocket.port) !== port
			) {
				return { kind: "browser_unverified" }
			}
			const targetsReading = await readLoopbackJson(`http://127.0.0.1:${port}/json/list`)
			const targets = targetsReading.body as Array<{ id?: unknown; type?: unknown }>
			if (!targetsReading.ok || !Array.isArray(targets)) return { kind: "browser_unverified" }
			const pages = targets.filter((target) =>
				target.type === "page" && typeof target.id === "string"
			)
			if (pages.length === 0) {
				if (attempt === 39) return { kind: "controlled_page_unavailable" }
				await pause(100)
				continue
			}
			if (pages.length !== 1) return { kind: "controlled_page_ambiguous" }
			// The two JSON reads describe whoever answered the port a moment ago.
			// Between them and this answer the process could have exited and the
			// port been taken over, so the identity and the listener are proved
			// again here: a verified endpoint is only ever returned about a
			// process and a listener that are still the owned ones right now.
			const settled = processTable()
			if (settled.kind === "unverifiable") return { kind: "process_unverifiable" }
			if (
				!isSameProcess(
					expected,
					settled.processes.find((processIdentity) => processIdentity.pid === expected.pid),
				)
			) {
				return { kind: "browser_unverified" }
			}
			if (loopbackListenerOwner(port) !== expected.pid) return { kind: "listener_unverified" }
			return {
				kind: "verified",
				endpoint: {
					browserVersion: version.Browser,
					controlledPageTargetId: pages[0]!.id as string,
				},
			}
		} catch {
			if (attempt === 39) return { kind: "browser_unverified" }
			await pause(100)
		}
	}
	return { kind: "browser_unverified" }
}

/**
 * The fixed production Adapter. It is one value, not a factory: nothing
 * replaces it, and it accepts no injected dependency. Its host effects live
 * behind the Module's private `host-effects` seam.
 */
export const productionAdapter: WarmBrowserAdapter = {
	createRunId: () => `wb-${randomUUID()}`,
	createSessionId: () => `session-${randomUUID()}`,
	nowEpochMs: () => Date.now(),
	platform: hostPlatform,
	chromeExecutable: () => installedChrome,
	inspectChrome: (executable) => isExecutableFile(executable) ? "installed" : "unavailable",
	profileRoot: () => join(homedir(), ".agent-warm-profile"),
	inspectProfile: (profileRoot) =>
		privateOwnedDirectory(profileRoot) && privateOwnedDirectory(join(profileRoot, "Default"))
			? "safe"
			: "unsafe",
	findProfileProcesses: (profileRoot) => {
		const plain = `--user-data-dir=${profileRoot}`
		const quoted = `--user-data-dir="${profileRoot}"`
		const table = processTable()
		if (table.kind === "unverifiable") return table
		return {
			kind: "verified",
			processes: table.processes.filter(
				(processIdentity) =>
					processIdentity.executable === installedChrome &&
					(commandHasArgument(processIdentity.commandLine, plain) ||
						commandHasArgument(processIdentity.commandLine, quoted)),
			),
		}
	},
	findLaunchProcesses: (launchMarker) => {
		const table = processTable()
		if (table.kind === "unverifiable") return table
		const marker = `--agent-browser-launch-marker=${launchMarker}`
		return {
			kind: "verified",
			processes: table.processes.filter((processIdentity) =>
				commandHasArgument(processIdentity.commandLine, marker)
			),
		}
	},
	inspectPort: connectLoopbackPort,
	spawnChrome: async ({ executable, argumentList, ownership }) => {
		const launchedPid = await startDetachedProcess(executable, argumentList)
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const table = processTable()
			// An unverifiable table cannot say what this process identity now
			// names, so nothing is signalled: the durable launch marker is left
			// for the marker-matched cleanup path, which can prove ownership.
			if (table.kind === "unverifiable") throw new SpawnCleanupUnverifiedError()
			const observed = table.processes.find(
				(processIdentity) => processIdentity.pid === launchedPid,
			)
			if (observed !== undefined) {
				// The identity is live. Either this row proves it is the exact
				// process this launch created, or the identity has been reused and
				// signalling it would reach a process Warm Browser does not own.
				if (!isOwnedLaunch(observed, ownership)) throw new SpawnCleanupUnverifiedError()
				return observed
			}
			await pause(25)
		}
		// The launched identity never appeared within its bound. It is neither
		// proved live nor proved gone, so it is never signalled either.
		throw new SpawnCleanupUnverifiedError()
	},
	inspectProcess: (pid) => {
		const table = processTable()
		if (table.kind === "unverifiable") return { kind: "unverifiable" }
		const processIdentity = table.processes.find((candidate) => candidate.pid === pid)
		return processIdentity === undefined
			? { kind: "absent" }
			: { kind: "found", process: processIdentity }
	},
	verifyEndpoint: async ({ port, process: expected }) => {
		const table = processTable()
		if (table.kind === "unverifiable") return { kind: "process_unverifiable" }
		const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid)
		if (!isSameProcess(expected, observed)) return { kind: "browser_unverified" }
		return readEndpoint(port, expected)
	},
	terminateProcessGroup: async (expected, ownership) => {
		const table = processTable()
		if (table.kind === "unverifiable") return false
		const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid)
		if (!ownsProcess(expected, observed, ownership)) return false
		return terminateProcessGroupWithEscalation(expected, ownership)
	},
}
