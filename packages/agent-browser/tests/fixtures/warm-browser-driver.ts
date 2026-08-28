import { mock } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { WarmBrowserAdapter } from "../../src/modules/warm-browser/adapter"
import { SpawnCleanupUnverifiedError } from "../../src/modules/warm-browser/contract"
import type {
	BrowserProcessIdentity,
	EndpointVerification,
} from "../../src/modules/warm-browser/contract"

interface FixturePlan {
	readonly platform?: string
	readonly nowEpochMs?: number
	readonly chromeStatus?: "installed" | "unavailable"
	readonly profileStatus?: "safe" | "unsafe"
	readonly profileProcessCount?: number
	readonly processInspectionUnverifiable?: boolean
	readonly profileProcessInspectionUnverifiable?: boolean
	readonly launchProcessInspectionUnverifiable?: boolean
	readonly launchProcessCountOverride?: number
	readonly launchProcessSecondQueryCount?: number
	readonly portStatus?: "free" | "occupied" | "unverifiable"
	readonly endpointKind?: EndpointVerification["kind"]
	readonly verifyThrows?: boolean
	readonly holdVerificationUntil?: string
	readonly holdSpawnReturnUntil?: string
	readonly crashBeforeVerify?: boolean
	readonly spawnThrows?: boolean
	readonly postSpawnIdentityReadFailure?: boolean
	readonly postSpawnCleanupUnverified?: boolean
	readonly terminateFails?: boolean
}

interface LedgerProcess extends BrowserProcessIdentity {
	alive: boolean
}

interface Ledger {
	spawnCount: number
	processes: LedgerProcess[]
}

const fixtureRoot = process.env.WARM_BROWSER_FIXTURE_ROOT
if (!fixtureRoot) {
	throw new Error("WARM_BROWSER_FIXTURE_ROOT is required by the private test driver")
}
mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 })
const planPath = join(fixtureRoot, "plan.json")
const ledgerPath = join(fixtureRoot, "processes.json")
const actionsPath = join(fixtureRoot, "actions.jsonl")
let launchInspectionCount = 0

function plan(): FixturePlan {
	return existsSync(planPath) ? JSON.parse(readFileSync(planPath, "utf8")) : {}
}

function ledger(): Ledger {
	return existsSync(ledgerPath)
		? JSON.parse(readFileSync(ledgerPath, "utf8"))
		: { spawnCount: 0, processes: [] }
}

function writeLedger(value: Ledger): void {
	writeFileSync(ledgerPath, `${JSON.stringify(value, null, 2)}\n`)
}

function action(value: Record<string, unknown>): void {
	appendFileSync(actionsPath, `${JSON.stringify(value)}\n`)
}

function fakeProcess(
	pid: number,
	executable: string,
	profileRoot: string,
	port: number,
	launchMarker = "foreign-marker",
): LedgerProcess {
	return {
		pid,
		processGroupId: pid,
		startedAtToken: `fixture-start-${pid}`,
		executable,
		commandLine:
			`${executable} --user-data-dir=${profileRoot} --profile-directory=Default --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} --agent-browser-launch-marker=${launchMarker}`,
		alive: true,
	}
}

async function waitFor(path: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (existsSync(path)) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("private fixture barrier timed out")
}

