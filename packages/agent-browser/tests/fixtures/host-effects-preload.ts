import { mock } from "bun:test"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { SignalOutcome } from "../../src/modules/warm-browser/host-effects"
import type { ProcessTableReading } from "../../src/modules/warm-browser/process-table"

/**
 * The single private test-owned substitute for the Warm Browser Module's
 * `host-effects` seam. Preloading this file replaces every raw host effect and
 * leaves the rest of the production CLI real: the production Adapter is still
 * one fixed value, the production argument list is still built by production
 * code, and the process table is still interpreted by the production parser.
 *
 * It launches nothing, signals nothing, and speaks to no network service.
 */

const root = process.env.WARM_BROWSER_FIXTURE_ROOT
if (!root) throw new Error("WARM_BROWSER_FIXTURE_ROOT is required by the private host-effects fake")
const planPath = join(root, "host-effects.json")
const spawnedPath = join(root, "spawned.json")
const actionsPath = join(root, "actions.jsonl")

interface LoopbackDocument {
	readonly ok: boolean
	readonly body: unknown
}

interface HostEffectsPlan {
	readonly platform?: string
	/** The literal `ps` reading the production parser must interpret. */
	readonly processTable?: ProcessTableReading
	readonly executableInstalled?: boolean
	readonly spawnOutcome?: "leader" | "missing_executable"
	readonly spawnedPid?: number
	readonly spawnedStartedAtToken?: string
	readonly signalOutcome?: SignalOutcome
	readonly portStatus?: "free" | "occupied" | "unverifiable"
	readonly listenerOwner?: number | "absent" | "unverifiable" | "spawned"
	/** Loopback JSON documents keyed by URL pathname. */
	readonly loopbackJson?: Record<string, LoopbackDocument>
}

interface SpawnedLeader {
	readonly pid: number
	readonly startedAtToken: string
	readonly commandLine: string
}

function plan(): HostEffectsPlan {
	return existsSync(planPath) ? JSON.parse(readFileSync(planPath, "utf8")) : {}
}

function spawnedLeaders(): SpawnedLeader[] {
	return existsSync(spawnedPath) ? JSON.parse(readFileSync(spawnedPath, "utf8")) : []
}

function action(value: Record<string, unknown>): void {
	appendFileSync(actionsPath, `${JSON.stringify(value)}\n`)
}

function row(leader: SpawnedLeader): string {
	const identity = String(leader.pid).padStart(5)
	return `${identity} ${identity} ${leader.startedAtToken} ${leader.commandLine}\n`
}

const fake: typeof import("../../src/modules/warm-browser/host-effects") = {
	hostPlatform: () => plan().platform ?? "darwin",
	readProcessTable: () => {
		const reading = plan().processTable
		if (reading === undefined) return { status: 1, signal: null, failed: false, stdout: "" }
		if (typeof reading.stdout !== "string") return reading
		const live = spawnedLeaders().map(row).join("")
		return { ...reading, stdout: `${reading.stdout}${live}` }
	},
	isExecutableFile: () => plan().executableInstalled !== false,
	startDetachedProcess: async (executable, argumentList) => {
		action({ action: "spawn", executable, argumentList: [...argumentList] })
		const current = plan()
		if (current.spawnOutcome === "missing_executable") {
			// One real failed launch of a path this fixture owns, so the redaction
			// contract meets a genuine host error and no process is ever created.
			const attempt = spawnSync(join(root, "missing-chrome"), [], { stdio: "ignore" })
			throw attempt.error ?? new Error("the fake expected a missing executable")
		}
		const leader: SpawnedLeader = {
			pid: current.spawnedPid ?? 4242,
			startedAtToken: current.spawnedStartedAtToken ?? "Thu Aug 27 09:52:01 2026",
			commandLine: [executable, ...argumentList].join(" "),
		}
		writeFileSync(spawnedPath, `${JSON.stringify([...spawnedLeaders(), leader], null, 2)}\n`)
		return leader.pid
	},
	signalProcessGroup: (processGroupId, signal) => {
		action({ action: "signal", processGroupId, signal })
		return plan().signalOutcome ?? "absent"
	},
	connectLoopbackPort: async (port) => {
		action({ action: "port", port })
		return plan().portStatus ?? "free"
	},
	readLoopbackListenerOwner: (port) => {
		action({ action: "listener", port })
		const owner = plan().listenerOwner ?? "unverifiable"
		if (owner !== "spawned") return owner
		const leaders = spawnedLeaders()
		return leaders.at(-1)?.pid ?? "absent"
	},
	readLoopbackJson: async (url) => {
		action({ action: "http", url })
		const document = plan().loopbackJson?.[new URL(url).pathname]
		if (document === undefined) throw new Error("the private host-effects fake serves no document")
		return document
	},
}

const seam = fileURLToPath(
	new URL("../../src/modules/warm-browser/host-effects.ts", import.meta.url),
)

mock.module(seam, () => fake)
