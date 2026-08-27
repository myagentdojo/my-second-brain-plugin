import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as productionAdapterModule from "../src/modules/warm-browser/production-adapter"
import {
	hostEffects,
	installedChrome,
	packageRoot,
	preloadEntry,
	processRow,
	type ProductionCliProbe,
	productionCliProbe,
	removeProductionCliProbes,
	productionEntry,
	runProductionCli,
	systemRows,
	verifiedReading,
	writeHostEffectsPlan,
} from "./fixtures/production-cli-harness"

afterEach(removeProductionCliProbes)

/**
 * Independent oracles for the launch contract. Every value is restated here so
 * no production table, catalog, or builder supplies its own expectation.
 */
const alwaysOnceByPrefix = [
	"--user-data-dir=",
	"--remote-debugging-port=",
	"--agent-browser-launch-marker=",
] as const

const healthyEndpoint = {
	"/json/version": {
		ok: true,
		body: {
			Browser: "Chrome/151.0.7922.174",
			webSocketDebuggerUrl: "ws://127.0.0.1:9242/devtools/browser/probe",
		},
	},
	"/json/list": { ok: true, body: [{ id: "page-1", type: "page" }] },
} as const

/**
 * Independent oracle: one termination request followed by exactly one liveness
 * probe. A third entry would mean Warm Browser escalated onto a process group
 * whose liveness it had not observed.
 */
function expectRequestedThenProbed(probe: ProductionCliProbe): void {
	expect(hostEffects(probe).filter(({ action }) => action === "signal")).toEqual([
		{ action: "signal", processGroupId: 4242, signal: "SIGTERM" },
		{ action: "signal", processGroupId: 4242, signal: 0 },
	])
}

/**
 * Independent oracle: the refusal a launch must emit when it cannot prove what
 * its own process identity names. Restated here so no production table, catalog,
 * or builder supplies its own expectation.
 */
function expectLaunchCleanupUnverified(
	result: Bun.ReadableSyncSubprocess,
	runId: string,
): void {
	expect(result.exitCode).toBe(1)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		`${
			JSON.stringify({
				schemaVersion: 1,
				status: "error",
				command: "start",
				resultCode: "UNEXPECTED_FAILURE",
				runId,
				transactionState: "unchanged",
				retrySafe: false,
				nextAction: "Inspect the durable launch intent and marker-matched processes before retrying.",
				message: "Warm Browser could not verify cleanup of its launched browser process group.",
			})
		}\n`,
	)
}

/**
 * The durable launch marker survives exactly as first written, and no process
 * group was signalled. The whole recorded effect list is pinned: one port probe
 * and one spawn, so a third entry would mean the launch signalled an identity it
 * had not proved.
 */
function expectLaunchMarkerRetainedUnsignalled(probe: ProductionCliProbe, runId: string): void {
	const receipt = JSON.parse(readFileSync(probe.sessionPath, "utf8")) as Record<string, unknown>
	expect(receipt).toEqual({
		schemaVersion: 1,
		phase: "launching",
		sessionId: receipt.sessionId,
		startRunId: runId,
		launchMarker: receipt.sessionId,
		createdAtEpochMs: receipt.createdAtEpochMs,
		profileRoot: probe.profileRoot,
		launch: {
			executable: installedChrome,
			commandLine: [
				installedChrome,
				`--user-data-dir=${probe.profileRoot}`,
				"--profile-directory=Default",
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=9242",
				`--agent-browser-launch-marker=${receipt.sessionId as string}`,
				"--password-store=basic",
				"--use-mock-keychain",
				"--no-first-run",
				"--no-default-browser-check",
			].join(" "),
		},
		endpoint: { host: "127.0.0.1", port: 9242 },
	})
	expect(statSync(probe.sessionPath).mode & 0o7777).toBe(0o600)
	expect(existsSync(probe.lockPath)).toBe(true)
	expect(hostEffects(probe).map(({ action }) => action)).toEqual(["port", "spawn"])
}

