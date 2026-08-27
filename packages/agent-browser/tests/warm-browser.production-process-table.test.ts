import { afterEach, expect, test } from "bun:test"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const probeEntry = resolve(import.meta.dir, "fixtures/production-process-table-probe.ts")
const installedChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const startedAtToken = "Thu Aug 27 09:52:01 2026"
const temporaryRoots: string[] = []

interface Probe {
	readonly fakeRoot: string
	readonly sessionPath: string
	readonly lockPath: string
	readonly profileRoot: string
	readonly environment: Record<string, string>
}

interface Reading {
	readonly status: number | null
	readonly signal: string | null
	readonly failed: boolean
	readonly stdout: string | null
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function probe(): Probe {
	const root = mkdtempSync(join(tmpdir(), "warm-browser-process-table-"))
	temporaryRoots.push(root)
	chmodSync(root, 0o700)
	const fakeRoot = join(root, "fake")
	const stateHome = join(root, "state")
	const home = join(root, "home")
	mkdirSync(fakeRoot, { mode: 0o700 })
	mkdirSync(stateHome, { mode: 0o700 })
	mkdirSync(home, { mode: 0o700 })
	const environment = { ...process.env } as Record<string, string>
	delete environment.AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED
	environment.WARM_BROWSER_FIXTURE_ROOT = fakeRoot
	environment.XDG_STATE_HOME = stateHome
	environment.HOME = home
	const lockPath = join(stateHome, "my-second-brain", "warm-browser", "session.lock")
	return {
		fakeRoot,
		sessionPath: join(lockPath, "session.json"),
		lockPath,
		profileRoot: join(fakeRoot, ".agent-warm-profile"),
		environment,
	}
}

function row(pid: string, processGroupId: string, command: string, token = startedAtToken): string {
	return `${pid.padStart(5)} ${processGroupId.padStart(5)} ${token} ${command}\n`
}

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

const systemRows = `${row("1", "1", "/sbin/launchd")}${
	row("412", "412", "/usr/libexec/UserEventAgent (Aqua)")
}`

function verifiedReading(stdout: string): Reading {
	return { status: 0, signal: null, failed: false, stdout }
}

function writeReading(target: Probe, reading: Reading): void {
	writeFileSync(join(target.fakeRoot, "process-table.json"), `${JSON.stringify(reading)}\n`)
}

function seedState(target: Probe, state: Record<string, unknown>): void {
	mkdirSync(target.lockPath, { recursive: true, mode: 0o700 })
	chmodSync(target.lockPath, 0o700)
	writeFileSync(target.sessionPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
	chmodSync(target.sessionPath, 0o600)
}

function runningState(target: Probe): Record<string, unknown> {
	return {
		schemaVersion: 1,
		phase: "running",
		sessionId: "session-probe",
		startRunId: "probe-start",
		launchMarker: "session-probe",
		createdAtEpochMs: 1_000,
		profileRoot: target.profileRoot,
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
			commandLine: chromeCommand(target.profileRoot),
		},
	}
}

function launchingState(target: Probe): Record<string, unknown> {
	return {
		schemaVersion: 1,
		phase: "launching",
		sessionId: "session-probe",
		startRunId: "probe-start",
		launchMarker: "session-probe",
		createdAtEpochMs: 1_000,
		profileRoot: target.profileRoot,
		endpoint: { host: "127.0.0.1", port: 9242 },
	}
}

function run(target: Probe, arguments_: string[]): Bun.ReadableSyncSubprocess {
	return Bun.spawnSync({
		cmd: [process.execPath, probeEntry, ...arguments_],
		cwd: packageRoot,
		env: target.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
}

function actions(target: Probe): Array<Record<string, unknown>> {
	const path = join(target.fakeRoot, "actions.jsonl")
	return existsSync(path)
		? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
		: []
}

function output(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)}\n`
}

function inspectionUnverified(command: "start" | "status" | "stop", runId: string) {
	return {
		schemaVersion: 1,
		status: "error",
		command,
		resultCode: "PROCESS_INSPECTION_UNVERIFIED",
		runId,
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the host process table and private Warm Browser state before retrying.",
		message: "Warm Browser could not verify the local process table.",
	}
}

const ambiguousReadings: ReadonlyArray<readonly [string, (target: Probe) => Reading]> = [
	[
		"a nonempty row that does not parse",
		() => verifiedReading(`${systemRows}ps: process table read failed\n`),
	],
	[
		"a duplicate process identity",
		(target) =>
			verifiedReading(
				`${systemRows}${row("4242", "4242", chromeCommand(target.profileRoot))}${
					row("4242", "4242", "/usr/bin/login -pf someone")
				}`,
			),
	],
	[
		"a process identity outside the safe integer range",
		() =>
			verifiedReading(
				`${systemRows}${row("99999999999999999999", "99999999999999999999", "/usr/bin/true")}`,
			),
	],
	[
		"a leading-zero process identity",
		() => verifiedReading(`${systemRows}${row("04242", "04242", "/usr/bin/true")}`),
	],
	[
		"an argv-embedded newline that splits one row",
		(target) =>
			verifiedReading(
				`${systemRows}${
					row("4242", "4242", `${chromeCommand(target.profileRoot)} --title=first\nsecond line`)
				}`,
			),
	],
	[
		"a carriage return inside a row",
		() => verifiedReading(`${systemRows}${row("4242", "4242", "/usr/bin/true --title=a\rb")}`),
	],
	[
		"output truncated before its final newline",
		() => verifiedReading(`${systemRows}${row("4242", "4242", "/usr/bin/true")}`.slice(0, -1)),
	],
	["empty output", () => verifiedReading("")],
	["a nonzero exit status", () => ({ status: 1, signal: null, failed: false, stdout: "" })],
	[
		"a terminating signal",
		() => ({ status: null, signal: "SIGKILL", failed: false, stdout: null }),
	],
	["a failed process-table read", () => ({ status: null, signal: null, failed: true, stdout: null })],
]

test.each(ambiguousReadings)(
	"start refuses before lock, spawn, or signal when the process table shows %s",
	(_name, build) => {
		const target = probe()
		writeReading(target, build(target))

		const result = run(target, ["start", "--run-id", "table-start"])

		expect(result.exitCode).toBe(20)
		expect(result.stdout.toString()).toBe("")
		expect(result.stderr.toString()).toBe(output(inspectionUnverified("start", "table-start")))
		expect(existsSync(target.lockPath)).toBe(false)
		expect(actions(target)).toEqual([])
	},
)

test("an unparsed profile owner never reads as an unused Agent Chrome Profile", () => {
	const target = probe()
	writeReading(
		target,
		verifiedReading(
			`${systemRows}${row("4242", "4242", chromeCommand(target.profileRoot), "Aug 27 09:52:01")}`,
		),
	)

	const result = run(target, ["start", "--run-id", "profile-owner-start"])

	expect(result.exitCode).toBe(20)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		output(inspectionUnverified("start", "profile-owner-start")),
	)
	expect(existsSync(target.lockPath)).toBe(false)
	expect(actions(target)).toEqual([])
})

test("an unparsed owned row never proves the running Browser Session absent", () => {
	const target = probe()
	seedState(target, runningState(target))
	const stateBefore = readFileSync(target.sessionPath, "utf8")
	writeReading(
		target,
		verifiedReading(
			`${systemRows}${row("4242", "4242", chromeCommand(target.profileRoot), "Aug 27 09:52:01")}`,
		),
	)

	const result = run(target, ["stop", "--run-id", "owned-row-stop"])

	expect(result.exitCode).toBe(20)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(output(inspectionUnverified("stop", "owned-row-stop")))
	expect(readFileSync(target.sessionPath, "utf8")).toBe(stateBefore)
	expect(actions(target)).toEqual([])
})

test("an unparsed marked row never proves the stale launch intent absent", () => {
	const target = probe()
	seedState(target, launchingState(target))
	const stateBefore = readFileSync(target.sessionPath, "utf8")
	writeReading(
		target,
		verifiedReading(
			`${systemRows}${row("4242", "4242", chromeCommand(target.profileRoot), "Aug 27 09:52:01")}`,
		),
	)

	const result = run(target, ["status", "--run-id", "marked-row-status"])

	expect(result.exitCode).toBe(20)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		output(inspectionUnverified("status", "marked-row-status")),
	)
	expect(readFileSync(target.sessionPath, "utf8")).toBe(stateBefore)
	expect(actions(target)).toEqual([])
})

test("a well-formed table still proves one live profile owner without signalling it", () => {
	const target = probe()
	writeReading(
		target,
		verifiedReading(`${systemRows}${row("4242", "4242", chromeCommand(target.profileRoot))}`),
	)

	const result = run(target, ["start", "--run-id", "profile-in-use-start"])

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
	expect(existsSync(target.lockPath)).toBe(false)
	expect(actions(target)).toEqual([])
})

test("a well-formed table with no profile owner still reaches one launch attempt", () => {
	const target = probe()
	writeReading(target, verifiedReading(systemRows))

	const result = run(target, ["start", "--run-id", "free-profile-start"])

	expect(result.exitCode).toBe(1)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "error",
			command: "start",
			resultCode: "UNEXPECTED_FAILURE",
			runId: "free-profile-start",
			transactionState: "rolled_back",
			retrySafe: false,
			nextAction: "Inspect private state and the owned process group before retrying.",
			message: "Warm Browser start failed unexpectedly.",
		}),
	)
	expect(actions(target)).toEqual([
		{ action: "spawn", port: 9242, launchMarker: "session-probe" },
	])
	expect(existsSync(target.lockPath)).toBe(false)
})

test("a well-formed owned row is still matched exactly before endpoint verification", () => {
	const target = probe()
	seedState(target, runningState(target))
	const stateBefore = readFileSync(target.sessionPath, "utf8")
	writeReading(
		target,
		verifiedReading(`${systemRows}${row("4242", "4242", chromeCommand(target.profileRoot))}`),
	)

	const result = run(target, ["stop", "--run-id", "owned-row-verify"])

	expect(result.exitCode).toBe(20)
	expect(result.stdout.toString()).toBe("")
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "CDP_IDENTITY_UNVERIFIED",
		transactionState: "unchanged",
	})
	expect(readFileSync(target.sessionPath, "utf8")).toBe(stateBefore)
	expect(actions(target)).toEqual([{ action: "verify", pid: 4242, port: 9242 }])
})

test("a well-formed marked row is still matched exactly before stale-launch cleanup", () => {
	const target = probe()
	seedState(target, launchingState(target))
	writeReading(
		target,
		verifiedReading(`${systemRows}${row("4242", "4242", chromeCommand(target.profileRoot))}`),
	)

	const result = run(target, ["status", "--run-id", "marked-row-cleanup"])

	expect(result.exitCode).toBe(1)
	expect(result.stdout.toString()).toBe("")
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "UNEXPECTED_FAILURE",
		message: "Warm Browser could not clean up its stale marked process group.",
	})
	expect(actions(target)).toEqual([
		{ action: "terminate", pid: 4242, processGroupId: 4242 },
	])
	expect(existsSync(target.sessionPath)).toBe(true)
})

test("the local process table has exactly one production reader", () => {
	const moduleRoot = resolve(packageRoot, "src/modules/warm-browser")
	const readers = readdirSync(moduleRoot)
		.filter((entry) => entry.endsWith(".ts"))
		.filter((entry) => readFileSync(join(moduleRoot, entry), "utf8").includes("/bin/ps"))

	expect(readers).toEqual(["process-table.ts"])
	expect(readFileSync(join(moduleRoot, "production-adapter.ts"), "utf8")).toContain(
		"createProductionAdapter(readHostProcessTable)",
	)
})
