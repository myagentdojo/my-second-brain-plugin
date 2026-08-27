import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, lstatSync } from "node:fs"
import { createConnection } from "node:net"

import type { ListenerReading } from "./listener-table"
import type { ProcessTableReading } from "./process-table"

/**
 * Every raw host effect Warm Browser cannot own: the local process table, the
 * fixed installed application path, other processes, and loopback sockets.
 * Effects on paths a caller does own, such as the Agent Chrome Profile and the
 * private XDG state, stay in their owning code and run for real.
 *
 * This is the Module's internal seam. It carries no policy: no argument list,
 * no identity rule, no retry, no escalation, no vocabulary. Those stay in the
 * fixed production Adapter, so tests can substitute this module and still
 * exercise the production argument list, process observation, and lifecycle
 * decisions through the real CLI. The production Adapter is not replaceable and
 * takes no injected dependency.
 */

export type SignalOutcome = "delivered" | "absent" | "denied" | "failed"

export interface LoopbackJsonReading {
	readonly ok: boolean
	readonly body: unknown
}

/** Names the operating system Warm Browser is running on. */
export function hostPlatform(): string {
	return process.platform
}

/** Reads the local process table without interpreting its bytes. */
export function readProcessTable(): ProcessTableReading {
	const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,lstart=,command="], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	})
	return {
		status: result.status,
		signal: result.signal,
		failed: result.error !== undefined,
		stdout: typeof result.stdout === "string" ? result.stdout : null,
	}
}

/** Reports whether one path is a regular, non-symlink, executable file. */
export function isExecutableFile(path: string): boolean {
	try {
		const metadata = lstatSync(path)
		if (!metadata.isFile() || metadata.isSymbolicLink()) return false
		accessSync(path, constants.X_OK)
		return true
	} catch {
		return false
	}
}

/**
 * Starts one detached process leader and answers with its process id. The
 * caller owns every later decision about that process; this only launches it.
 */
export async function startDetachedProcess(
	executable: string,
	argumentList: readonly string[],
): Promise<number> {
	const child = spawn(executable, [...argumentList], { detached: true, stdio: "ignore" })
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject)
		child.once("spawn", resolve)
	})
	if (child.pid === undefined) throw new Error("the launched process returned no process identity")
	child.unref()
	return child.pid
}

/** Delivers one signal to a whole process group and classifies the outcome. */
export function signalProcessGroup(
	processGroupId: number,
	signal: 0 | "SIGTERM" | "SIGKILL",
): SignalOutcome {
	if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) return "failed"
	try {
		process.kill(-processGroupId, signal)
		return "delivered"
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ESRCH") return "absent"
		if (code === "EPERM") return "denied"
		return "failed"
	}
}

/** Probes one loopback TCP port without speaking any protocol on it. */
export async function connectLoopbackPort(
	port: number,
): Promise<"free" | "occupied" | "unverifiable"> {
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

/** Reads the listeners on one loopback port without interpreting its bytes. */
export function readLoopbackListener(port: number): ListenerReading {
	const result = spawnSync(
		"/usr/sbin/lsof",
		["-nP", "-a", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-Fp"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	)
	return {
		status: result.status,
		signal: result.signal,
		failed: result.error !== undefined,
		stdout: typeof result.stdout === "string" ? result.stdout : null,
	}
}

/** Reads one bounded JSON document from a loopback URL. */
export async function readLoopbackJson(url: string): Promise<LoopbackJsonReading> {
	const response = await fetch(url, { signal: AbortSignal.timeout(500) })
	return { ok: response.ok, body: await response.json() }
}