function launchPlan(): Record<string, unknown> {
	return {
		processTable: verifiedReading(systemRows),
		spawnOutcome: "leader",
		spawnedPid: 4242,
		listenerOwner: "spawned",
		loopbackJson: healthyEndpoint,
	}
}

test("the production Adapter is one fixed value with no injection surface", () => {
	expect(Object.keys(productionAdapterModule)).toEqual(["productionAdapter"])
	expect(typeof productionAdapterModule.productionAdapter).toBe("object")
})

test("the production launch carries each security-sensitive argument exactly once", () => {
	const probe = productionCliProbe(launchPlan())

	const started = runProductionCli(probe, ["start", "--run-id", "launch-argv"])

	expect(started.stderr.toString()).toBe("")
	expect(started.exitCode).toBe(0)
	const intent = JSON.parse(readFileSync(probe.sessionPath, "utf8")) as {
		launchMarker: string
		sessionId: string
		endpoint: { port: number }
	}
	const spawn = hostEffects(probe).find(({ action }) => action === "spawn") as {
		executable: string
		argumentList: string[]
	}

	expect(spawn.executable).toBe(installedChrome)
	expect(spawn.argumentList).toEqual([
		`--user-data-dir=${probe.profileRoot}`,
		"--profile-directory=Default",
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=9242",
		`--agent-browser-launch-marker=${intent.launchMarker}`,
		"--password-store=basic",
		"--use-mock-keychain",
		"--no-first-run",
		"--no-default-browser-check",
	])
	// No argument is repeated, so every argument above occurs exactly once.
	for (const argument of spawn.argumentList) {
		expect(spawn.argumentList.filter((value) => value === argument), argument).toHaveLength(1)
	}
	// The two arguments that decide credential exposure, named on purpose.
	expect(spawn.argumentList.filter((value) => value === "--password-store=basic")).toHaveLength(1)
	expect(spawn.argumentList.filter((value) => value === "--use-mock-keychain")).toHaveLength(1)
	// No second value may reach one single-valued argument.
	for (const prefix of alwaysOnceByPrefix) {
		expect(spawn.argumentList.filter((value) => value.startsWith(prefix)), prefix).toHaveLength(1)
	}
	expect(intent.launchMarker).toBe(intent.sessionId)
	expect(intent.endpoint.port).toBe(9242)
})

test("one port override reaches the launch argument list without a durable preference", () => {
	const probe = productionCliProbe({ ...launchPlan(), listenerOwner: 4243 })

	const started = runProductionCli(probe, ["start", "--port", "9333", "--run-id", "launch-port"])

	// A foreign listener refuses the endpoint, so the overridden launch rolls
	// back; the recorded argument list is still the production one.
	expect(JSON.parse(started.stderr.toString())).toMatchObject({
		resultCode: "CDP_IDENTITY_UNVERIFIED",
		transactionState: "rolled_back",
	})
	const spawn = hostEffects(probe).find(({ action }) => action === "spawn") as {
		argumentList: string[]
	}
	expect(spawn.argumentList).toContain("--remote-debugging-port=9333")
	expect(spawn.argumentList.filter((value) => value.startsWith("--remote-debugging-port="))).toEqual(
		["--remote-debugging-port=9333"],
	)
	expect(existsSync(probe.sessionPath)).toBe(false)
	expect(existsSync(probe.lockPath)).toBe(false)
})

