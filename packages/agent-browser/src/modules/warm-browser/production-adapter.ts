import { randomUUID } from "node:crypto"
import { existsSync, lstatSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { SpawnCleanupUnverifiedError } from "./contract"
import type {
	BrowserProcessIdentity,
	EndpointVerification,
	ProcessListInspection,
	WarmBrowserAdapter,
} from "./contract"
import {
	connectLoopbackPort,
	hostPlatform,
	isExecutableFile,
	readLoopbackJson,
	readLoopbackListenerOwner,
	readProcessTable,
	signalProcessGroup,
	startDetachedProcess,
} from "./host-effects"
import { observeProcessTable } from "./process-table"

const installedChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

/**
 * The single owner of the launched Chrome argument list, including every
 * security-sensitive argument. Each argument appears exactly once.
 */
function chromeArgumentList(input: {
	readonly profileRoot: string
	readonly port: number
	readonly launchMarker: string
}): readonly string[] {
	return [
		`--user-data-dir=${input.profileRoot}`,
		"--profile-directory=Default",
		"--remote-debugging-address=127.0.0.1",
		`--remote-debugging-port=${input.port}`,
		`--agent-browser-launch-marker=${input.launchMarker}`,
		"--password-store=basic",
		"--use-mock-keychain",
		"--no-first-run",
		"--no-default-browser-check",
	]
}

function commandHasArgument(commandLine: string, argument: string): boolean {
	return ` ${commandLine} `.includes(` ${argument} `)
}

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

function sameProcess(
	expected: BrowserProcessIdentity,
	observed: BrowserProcessIdentity | undefined,
): boolean {
	return (
		observed !== undefined &&
		observed.pid === expected.pid &&
		observed.processGroupId === expected.processGroupId &&
		observed.startedAtToken === expected.startedAtToken &&
		observed.executable === expected.executable &&
		observed.commandLine === expected.commandLine
	)
}

function processTable(): ProcessListInspection {
	return observeProcessTable(readProcessTable(), installedChrome)
}

function processGroupExists(processGroupId: number): boolean {
	const outcome = signalProcessGroup(processGroupId, 0)
	return outcome === "delivered" || outcome === "denied"
}

async function pause(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function terminateProcessGroupWithEscalation(processGroupId: number): Promise<boolean> {
	const requested = signalProcessGroup(processGroupId, "SIGTERM")
	if (requested === "absent") return true
	if (requested !== "delivered") return false
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (!processGroupExists(processGroupId)) return true
		await pause(50)
	}
	const escalated = signalProcessGroup(processGroupId, "SIGKILL")
	if (escalated === "absent") return true
	if (escalated !== "delivered") return false
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (!processGroupExists(processGroupId)) return true
		await pause(50)
	}
	return false
}

async function readEndpoint(
	port: number,
	expected: BrowserProcessIdentity,
): Promise<EndpointVerification> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const table = processTable()
		if (table.kind === "unverifiable") return { kind: "process_unverifiable" }
		const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid)
		if (!sameProcess(expected, observed)) return { kind: "browser_unverified" }
		const owner = readLoopbackListenerOwner(port)
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
	spawnChrome: async ({ executable, profileRoot, port, launchMarker }) => {
		const pid = await startDetachedProcess(
			executable,
			chromeArgumentList({ profileRoot, port, launchMarker }),
		)
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const table = processTable()
			if (table.kind === "unverifiable") break
			const observed = table.processes.find((processIdentity) => processIdentity.pid === pid)
			if (observed !== undefined && observed.processGroupId === pid) return observed
			await pause(25)
		}
		if (!(await terminateProcessGroupWithEscalation(pid))) throw new SpawnCleanupUnverifiedError()
		throw new Error("Chrome process identity could not be read")
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
		if (!sameProcess(expected, observed)) return { kind: "browser_unverified" }
		return readEndpoint(port, expected)
	},
	terminateProcessGroup: async (expected) => {
		const table = processTable()
		if (table.kind === "unverifiable") return false
		const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid)
		if (!sameProcess(expected, observed) || expected.processGroupId !== expected.pid) return false
		return terminateProcessGroupWithEscalation(expected.processGroupId)
	},
}