const adapter: WarmBrowserAdapter = {
	createRunId: () => "fixture-generated-run",
	createSessionId: () => `session-${ledger().spawnCount + 1}`,
	createSnapshotId: () => "snapshot-fixture",
	createScreenshotId: () => "screenshot-fixture",
	nowEpochMs: () => plan().nowEpochMs ?? 1_800_000_000_000,
	platform: () => plan().platform ?? "darwin",
	chromeExecutable: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	inspectChrome: () => plan().chromeStatus ?? "installed",
	profileRoot: () => join(fixtureRoot, ".agent-warm-profile"),
	inspectProfile: () => plan().profileStatus ?? "safe",
	findProfileProcesses: (profileRoot) =>
		plan().profileProcessInspectionUnverifiable ? { kind: "unverifiable" } : {
			kind: "verified",
			processes: Array.from({ length: plan().profileProcessCount ?? 0 }, (_, index) =>
				fakeProcess(
					8_000 + index,
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					profileRoot,
					9242,
				)),
		},
	findLaunchProcesses: (launchMarker) => {
		launchInspectionCount += 1
		if (plan().launchProcessInspectionUnverifiable) return { kind: "unverifiable" }
		const matching = ledger().processes.filter(
			(processIdentity) =>
				processIdentity.alive &&
				processIdentity.commandLine.includes(`--agent-browser-launch-marker=${launchMarker}`),
		)
		const count = launchInspectionCount > 1
			? (plan().launchProcessSecondQueryCount ?? plan().launchProcessCountOverride)
			: plan().launchProcessCountOverride
		return {
			kind: "verified",
			processes: count === undefined
				? matching
				: Array.from({ length: count }, (_, index) =>
					matching[index] ??
						fakeProcess(
							9_000 + index,
							"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
							join(fixtureRoot, ".agent-warm-profile"),
							9242,
							launchMarker,
						)),
		}
	},
	inspectPort: async () => plan().portStatus ?? "free",
	spawnChrome: async ({ argumentList, ownership }) => {
		if (plan().spawnThrows) throw new Error("fixture spawn failure")
		const current = ledger()
		current.spawnCount += 1
		// The launched process carries exactly what the Module bound durably, so
		// the fixture cannot fabricate a command line production would not launch.
		const pid = 4_100 + current.spawnCount
		const spawned: LedgerProcess = {
			pid,
			processGroupId: pid,
			startedAtToken: `fixture-start-${pid}`,
			executable: ownership.executable,
			commandLine: ownership.commandLine,
			alive: true,
		}
		current.processes.push(spawned)
		writeLedger(current)
		// The recorded port is read back out of the argument list the Module
		// actually launched with, never restated by the fixture.
		const portArgument = "--remote-debugging-port="
		const port = Number(
			argumentList.find((value) => value.startsWith(portArgument))?.slice(portArgument.length),
		)
		action({ action: "spawn", pid: spawned.pid, processGroupId: spawned.processGroupId, port })
		if (plan().holdSpawnReturnUntil) await waitFor(plan().holdSpawnReturnUntil!)
		if (plan().postSpawnIdentityReadFailure) {
			if (plan().postSpawnCleanupUnverified) throw new SpawnCleanupUnverifiedError()
			spawned.alive = false
			writeLedger(current)
			action({ action: "terminate", pid: spawned.pid, processGroupId: spawned.processGroupId })
			throw new Error("fixture post-spawn identity read failure")
		}
		return spawned
	},
	inspectProcess: (pid) => {
		if (plan().processInspectionUnverifiable) return { kind: "unverifiable" }
		const observed = ledger().processes.find((processIdentity) => processIdentity.pid === pid)
		return observed?.alive ? { kind: "found", process: observed } : { kind: "absent" }
	},
	verifyEndpoint: async ({ port, process: expected }) => {
		const currentPlan = plan()
		if (currentPlan.holdVerificationUntil) await waitFor(currentPlan.holdVerificationUntil)
		if (currentPlan.verifyThrows) throw new Error("fixture verification failure")
		if (currentPlan.crashBeforeVerify) {
			const current = ledger()
			const observed = current.processes.find((processIdentity) =>
				processIdentity.pid === expected.pid
			)
			if (observed) observed.alive = false
			writeLedger(current)
		}
		action({ action: "verify", pid: expected.pid, port })
		const kind = currentPlan.endpointKind ?? "verified"
		return kind === "verified"
			? {
				kind,
				endpoint: {
					browserVersion: "Chrome/151.0.7922.174",
					controlledPageTargetId: "page-1",
				},
			}
			: { kind }
	},
	terminateProcessGroup: async (expected) => {
		const current = ledger()
		const observed = current.processes.find((processIdentity) =>
			processIdentity.pid === expected.pid
		)
		if (plan().terminateFails || observed === undefined) return false
		const matches = observed.processGroupId === expected.processGroupId &&
			observed.startedAtToken === expected.startedAtToken &&
			observed.executable === expected.executable &&
			observed.commandLine === expected.commandLine
		if (!matches) return false
		observed.alive = false
		writeLedger(current)
		action({ action: "terminate", pid: observed.pid, processGroupId: observed.processGroupId })
		return true
	},
}

/**
 * Substitutes the Module's private Adapter seam and nothing else. Preloading
 * this file leaves the production entry, argument parser, result vocabulary,
 * and every lifecycle rule real; the production entry still binds the Adapter
 * itself, so no injection surface exists for a caller to reach.
 */
const seam = fileURLToPath(
	new URL("../../src/modules/warm-browser/production-adapter.ts", import.meta.url),
)

mock.module(seam, () => ({ productionAdapter: adapter }))