test("the production CLI starts, verifies, and stops one owned group through real effects", () => {
	const probe = productionCliProbe(launchPlan())

	const started = runProductionCli(probe, ["start", "--run-id", "production-start"])
	expect(started.stderr.toString()).toBe("")
	expect(JSON.parse(started.stdout.toString())).toMatchObject({
		schemaVersion: 1,
		status: "ok",
		command: "start",
		resultCode: "SESSION_STARTED",
		runId: "production-start",
		transactionState: "started",
		retrySafe: false,
		data: {
			processId: 4242,
			endpoint: { host: "127.0.0.1", port: 9242 },
			controlledPage: { targetId: "page-1" },
			postcondition: "running",
			recoveredFrom: null,
		},
	})
	// The trailing listener read is the settle check: the endpoint is only
	// answered about a process and a listener still owned at that moment.
	expect(hostEffects(probe).map(({ action }) => action)).toEqual([
		"port",
		"spawn",
		"listener",
		"http",
		"http",
		"listener",
	])

	const stopped = runProductionCli(probe, ["stop", "--run-id", "production-stop"])
	expect(stopped.stderr.toString()).toBe("")
	expect(JSON.parse(stopped.stdout.toString())).toMatchObject({
		command: "stop",
		resultCode: "SESSION_STOPPED",
		transactionState: "stopped",
		retrySafe: true,
		data: { stoppedProcessId: 4242, postcondition: "absent" },
	})
	expect(hostEffects(probe).at(-1)).toEqual({
		action: "signal",
		processGroupId: 4242,
		signal: "SIGTERM",
	})
	expect(existsSync(probe.sessionPath)).toBe(false)
	expect(existsSync(probe.lockPath)).toBe(false)
})

test("the production missing-executable launch emits one redacted JSON line without a stack", () => {
	const probe = productionCliProbe({
		processTable: verifiedReading(systemRows),
		spawnOutcome: "missing_executable",
	})

	const result = runProductionCli(probe, ["start", "--run-id", "missing-child"])

	expect(result.exitCode).toBe(1)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		`${
			JSON.stringify({
				schemaVersion: 1,
				status: "error",
				command: "start",
				resultCode: "UNEXPECTED_FAILURE",
				runId: "missing-child",
				transactionState: "rolled_back",
				retrySafe: false,
				nextAction: "Inspect private state and the owned process group before retrying.",
				message: "Warm Browser start failed unexpectedly.",
			})
		}\n`,
	)
	expect(result.stderr.toString().trim().split("\n")).toHaveLength(1)
	expect(result.stderr.toString()).not.toContain("ENOENT")
	expect(existsSync(probe.lockPath)).toBe(false)
	expect(hostEffects(probe).filter(({ action }) => action === "signal")).toEqual([])
})

test("a delivered SIGTERM whose liveness probe proves absence stops without escalating", () => {
	const probe = productionCliProbe(launchPlan())
	expect(runProductionCli(probe, ["start", "--run-id", "probed-start"]).exitCode).toBe(0)
	writeHostEffectsPlan(probe, {
		...launchPlan(),
		signalOutcomes: { SIGTERM: "delivered", "0": "absent" },
	})

	const result = runProductionCli(probe, ["stop", "--run-id", "probed-stop"])

	expect(result.stderr.toString()).toBe("")
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		command: "stop",
		resultCode: "SESSION_STOPPED",
		transactionState: "stopped",
		data: { stoppedProcessId: 4242, postcondition: "absent" },
	})
	expect(existsSync(probe.sessionPath)).toBe(false)
	expectRequestedThenProbed(probe)
})

test("a delivered SIGTERM whose liveness probe fails never reports the owned group stopped", () => {
	const probe = productionCliProbe(launchPlan())
	expect(runProductionCli(probe, ["start", "--run-id", "probe-failed-start"]).exitCode).toBe(0)
	const stateBefore = readFileSync(probe.sessionPath, "utf8")
	// The request is delivered, then the group's liveness cannot be observed at
	// all. An uncertain probe is not proof the group is gone.
	writeHostEffectsPlan(probe, {
		...launchPlan(),
		signalOutcomes: { SIGTERM: "delivered", "0": "failed" },
	})

	const result = runProductionCli(probe, ["stop", "--run-id", "probe-failed-stop"])

	expect(result.exitCode).toBe(1)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		`${
			JSON.stringify({
				schemaVersion: 1,
				status: "error",
				command: "stop",
				resultCode: "UNEXPECTED_FAILURE",
				runId: "probe-failed-stop",
				transactionState: "unchanged",
				retrySafe: false,
				nextAction: "Inspect the owned process group and private state before retrying.",
				message: "Warm Browser could not stop its verified browser process group.",
			})
		}\n`,
	)
	// Durable ownership survives, so the unstoppable group stays inspectable.
	expect(readFileSync(probe.sessionPath, "utf8")).toBe(stateBefore)
	expect(existsSync(probe.lockPath)).toBe(true)
	expectRequestedThenProbed(probe)
})

