import { afterEach, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import {
	expectError,
	expectRefusal,
	hostEffects,
	installedChrome,
	packageRoot,
	processRow,
	type ProductionCliProbe,
	productionCliProbe,
	removeProductionCliProbes,
	runProductionCli,
	seedSessionState,
	startedAtToken,
	systemRows,
	verifiedReading,
	writeHostEffectsPlan,
} from "./fixtures/production-cli-harness"

afterEach(removeProductionCliProbes)

/**
 * Independent oracle: the exact Chrome command line a well-formed row carries.
 * Restated here on purpose so no production table supplies its own expectation.
 */
function chromeCommand(profileRoot: string, launchMarker = "session-probe"): string {
	return [
		installedChrome,
		`--user-data-dir=${profileRoot}`,
		"--profile-directory=Default",
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=9242",
		`--agent-browser-launch-marker=${launchMarker}`,
		"--password-store=basic",
		"--use-mock-keychain",
		"--no-first-run",
		"--no-default-browser-check",
	].join(" ")
}

function runningState(probe: ProductionCliProbe): Record<string, unknown> {
	return {
		schemaVersion: 1,
		phase: "running",
		sessionId: "session-probe",
		startRunId: "probe-start",
		launchMarker: "session-probe",
		createdAtEpochMs: 1_000,
		profileRoot: probe.profileRoot,
		launch: { executable: installedChrome, commandLine: chromeCommand(probe.profileRoot) },
		endpoint: {
			host: "127.0.0.1",
			port: 9242,
			browserVersion: "Chrome/151.0.7922.174",
			controlledPageTargetId: "page-1",
		},
		process: {
			pid: 4242,
			processGroupId: 4242,
			startedAtToken,
			executable: installedChrome,
			commandLine: chromeCommand(probe.profileRoot),
		},
	}
}

function launchingState(probe: ProductionCliProbe): Record<string, unknown> {
	return {
		schemaVersion: 1,
		phase: "launching",
		sessionId: "session-probe",
		startRunId: "probe-start",
		launchMarker: "session-probe",
		createdAtEpochMs: 1_000,
		profileRoot: probe.profileRoot,
		launch: { executable: installedChrome, commandLine: chromeCommand(probe.profileRoot) },
		endpoint: { host: "127.0.0.1", port: 9242 },
	}
}

function output(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)}\n`
}

/**
 * Independent oracle: a start token the production row pattern cannot parse,
 * because it carries neither a weekday nor a year.
 */
const unparsedStartToken = "Aug 27 09:52:01"

/** One reading whose only Chrome row is the exact owned command line. */
function ownedRowReading(probe: ProductionCliProbe): Record<string, unknown> {
	return verifiedReading(
		`${systemRows}${processRow("4242", "4242", chromeCommand(probe.profileRoot))}`,
	)
}

/** The same owned row, framed by a start token the production parser rejects. */
function unparsedOwnedRowReading(probe: ProductionCliProbe): Record<string, unknown> {
	return verifiedReading(
		`${systemRows}${
			processRow("4242", "4242", chromeCommand(probe.profileRoot), unparsedStartToken)
		}`,
	)
}

/**
 * Independent oracle: the exact refusal an unverifiable process-table
 * observation must produce, restated here so no production table supplies it.
 */
function expectInspectionUnverified(
	result: Bun.ReadableSyncSubprocess,
	command: "start" | "status" | "stop",
	runId: string,
): void {
	expectError(result, 20, {
			schemaVersion: 1,
			status: "error",
			command,
			resultCode: "PROCESS_INSPECTION_UNVERIFIED",
			runId,
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Inspect the host process table and private Warm Browser state before retrying.",
			message: "Warm Browser could not verify the local process table.",
	})
}

const ambiguousReadings: ReadonlyArray<
	readonly [string, (probe: ProductionCliProbe) => Record<string, unknown>]
> = [
	[
		"a nonempty row that does not parse",
		() => verifiedReading(`${systemRows}ps: process table read failed\n`),
	],
	[
		"a duplicate process identity",
		(probe) =>
			verifiedReading(
				`${systemRows}${processRow("4242", "4242", chromeCommand(probe.profileRoot))}${
					processRow("4242", "4242", "/usr/bin/login -pf someone")
				}`,
			),
	],
	[
		"a process identity outside the safe integer range",
		() =>
			verifiedReading(
				`${systemRows}${
					processRow("99999999999999999999", "99999999999999999999", "/usr/bin/true")
				}`,
			),
	],
	[
		"a leading-zero process identity",
		() => verifiedReading(`${systemRows}${processRow("04242", "04242", "/usr/bin/true")}`),
	],
	[
		"an argv-embedded newline that splits one row",
		(probe) =>
			verifiedReading(
				`${systemRows}${
					processRow("4242", "4242", `${chromeCommand(probe.profileRoot)} --title=first\nsecond line`)
				}`,
			),
	],
	[
		"a carriage return inside a row",
		() => verifiedReading(`${systemRows}${processRow("4242", "4242", "/usr/bin/true --title=a\rb")}`),
	],
	[
		"output truncated before its final newline",
		() => verifiedReading(`${systemRows}${processRow("4242", "4242", "/usr/bin/true")}`.slice(0, -1)),
	],
	["empty output", () => verifiedReading("")],
	["a nonzero exit status", () => ({ status: 1, signal: null, failed: false, stdout: "" })],
	["a terminating signal", () => ({ status: null, signal: "SIGKILL", failed: false, stdout: null })],
	["a failed process-table read", () => ({ status: null, signal: null, failed: true, stdout: null })],
]

test.each(ambiguousReadings)(
	"start refuses before lock, spawn, or signal when the process table shows %s",
	(_name, build) => {
		const probe = productionCliProbe()
		writeHostEffectsPlan(probe, { processTable: build(probe) })

		const result = runProductionCli(probe, ["start", "--run-id", "table-start"])

		expectInspectionUnverified(result, "start", "table-start")
		expect(existsSync(probe.lockPath)).toBe(false)
		expect(hostEffects(probe)).toEqual([])
	},
)

test("an unparsed profile owner never reads as an unused Agent Chrome Profile", () => {
	const probe = productionCliProbe()
	writeHostEffectsPlan(probe, { processTable: unparsedOwnedRowReading(probe) })

	const result = runProductionCli(probe, ["start", "--run-id", "profile-owner-start"])

	expectInspectionUnverified(result, "start", "profile-owner-start")
	expect(existsSync(probe.lockPath)).toBe(false)
	expect(hostEffects(probe)).toEqual([])
})

test("an unparsed owned row never proves the running Browser Session absent", () => {
	const probe = productionCliProbe()
	seedSessionState(probe, runningState(probe))
	const stateBefore = readFileSync(probe.sessionPath, "utf8")
	writeHostEffectsPlan(probe, { processTable: unparsedOwnedRowReading(probe) })

	const result = runProductionCli(probe, ["stop", "--run-id", "owned-row-stop"])

	expectInspectionUnverified(result, "stop", "owned-row-stop")
	expect(readFileSync(probe.sessionPath, "utf8")).toBe(stateBefore)
	expect(hostEffects(probe)).toEqual([])
})

test("an unparsed marked row never proves the stale launch intent absent", () => {
	const probe = productionCliProbe()
	seedSessionState(probe, launchingState(probe))
	const stateBefore = readFileSync(probe.sessionPath, "utf8")
	writeHostEffectsPlan(probe, { processTable: unparsedOwnedRowReading(probe) })

	const result = runProductionCli(probe, ["status", "--run-id", "marked-row-status"])

	expectInspectionUnverified(result, "status", "marked-row-status")
	expect(readFileSync(probe.sessionPath, "utf8")).toBe(stateBefore)
	expect(hostEffects(probe)).toEqual([])
})

test("a well-formed table still proves one live profile owner without signalling it", () => {
	const probe = productionCliProbe()
	writeHostEffectsPlan(probe, { processTable: ownedRowReading(probe) })

	const result = runProductionCli(probe, ["start", "--run-id", "profile-in-use-start"])

	expectError(result, 21, {
			schemaVersion: 1,
			status: "error",
			command: "start",
			resultCode: "PROFILE_IN_USE",
			runId: "profile-in-use-start",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Close the existing profile owner, then retry Warm Browser start.",
			message: "An unowned process is using the Agent Chrome Profile.",
	})
	expect(existsSync(probe.lockPath)).toBe(false)
	expect(hostEffects(probe)).toEqual([])
})

test("an installed-Chrome path suffixed -evil never classifies as the installed Chrome", () => {
	const probe = productionCliProbe()
	const impostor = `${installedChrome}-evil`
	writeHostEffectsPlan(probe, {
		processTable: verifiedReading(
			`${systemRows}${
				processRow(
					"4242",
					"4242",
					chromeCommand(probe.profileRoot).replace(installedChrome, impostor),
				)
			}`,
		),
		spawnOutcome: "missing_executable",
	})

	const result = runProductionCli(probe, ["start", "--run-id", "impostor-start"])

	// The impostor is not the installed Chrome, so it never claims the Agent
	// Chrome Profile and start proceeds to its own launch attempt instead.
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "UNEXPECTED_FAILURE",
		transactionState: "rolled_back",
	})
	expect(hostEffects(probe).map(({ action }) => action)).toEqual(["port", "spawn"])
	expect(hostEffects(probe).filter(({ action }) => action === "signal")).toEqual([])
})

test("an owned process id running an -evil impostor is preserved and never signalled", () => {
	const probe = productionCliProbe()
	seedSessionState(probe, runningState(probe))
	const stateBefore = readFileSync(probe.sessionPath, "utf8")
	writeHostEffectsPlan(probe, {
		processTable: verifiedReading(
			`${systemRows}${
				processRow(
					"4242",
					"4242",
					chromeCommand(probe.profileRoot).replace(
						installedChrome,
						`${installedChrome}-evil`,
					),
				)
			}`,
		),
	})

	const result = runProductionCli(probe, ["stop", "--run-id", "impostor-stop"])

	expect(result.exitCode).toBe(20)
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "PROCESS_IDENTITY_UNVERIFIED",
		transactionState: "unchanged",
	})
	expect(readFileSync(probe.sessionPath, "utf8")).toBe(stateBefore)
	expect(hostEffects(probe)).toEqual([])
})

test("a well-formed owned row is still matched exactly before endpoint verification", () => {
	const probe = productionCliProbe()
	seedSessionState(probe, runningState(probe))
	const stateBefore = readFileSync(probe.sessionPath, "utf8")
	writeHostEffectsPlan(probe, { processTable: ownedRowReading(probe) })

	const result = runProductionCli(probe, ["stop", "--run-id", "owned-row-verify"])

	expectRefusal(result, 20, {
		resultCode: "CDP_IDENTITY_UNVERIFIED",
		transactionState: "unchanged",
	})
	expect(readFileSync(probe.sessionPath, "utf8")).toBe(stateBefore)
	expect(hostEffects(probe)).toEqual([{ action: "listener", port: 9242 }])
})

test("a well-formed marked row is still matched exactly before stale-launch cleanup", () => {
	const probe = productionCliProbe()
	seedSessionState(probe, launchingState(probe))
	writeHostEffectsPlan(probe, {
		processTable: ownedRowReading(probe),
		signalOutcome: "denied",
	})

	const result = runProductionCli(probe, ["status", "--run-id", "marked-row-cleanup"])

	expectRefusal(result, 1, {
		resultCode: "UNEXPECTED_FAILURE",
		message: "Warm Browser could not clean up its stale marked process group.",
	})
	expect(hostEffects(probe)).toEqual([
		{ action: "signal", processGroupId: 4242, signal: "SIGTERM" },
	])
	expect(existsSync(probe.sessionPath)).toBe(true)
})

test("a well-formed marked row is stopped and cleaned when its group is proved gone", () => {
	const probe = productionCliProbe()
	seedSessionState(probe, launchingState(probe))
	writeHostEffectsPlan(probe, { processTable: ownedRowReading(probe) })

	const result = runProductionCli(probe, ["status", "--run-id", "marked-row-recovered"])

	expectStaleSessionRecovered(result)
	expect(hostEffects(probe)).toEqual([
		{ action: "signal", processGroupId: 4242, signal: "SIGTERM" },
	])
	expect(existsSync(probe.lockPath)).toBe(false)
})

/**
 * Independent oracle: marker-matched command lines that differ from the durable
 * launch by exactly one argument. Each keeps the launch marker, so recovery
 * finds the row and must refuse it on ownership rather than on failing to find
 * it. Restated by hand so no production builder supplies the expectation.
 */
const unownedLaunchCommands = [
	[
		"one extra argument",
		(profileRoot: string) => `${chromeCommand(profileRoot)} --load-extension=/tmp/unowned`,
	],
	[
		"a missing keychain argument",
		(profileRoot: string) => chromeCommand(profileRoot).replace(" --use-mock-keychain", ""),
	],
	[
		"a missing password-store argument",
		(profileRoot: string) => chromeCommand(profileRoot).replace(" --password-store=basic", ""),
	],
	[
		"one changed argument",
		(profileRoot: string) =>
			chromeCommand(profileRoot).replace("--profile-directory=Default", "--profile-directory=Other"),
	],
] as const

test.each(unownedLaunchCommands)(
	"stale launch recovery refuses a marked row differing by %s and signals nothing",
	(_name, build) => {
		const probe = productionCliProbe()
		seedSessionState(probe, launchingState(probe))
		const stateBefore = readFileSync(probe.sessionPath, "utf8")
		writeHostEffectsPlan(probe, {
			processTable: verifiedReading(
				`${systemRows}${processRow("4242", "4242", build(probe.profileRoot))}`,
			),
		})

		const result = runProductionCli(probe, ["status", "--run-id", "unowned-launch"])

		expectError(result, 20, {
				schemaVersion: 1,
				status: "error",
				command: "status",
				resultCode: "PROCESS_IDENTITY_UNVERIFIED",
				runId: "unowned-launch",
				transactionState: "unchanged",
				retrySafe: false,
				nextAction:
					"Inspect the live process and private Warm Browser state; do not signal the stored process id.",
				message: "The stored browser process identity does not match the live process.",
		})
		expect(readFileSync(probe.sessionPath, "utf8")).toBe(stateBefore)
		expect(existsSync(probe.lockPath)).toBe(true)
		expect(hostEffects(probe)).toEqual([])
	},
)

/**
 * Independent oracle: the result a stale session recovered by a proved stop
 * must publish. Restated by hand so no production table supplies it, and owned
 * once because every test that reaches it is claiming the same thing.
 */
function expectStaleSessionRecovered(result: Bun.ReadableSyncSubprocess): void {
	expect(result.exitCode).toBe(0)
	expect(result.stderr.toString()).toBe("")
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		resultCode: "STALE_SESSION_RECOVERED",
		transactionState: "recovered",
		data: { trigger: "status", postcondition: "absent", stoppedOwnedProcess: true },
	})
}

/** Every signal the run recorded, in order. */
function signalEffects(probe: ProductionCliProbe): Array<Record<string, unknown>> {
	return hostEffects(probe).filter(({ action }) => action === "signal")
}

/**
 * Independent oracle: readings that no longer prove the same owner once the
 * stop has been requested. Each keeps process identity 4242 alive so the
 * bounded liveness probes still answer "present", which is exactly the state in
 * which escalation used to be taken on nothing more than a number.
 */
const changedOwnerAfterSignal = [
	[
		"a reused identity running an unrelated process",
		() => `${systemRows}${processRow("4242", "4242", "/usr/bin/login -pf someone")}`,
	],
	[
		"the process group holding an unrelated process",
		() => `${systemRows}${processRow("4310", "4242", "/usr/bin/login -pf someone")}`,
	],
	[
		"the leader gone but a child of its group still running",
		() =>
			`${systemRows}${
				processRow("4310", "4242", `${installedChrome} --type=renderer --enable-crashpad`)
			}`,
	],
	[
		"the same identity with one argument gained",
		(profileRoot: string) =>
			`${systemRows}${
				processRow("4242", "4242", `${chromeCommand(profileRoot)} --load-extension=/tmp/unowned`)
			}`,
	],
] as const

test.each(changedOwnerAfterSignal)(
	"escalation is refused when the process table shows %s after the stop was requested",
	(_name, build) => {
		const probe = productionCliProbe()
		seedSessionState(probe, launchingState(probe))
		const stateBefore = readFileSync(probe.sessionPath, "utf8")
		writeHostEffectsPlan(probe, {
			processTable: ownedRowReading(probe),
			// The request lands, the group still answers, and only then does the
			// table stop naming the process Warm Browser owns.
			signalOutcomes: { SIGTERM: "delivered", "0": "denied" },
			processTableAfterSignal: verifiedReading(build(probe.profileRoot)),
		})

		const result = runProductionCli(probe, ["status", "--run-id", "escalation-refused"])

		expectRefusal(result, 1, {
			resultCode: "UNEXPECTED_FAILURE",
			transactionState: "unchanged",
			message: "Warm Browser could not clean up its stale marked process group.",
		})
		expect(readFileSync(probe.sessionPath, "utf8")).toBe(stateBefore)
		expect(existsSync(probe.lockPath)).toBe(true)
		expect(signalEffects(probe)[0]).toEqual({
			action: "signal",
			processGroupId: 4242,
			signal: "SIGTERM",
		})
		// The one irreversible act is never taken on an unproved identity.
		expect(signalEffects(probe).filter(({ signal }) => signal === "SIGKILL")).toEqual([])
	},
)

test("an emptied process group is a proved stop even when its identity moved on", () => {
	const probe = productionCliProbe()
	seedSessionState(probe, launchingState(probe))
	writeHostEffectsPlan(probe, {
		processTable: ownedRowReading(probe),
		signalOutcomes: { SIGTERM: "delivered", "0": "denied" },
		// Nothing remains in the signalled group: the identity that led it now
		// belongs to an unrelated group, so this group really is gone.
		processTableAfterSignal: verifiedReading(
			`${systemRows}${processRow("4242", "4243", "/usr/bin/login -pf someone")}`,
		),
	})

	const result = runProductionCli(probe, ["status", "--run-id", "group-emptied"])

	expectStaleSessionRecovered(result)
	expect(existsSync(probe.lockPath)).toBe(false)
	// Proved by observation, so the group was never escalated on.
	expect(signalEffects(probe).filter(({ signal }) => signal === "SIGKILL")).toEqual([])
})

test("an unchanged exact owner is escalated once and then proved absent", () => {
	const probe = productionCliProbe()
	seedSessionState(probe, launchingState(probe))
	writeHostEffectsPlan(probe, {
		processTable: ownedRowReading(probe),
		signalOutcomes: { SIGTERM: "delivered", "0": "denied", SIGKILL: "absent" },
	})

	const result = runProductionCli(probe, ["status", "--run-id", "escalation-proved"])

	expectStaleSessionRecovered(result)
	expect(existsSync(probe.lockPath)).toBe(false)
	expect(signalEffects(probe).at(0)).toEqual({
		action: "signal",
		processGroupId: 4242,
		signal: "SIGTERM",
	})
	expect(signalEffects(probe).at(-1)).toEqual({
		action: "signal",
		processGroupId: 4242,
		signal: "SIGKILL",
	})
	// Exactly one escalation, never a second.
	expect(signalEffects(probe).filter(({ signal }) => signal === "SIGKILL")).toHaveLength(1)
})

/**
 * Independent oracle: durable receipts carrying a value outside its domain.
 * Each is one representative of a rule the phase validators own, and every one
 * of them is read back into decisions that signal processes or remove state.
 */
const invalidReceipts: ReadonlyArray<
	readonly [string, (probe: ProductionCliProbe) => Record<string, unknown>]
> = [
	["a timestamp before the epoch", (probe) => ({ ...runningState(probe), createdAtEpochMs: -1 })],
	[
		"a non-positive process identity",
		(probe) => ({
			...runningState(probe),
			process: { ...(runningState(probe).process as object), pid: 0 },
		}),
	],
	[
		"a negative process group",
		(probe) => ({
			...runningState(probe),
			process: { ...(runningState(probe).process as object), processGroupId: -1 },
		}),
	],
	[
		"a port below the valid range",
		(probe) => ({
			...runningState(probe),
			endpoint: { ...(runningState(probe).endpoint as object), port: 0 },
		}),
	],
	[
		"a port above the valid range",
		(probe) => ({
			...runningState(probe),
			endpoint: { ...(runningState(probe).endpoint as object), port: 70_000 },
		}),
	],
	["a run id outside the vocabulary", (probe) => ({ ...runningState(probe), startRunId: "bad id" })],
	[
		"a launching receipt claiming a verified endpoint",
		(probe) => ({
			...launchingState(probe),
			endpoint: { host: "127.0.0.1", port: 9242, browserVersion: "Chrome/151.0.7922.174" },
		}),
	],
	[
		"a running receipt with no controlled page",
		(probe) => ({
			...runningState(probe),
			endpoint: { host: "127.0.0.1", port: 9242, browserVersion: "Chrome/151.0.7922.174" },
		}),
	],
]

test.each(invalidReceipts)("a durable receipt carrying %s is unsafe state", (_name, build) => {
	const probe = productionCliProbe()
	seedSessionState(probe, build(probe))
	writeHostEffectsPlan(probe, { processTable: ownedRowReading(probe) })

	const result = runProductionCli(probe, ["status", "--run-id", "invalid-receipt"])

	expectError(result, 20, {
			schemaVersion: 1,
			status: "error",
			command: "status",
			resultCode: "STATE_UNSAFE",
			runId: "invalid-receipt",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Repair the private XDG state ownership and permissions before retrying.",
			message: "Warm Browser private state is unsafe or unreadable.",
	})
	expect(existsSync(probe.sessionPath)).toBe(true)
	expect(hostEffects(probe)).toEqual([])
})

/**
 * Independent oracle: live installed Chrome owning the exact Agent Chrome
 * Profile and port, whose launch marker no longer identifies it. A marker can
 * be lost or rewritten while the browser it named is still running, so a marker
 * that matches nothing never proves the launch gone.
 */
const unprovedLaunchAbsence = [
	[
		"a changed launch marker",
		(profileRoot: string) => chromeCommand(profileRoot, "session-other"),
	],
	[
		"a missing launch marker",
		(profileRoot: string) =>
			chromeCommand(profileRoot).replace(" --agent-browser-launch-marker=session-probe", ""),
	],
] as const

test.each(unprovedLaunchAbsence)(
	"a stale launch is never proved absent by %s while a profile owner is live",
	(_name, build) => {
		const probe = productionCliProbe()
		seedSessionState(probe, launchingState(probe))
		const stateBefore = readFileSync(probe.sessionPath, "utf8")
		writeHostEffectsPlan(probe, {
			processTable: verifiedReading(
				`${systemRows}${processRow("4242", "4242", build(probe.profileRoot))}`,
			),
		})

		const result = runProductionCli(probe, ["status", "--run-id", "unproved-absence"])

		expectError(result, 20, {
			schemaVersion: 1,
			status: "error",
			command: "status",
			resultCode: "PROCESS_IDENTITY_UNVERIFIED",
			runId: "unproved-absence",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction:
				"Inspect the live process and private Warm Browser state; do not signal the stored process id.",
			message: "The stored browser process identity does not match the live process.",
		})
		// The receipt still names the browser nobody else is accounting for.
		expect(readFileSync(probe.sessionPath, "utf8")).toBe(stateBefore)
		expect(existsSync(probe.lockPath)).toBe(true)
		expect(hostEffects(probe)).toEqual([])
	},
)

test("a stale launch with no marker and no profile owner is cleaned without signalling", () => {
	const probe = productionCliProbe()
	seedSessionState(probe, launchingState(probe))
	// Nothing carries the marker and nothing owns the profile: absence is proved
	// twice over, which is the only way this receipt may be removed.
	writeHostEffectsPlan(probe, { processTable: verifiedReading(systemRows) })

	const result = runProductionCli(probe, ["status", "--run-id", "launch-absent"])

	expect(result.exitCode).toBe(0)
	expect(result.stderr.toString()).toBe("")
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		resultCode: "STALE_SESSION_RECOVERED",
		transactionState: "recovered",
		data: { trigger: "status", postcondition: "absent", stoppedOwnedProcess: false },
	})
	expect(existsSync(probe.lockPath)).toBe(false)
	expect(hostEffects(probe)).toEqual([])
})

// Independent oracle: the raw host commands Warm Browser is allowed to run.
test.each(["/bin/ps", "/usr/sbin/lsof"] as const)(
	"the %s host reading has exactly one production reader",
	(hostCommand) => {
		const moduleRoot = resolve(packageRoot, "src/modules/warm-browser")
		const readers = readdirSync(moduleRoot)
			.filter((entry) => entry.endsWith(".ts"))
			.filter((entry) => readFileSync(join(moduleRoot, entry), "utf8").includes(hostCommand))

		expect(readers).toEqual(["host-effects.ts"])
	},
)
