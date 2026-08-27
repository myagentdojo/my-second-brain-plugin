import { afterEach, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import {
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
	expect(result.exitCode).toBe(20)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "error",
			command,
			resultCode: "PROCESS_INSPECTION_UNVERIFIED",
			runId,
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Inspect the host process table and private Warm Browser state before retrying.",
			message: "Warm Browser could not verify the local process table.",
		}),
	)
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

	expect(result.exitCode).toBe(21)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "error",
			command: "start",
			resultCode: "PROFILE_IN_USE",
			runId: "profile-in-use-start",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Close the existing profile owner, then retry Warm Browser start.",
			message: "An unowned process is using the Agent Chrome Profile.",
		}),
	)
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

	expect(result.exitCode).toBe(20)
	expect(result.stdout.toString()).toBe("")
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
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

	expect(result.exitCode).toBe(1)
	expect(result.stdout.toString()).toBe("")
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
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

	expect(result.exitCode).toBe(0)
	expect(result.stderr.toString()).toBe("")
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		resultCode: "STALE_SESSION_RECOVERED",
		transactionState: "recovered",
		data: { trigger: "status", postcondition: "absent", stoppedOwnedProcess: true },
	})
	expect(hostEffects(probe)).toEqual([
		{ action: "signal", processGroupId: 4242, signal: "SIGTERM" },
	])
	expect(existsSync(probe.lockPath)).toBe(false)
})

test("the local process table has exactly one production reader", () => {
	const moduleRoot = resolve(packageRoot, "src/modules/warm-browser")
	const readers = readdirSync(moduleRoot)
		.filter((entry) => entry.endsWith(".ts"))
		.filter((entry) => readFileSync(join(moduleRoot, entry), "utf8").includes("/bin/ps"))

	expect(readers).toEqual(["host-effects.ts"])
})