/**
 * Independent oracle: `lsof -Fp` readings whose bytes cannot prove exactly one
 * loopback owner. Each names the expected owner so a reading that hides a
 * second owner behind an unparsed line cannot pass as a single proved one.
 */
const unsafeListenerReadings = [
	["a malformed line beside the expected owner", "p4242\nlsof: WARNING: unreadable\n"],
	["a second distinct owner", "p4242\np4243\n"],
	["a leading-zero process identity", "p04242\n"],
	["a zero process identity", "p0\n"],
	["output truncated before its final newline", "p4242"],
] as const

test.each(unsafeListenerReadings)(
	"the launched CDP endpoint stays unverified when the listener reading shows %s",
	(_name, stdout) => {
		const probe = productionCliProbe({
			...launchPlan(),
			listener: { status: 0, signal: null, failed: false, stdout },
		})

		const result = runProductionCli(probe, ["start", "--run-id", "listener-unsafe"])

		expect(result.exitCode).toBe(20)
		expect(JSON.parse(result.stderr.toString())).toMatchObject({
			resultCode: "CDP_IDENTITY_UNVERIFIED",
			transactionState: "rolled_back",
		})
		// The refusal came from the listener reading, not an earlier gate: the
		// launch reached its endpoint check and then rolled its own group back.
		expect(hostEffects(probe).map(({ action }) => action)).toEqual([
			"port",
			"spawn",
			"listener",
			"signal",
		])
		expect(existsSync(probe.sessionPath)).toBe(false)
		expect(existsSync(probe.lockPath)).toBe(false)
	},
)

test("a post-spawn table that cannot be verified never signals the launched identity", () => {
	// The preflight table is clear, so the launch proceeds and spawns. The table
	// then stops answering at all, which cannot prove what pid 4242 now names.
	const probe = productionCliProbe({
		...launchPlan(),
		processTableAfterSpawn: { status: null, signal: null, failed: true, stdout: null },
	})

	const result = runProductionCli(probe, ["start", "--run-id", "post-spawn-unverifiable"])

	expectLaunchCleanupUnverified(result, "post-spawn-unverifiable")
	expectLaunchMarkerRetainedUnsignalled(probe, "post-spawn-unverifiable")
})

/**
 * Independent oracle: post-spawn readings that name the launched process
 * identity without proving it is the launched process. Every row here parses,
 * so each is refused on ownership alone, and the first three carry the launched
 * identity as its own process-group leader: matching pid and pgid must not be
 * enough to claim a process and signal it.
 */
const unownedPostSpawnRows = [
	["no row at all for the launched identity", () => systemRows],
	[
		"the launched identity reused by an unrelated process",
		() => `${systemRows}${processRow("4242", "4242", "/usr/bin/login -pf someone")}`,
	],
	[
		"the installed Chrome under a different Agent Chrome Profile",
		() =>
			`${systemRows}${
				processRow("4242", "4242", `${installedChrome} --user-data-dir=/tmp/other-profile`)
			}`,
	],
	[
		"the installed Chrome path suffixed -evil",
		() =>
			`${systemRows}${
				processRow("4242", "4242", `${installedChrome}-evil --user-data-dir=/tmp/other-profile`)
			}`,
	],
] as const

test.each(unownedPostSpawnRows)(
	"a post-spawn table showing %s never signals the launched identity",
	(_name, build) => {
		const probe = productionCliProbe({
			...launchPlan(),
			processTableAfterSpawn: verifiedReading(build()),
		})

		const result = runProductionCli(probe, ["start", "--run-id", "post-spawn-unowned"])

		expectLaunchCleanupUnverified(result, "post-spawn-unowned")
		expectLaunchMarkerRetainedUnsignalled(probe, "post-spawn-unowned")
	},
)

