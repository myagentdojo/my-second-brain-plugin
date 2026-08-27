import { mock } from "bun:test"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { SignalOutcome } from "../../src/modules/warm-browser/host-effects"
import type { ListenerReading } from "../../src/modules/warm-browser/listener-table"
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
	/**
	 * The literal `ps` reading served once this launch has spawned a leader,
	 * exactly as given and with no rendered leader row appended. It models a
	 * table that answers differently after the process exists, so a clear
	 * preflight reading can be followed by an unverifiable or non-exact one.
	 */
	readonly processTableAfterSpawn?: ProcessTableReading
	/**
	 * The literal `ps` reading served once any signal has been delivered. This is
	 * the real window between requesting a stop and escalating it, in which a
	 * process identity can exit and its number be reused.
	 */
	readonly processTableAfterSignal?: ProcessTableReading
	readonly executableInstalled?: boolean
	readonly spawnOutcome?: "leader" | "missing_executable"
	readonly spawnedPid?: number
	/** A process group other than the launched identity's own, when named. */
	readonly spawnedProcessGroupId?: number
	readonly spawnedStartedAtToken?: string
	readonly signalOutcome?: SignalOutcome
	/**
	 * Signal outcomes keyed by the exact signal, so one request and its later
	 * liveness probe can be scripted apart. Falls back to `signalOutcome`.
	 */
	readonly signalOutcomes?: Record<string, SignalOutcome>
	readonly portStatus?: "free" | "occupied" | "unverifiable"
	/** The literal `lsof` reading the production observer must interpret. */
	readonly listener?: ListenerReading
	readonly listenerOwner?: number | "absent" | "unverifiable" | "spawned"
	/** Loopback JSON documents keyed by URL pathname. */
	readonly loopbackJson?: Record<string, LoopbackDocument>
}

interface SpawnedLeader {
	readonly pid: number
	readonly processGroupId: number
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

let signalsDelivered = 0

function row(leader: SpawnedLeader): string {
	const identity = String(leader.pid).padStart(5)
	const group = String(leader.processGroupId).padStart(5)
	return `${identity} ${group} ${leader.startedAtToken} ${leader.commandLine}\n`
}

const fake: typeof import("../../src/modules/warm-browser/host-effects") = {
	hostPlatform: () => plan().platform ?? "darwin",
	readProcessTable: () => {
		const current = plan()
		const leaders = spawnedLeaders()
		if (signalsDelivered > 0 && current.processTableAfterSignal !== undefined) {
			return current.processTableAfterSignal
		}
		if (leaders.length > 0 && current.processTableAfterSpawn !== undefined) {
			return current.processTableAfterSpawn
		}
		const reading = current.processTable
		if (reading === undefined) return { status: 1, signal: null, failed: false, stdout: "" }
		if (typeof reading.stdout !== "string") return reading
		return { ...reading, stdout: `${reading.stdout}${leaders.map(row).join("")}` }
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
		const pid = current.spawnedPid ?? 4242
		const leader: SpawnedLeader = {
			pid,
			processGroupId: current.spawnedProcessGroupId ?? pid,
			startedAtToken: current.spawnedStartedAtToken ?? "Thu Aug 27 09:52:01 2026",
			commandLine: [executable, ...argumentList].join(" "),
		}
		writeFileSync(spawnedPath, `${JSON.stringify([...spawnedLeaders(), leader], null, 2)}\n`)
		return leader.pid
	},
	signalProcessGroup: (processGroupId, signal) => {
		action({ action: "signal", processGroupId, signal })
		if (signal !== 0) signalsDelivered += 1
		const current = plan()
		return current.signalOutcomes?.[String(signal)] ?? current.signalOutcome ?? "absent"
	},
	connectLoopbackPort: async (port) => {
		action({ action: "port", port })
		return plan().portStatus ?? "free"
	},
	readLoopbackListener: (port) => {
		action({ action: "listener", port })
		const current = plan()
		if (current.listener !== undefined) return current.listener
		// The ergonomic plan names an owner; the fake renders the canonical
		// `lsof -Fp` bytes for it, so the production observer still does the
		// interpreting. A raw `listener` reading bypasses this renderer.
		const owner = current.listenerOwner ?? "unverifiable"
		const pid = owner === "spawned" ? spawnedLeaders().at(-1)?.pid ?? "absent" : owner
		if (pid === "unverifiable") return { status: 2, signal: null, failed: false, stdout: "" }
		if (pid === "absent") return { status: 1, signal: null, failed: false, stdout: "" }
		return { status: 0, signal: null, failed: false, stdout: `p${pid}\n` }
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
