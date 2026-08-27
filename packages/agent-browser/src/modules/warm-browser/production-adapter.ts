import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, constants, existsSync, lstatSync } from "node:fs"
import { createConnection } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

import { SpawnCleanupUnverifiedError } from "./contract"
import type {
	BrowserProcessIdentity,
	EndpointVerification,
	ProcessListInspection,
	WarmBrowserAdapter,
} from "./contract"

const installedChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

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

function processTable(): ProcessListInspection {
	const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,lstart=,command="], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	})
	if (result.status !== 0) return { kind: "unverifiable" }
	const rows: BrowserProcessIdentity[] = []
	for (const line of result.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+)$/.exec(line)
		if (!match) continue
		const pid = Number(match[1])
		const processGroupId = Number(match[2])
		const commandLine = match[4]!
		const executable = commandLine.startsWith(installedChrome)
			? installedChrome
			: commandLine.split(" ")[0]!
		rows.push({ pid, processGroupId, startedAtToken: match[3]!, executable, commandLine })
	}
	return { kind: "verified", processes: rows }
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

function processGroupExists(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

async function pause(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function terminateProcessGroupWithEscalation(processGroupId: number): Promise<boolean> {
	try {
		process.kill(-processGroupId, "SIGTERM")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
		return false
	}
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (!processGroupExists(processGroupId)) return true
		await pause(50)
	}
	try {
		process.kill(-processGroupId, "SIGKILL")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
		return false
	}
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (!processGroupExists(processGroupId)) return true
		await pause(50)
	}
	return false
}

function listenerOwner(port: number): "absent" | "unverifiable" | number {
	const result = spawnSync(
		"/usr/sbin/lsof",
		["-nP", "-a", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-Fp"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	)
	if (result.status === 1 && result.stdout.trim() === "") return "absent"
	if (result.status !== 0) return "unverifiable"
	const owners = [
		...new Set(
			result.stdout
				.split("\n")
				.filter((line) => /^p[0-9]+$/.test(line))
				.map((line) => Number(line.slice(1))),
		),
	]
	return owners.length === 1 ? owners[0]! : "unverifiable"
}

async function inspectLoopbackPort(port: number): Promise<"free" | "occupied" | "unverifiable"> {
	return await new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port })
		let settled = false
		const finish = (result: "free" | "occupied" | "unverifiable") => {
			if (settled) return
			settled = true
			socket.destroy()
			resolve(result)
		}
		socket.once("connect", () => finish("occupied"))
		socket.once(
			"error",
			(error: NodeJS.ErrnoException) =>
				finish(error.code === "ECONNREFUSED" ? "free" : "unverifiable"),
		)
		socket.setTimeout(300, () => finish("unverifiable"))
	})
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
		const owner = listenerOwner(port)
		if (owner === "unverifiable" || (owner !== "absent" && owner !== expected.pid)) {
			return { kind: "listener_unverified" }
		}
		if (owner === "absent") {
			if (attempt === 39) return { kind: "listener_unverified" }
			await pause(100)
			continue
		}
		try {
			const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, {
				signal: AbortSignal.timeout(500),
			})
			const version = (await versionResponse.json()) as {
				Browser?: unknown
				webSocketDebuggerUrl?: unknown
			}
			if (
				!versionResponse.ok ||
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
			const targetsResponse = await fetch(`http://127.0.0.1:${port}/json/list`, {
				signal: AbortSignal.timeout(500),
			})
			const targets = (await targetsResponse.json()) as Array<{ id?: unknown; type?: unknown }>
			if (!targetsResponse.ok || !Array.isArray(targets)) return { kind: "browser_unverified" }
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

export const productionAdapter: WarmBrowserAdapter = {
	createRunId: () => `wb-${randomUUID()}`,
	createSessionId: () => `session-${randomUUID()}`,
	nowEpochMs: () => Date.now(),
	platform: () => process.platform,
	chromeExecutable: () => installedChrome,
	inspectChrome: (executable) => {
		try {
			const metadata = lstatSync(executable)
			if (!metadata.isFile() || metadata.isSymbolicLink()) return "unavailable"
			accessSync(executable, constants.X_OK)
			return "installed"
		} catch {
			return "unavailable"
		}
	},
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
	inspectPort: inspectLoopbackPort,
	spawnChrome: async ({ executable, profileRoot, port, launchMarker }) => {
		const child = spawn(
			executable,
			[
				`--user-data-dir=${profileRoot}`,
				"--profile-directory=Default",
				"--remote-debugging-address=127.0.0.1",
				`--remote-debugging-port=${port}`,
				`--agent-browser-launch-marker=${launchMarker}`,
				"--password-store=basic",
				"--use-mock-keychain",
				"--no-first-run",
				"--no-default-browser-check",
			],
			{ detached: true, stdio: "ignore" },
		)
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject)
			child.once("spawn", resolve)
		})
		if (child.pid === undefined) throw new Error("Chrome returned no process identity")
		child.unref()
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const table = processTable()
			if (table.kind === "unverifiable") break
			const observed = table.processes.find((processIdentity) => processIdentity.pid === child.pid)
			if (observed !== undefined && observed.processGroupId === child.pid) return observed
			await pause(25)
		}
		if (!(await terminateProcessGroupWithEscalation(child.pid))) {
			throw new SpawnCleanupUnverifiedError()
		}
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