test("a launched identity that does not lead its own process group is never signalled", () => {
	// The rendered row is the exact launched Chrome, argument list and all; only
	// its process group differs, so the launch owns no group it may signal.
	const probe = productionCliProbe({ ...launchPlan(), spawnedProcessGroupId: 4243 })

	const result = runProductionCli(probe, ["start", "--run-id", "post-spawn-foreign-group"])

	expectLaunchCleanupUnverified(result, "post-spawn-foreign-group")
	expectLaunchMarkerRetainedUnsignalled(probe, "post-spawn-foreign-group")
})

test("an endpoint whose process identity changed after the CDP reads is not verified", () => {
	// The CDP documents describe whoever answered a moment ago. By the time the
	// answer is given, process identity 4242 names something else entirely.
	const probe = productionCliProbe({
		...launchPlan(),
		processTableAfterJson: verifiedReading(
			`${systemRows}${processRow("4242", "4242", "/usr/bin/login -pf someone")}`,
		),
	})

	const result = runProductionCli(probe, ["start", "--run-id", "endpoint-identity-changed"])

	// The endpoint is refused, and the group it can no longer prove it owns is
	// preserved rather than signalled. Independent oracle: the existing
	// rollback-unverified refusal, restated by hand.
	expect(result.exitCode).toBe(1)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		`${
			JSON.stringify({
				schemaVersion: 1,
				status: "error",
				command: "start",
				resultCode: "UNEXPECTED_FAILURE",
				runId: "endpoint-identity-changed",
				transactionState: "unchanged",
				retrySafe: false,
				nextAction: "Inspect the owned process group and private state before retrying.",
				message: "Warm Browser could not roll back its unverified browser process group.",
			})
		}
`,
	)
	expect(JSON.parse(readFileSync(probe.sessionPath, "utf8"))).toMatchObject({ phase: "starting" })
	expect(existsSync(probe.lockPath)).toBe(true)
	expect(hostEffects(probe).filter(({ action }) => action === "signal")).toEqual([])
})

test("an endpoint whose listener owner changed after the CDP reads is not verified", () => {
	const probe = productionCliProbe({
		...launchPlan(),
		// The owned process is unchanged; another process now holds the port.
		listenerAfterJson: { status: 0, signal: null, failed: false, stdout: "p4243\n" },
	})

	const result = runProductionCli(probe, ["start", "--run-id", "endpoint-listener-changed"])

	expect(result.exitCode).toBe(20)
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "CDP_IDENTITY_UNVERIFIED",
		transactionState: "rolled_back",
	})
	// The owned group is still provable here, so the failed start rolls back.
	expect(existsSync(probe.sessionPath)).toBe(false)
	expect(existsSync(probe.lockPath)).toBe(false)
	expect(hostEffects(probe).filter(({ action }) => action === "signal")).toEqual([
		{ action: "signal", processGroupId: 4242, signal: "SIGTERM" },
	])
})

test("an unsafe Agent Chrome Profile refuses the launch before any host effect", () => {
	const probe = productionCliProbe(launchPlan())
	// The real production profile check runs against this harness-owned HOME.
	chmodSync(probe.profileRoot, 0o755)

	const result = runProductionCli(probe, ["start", "--run-id", "unsafe-profile"])

	expect(result.exitCode).toBe(21)
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "PROFILE_UNSAFE",
		transactionState: "unchanged",
	})
	expect(hostEffects(probe)).toEqual([])
	expect(existsSync(probe.lockPath)).toBe(false)
})

/** One real second process running the production CLI, held at its port barrier. */
function spawnProductionCli(probe: ProductionCliProbe, arguments_: readonly string[]) {
	return Bun.spawn({
		cmd: [process.execPath, "--preload", preloadEntry, productionEntry, ...arguments_],
		cwd: packageRoot,
		env: probe.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
}

async function waitForPortInspection(probe: ProductionCliProbe): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		if (hostEffects(probe).some(({ action }) => action === "port")) return
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	throw new Error("the held start never reached its port inspection")
}

test("a start that passed the tombstone precheck refuses once a cleanup detaches its lock", async () => {
	const barrier = join(tmpdir(), `warm-browser-acquire-${crypto.randomUUID()}`)
	const probe = productionCliProbe({ ...launchPlan(), holdPortInspectionUntil: barrier })

	// The starter passes the tombstone precheck against a clean state root, then
	// is held in the window immediately before it acquires ownership.
	const started = spawnProductionCli(probe, ["start", "--run-id", "acquire-race"])
	await waitForPortInspection(probe)
	expect(existsSync(probe.lockPath)).toBe(false)

	// Another owner's cleanup detaches its lock into a tombstone and then fails,
	// which is the exact state the held starter must refuse to acquire into.
	mkdirSync(join(probe.sessionRoot, ".cleanup-old-session"), { recursive: true, mode: 0o700 })
	writeFileSync(barrier, "release\n")

	const [exitCode, stdout, stderr] = await Promise.all([
		started.exited,
		new Response(started.stdout).text(),
		new Response(started.stderr).text(),
	])

	expect(exitCode).toBe(20)
	expect(stdout).toBe("")
	expect(JSON.parse(stderr)).toMatchObject({
		resultCode: "STATE_UNSAFE",
		transactionState: "unchanged",
	})
	// It refused before writing any receipt and before launching anything.
	expect(existsSync(probe.sessionPath)).toBe(false)
	expect(existsSync(probe.lockPath)).toBe(false)
	expect(hostEffects(probe).filter(({ action }) => action === "spawn")).toEqual([])
	// The other owner's tombstone is left exactly as its cleanup left it.
	expect(existsSync(join(probe.sessionRoot, ".cleanup-old-session"))).toBe(true)
})

/**
 * Independent oracle: the truthful result when a proved stop cannot remove its
 * durable state. The stop already happened, so the transaction is stopped and
 * the retained state is what needs repair. Restated by hand.
 */
function expectStoppedButRetained(
	probe: ProductionCliProbe,
	result: Bun.ReadableSyncSubprocess,
): void {
	expect(result.exitCode).toBe(20)
	expect(result.stdout.toString()).toBe("")
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		status: "error",
		command: "start",
		resultCode: "STATE_UNSAFE",
		transactionState: "stopped",
		retrySafe: false,
		nextAction:
			"Repair the retained private Warm Browser session state; the owned browser process group is already stopped.",
		message:
			"Warm Browser stopped the owned browser process group but could not remove its private session state.",
	})
	// Exactly one termination sequence: an already-stopped group is never
	// signalled a second time by the cleanup that failed after it.
	expect(hostEffects(probe).filter(({ action }) => action === "signal")).toEqual([
		{ action: "signal", processGroupId: 4242, signal: "SIGTERM" },
	])
	// The receipt is retained where a repair can find it.
	expect(readdirSync(probe.sessionRoot).some((entry) => entry.startsWith(".cleanup-"))).toBe(true)
}

test("an endpoint rollback whose cleanup fails reports the stop and never signals twice", () => {
	const probe = productionCliProbe({
		...launchPlan(),
		// A foreign listener refuses the endpoint, so the launch rolls back.
		listenerOwner: 4243,
		obstructCleanup: true,
	})

	const result = runProductionCli(probe, ["start", "--run-id", "rollback-cleanup"])

	expectStoppedButRetained(probe, result)
})

test("an unexpected post-spawn rollback whose cleanup fails reports the stop and signals once", () => {
	const probe = productionCliProbe({
		...launchPlan(),
		// One unexpected host failure once the launch is recorded as starting,
		// which is after the spawn is confirmed, then normal behaviour.
		processTableThrowsWhenStarting: true,
		obstructCleanup: true,
	})

	const result = runProductionCli(probe, ["start", "--run-id", "unexpected-cleanup"])

	expectStoppedButRetained(probe, result)
})
