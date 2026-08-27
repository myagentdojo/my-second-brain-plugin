import { afterEach, expect, test } from "bun:test"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { productionAdapter } from "../src/modules/warm-browser/production-adapter"

const packageRoot = resolve(import.meta.dir, "..")
const productionEntry = resolve(packageRoot, "src/main.ts")
const fixtureEntry = resolve(import.meta.dir, "fixtures/warm-browser-driver.ts")
const productionChildProbe = resolve(import.meta.dir, "fixtures/production-adapter-child-probe.ts")
const temporaryRoots: string[] = []

interface Fixture {
	readonly root: string
	readonly fakeRoot: string
	readonly stateHome: string
	readonly sessionRoot: string
	readonly sessionPath: string
	readonly lockPath: string
	readonly profileRoot: string
	readonly environment: Record<string, string>
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(plan: Record<string, unknown> = {}): Fixture {
	const root = mkdtempSync(join(tmpdir(), "warm-browser-public-process-"))
	temporaryRoots.push(root)
	chmodSync(root, 0o700)
	const fakeRoot = join(root, "fake")
	const stateHome = join(root, "state")
	const home = join(root, "home")
	mkdirSync(fakeRoot, { mode: 0o700 })
	mkdirSync(stateHome, { mode: 0o700 })
	mkdirSync(home, { mode: 0o700 })
	writeFileSync(join(fakeRoot, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`)
	const environment = { ...process.env } as Record<string, string>
	delete environment.AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED
	environment.WARM_BROWSER_FIXTURE_ROOT = fakeRoot
	environment.XDG_STATE_HOME = stateHome
	environment.HOME = home
	const sessionRoot = join(stateHome, "my-second-brain", "warm-browser")
	return {
		root,
		fakeRoot,
		stateHome,
		sessionRoot,
		sessionPath: join(sessionRoot, "session.lock", "session.json"),
		lockPath: join(sessionRoot, "session.lock"),
		profileRoot: join(fakeRoot, ".agent-warm-profile"),
		environment,
	}
}

function run(testFixture: Fixture, arguments_: string[]): Bun.ReadableSyncSubprocess {
	return Bun.spawnSync({
		cmd: [process.execPath, fixtureEntry, ...arguments_],
		cwd: packageRoot,
		env: testFixture.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
}

function output(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)}\n`
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8"))
}

function actions(testFixture: Fixture): Array<Record<string, unknown>> {
	const path = join(testFixture.fakeRoot, "actions.jsonl")
	return existsSync(path)
		? readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
		: []
}

function writePlan(testFixture: Fixture, plan: Record<string, unknown>): void {
	writeFileSync(join(testFixture.fakeRoot, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`)
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function expectError(
	result: Bun.ReadableSyncSubprocess,
	exitCode: 1 | 2 | 20 | 21 | 22,
	envelope: Record<string, unknown>,
): void {
	expect(result.exitCode).toBe(exitCode)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(output(envelope))
}

async function waitFor(path: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (existsSync(path)) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`test barrier did not appear: ${path}`)
}

test("help is one literal agent-native success envelope", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, productionEntry, "help", "--run-id", "help-run"],
		cwd: packageRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(0)
	expect(result.stdout.toString()).toBe(
		`${
			JSON.stringify({
				schemaVersion: 1,
				status: "ok",
				command: "help",
				resultCode: "HELP",
				runId: "help-run",
				transactionState: "unchanged",
				retrySafe: true,
				nextAction: "Run warm-browser start --run-id ID to create the Browser Session.",
				data: {
					usage: "warm-browser <help|start|status|stop> [--run-id ID] [--port NUMBER]",
					commands: [
						{ name: "help", sideEffects: "none" },
						{ name: "start", sideEffects: "starts one owned browser process group" },
						{ name: "status", sideEffects: "may remove proved stale private state" },
						{ name: "stop", sideEffects: "stops one verified owned browser process group" },
					],
				},
			})
		}\n`,
	)
	expect(result.stderr.toString()).toBe("")
})

test("production fixes the Agent Chrome Profile to HOME without predecessor overrides", () => {
	const expected = join(homedir(), ".agent-warm-profile")
	expect(productionAdapter.profileRoot()).toBe(expected)
	const source = readFileSync(
		resolve(packageRoot, "src/modules/warm-browser/production-adapter.ts"),
		"utf8",
	)
	expect(source).not.toContain("WARM_CHROME_PROFILE_DIR")
	expect(source).toContain('if (result.status !== 0) return { kind: "unverifiable" }')
	expect(source).toContain("commandHasArgument(processIdentity.commandLine, marker)")
	expect(source).toContain('"--password-store=basic"')
	expect(source).toContain('"--use-mock-keychain"')
})

test("production missing-executable spawn failure emits one redacted JSON line without a runtime stack", () => {
	const testFixture = fixture()
	const result = Bun.spawnSync({
		cmd: [process.execPath, productionChildProbe],
		cwd: packageRoot,
		env: testFixture.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
	expectError(result, 1, {
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
	expect(result.stderr.toString().trim().split("\n")).toHaveLength(1)
	expect(result.stderr.toString()).not.toContain("ENOENT")
	expect(existsSync(testFixture.lockPath)).toBe(false)
})

test("usage failure is one literal stderr envelope with exit 2", () => {
	const testFixture = fixture()
	const result = run(testFixture, ["open", "--run-id", "usage-run"])
	expectError(result, 2, {
		schemaVersion: 1,
		status: "error",
		command: "unknown",
		resultCode: "USAGE_ERROR",
		runId: "usage-run",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser help --run-id ID and correct the command arguments.",
		message: "Unknown Warm Browser command.",
	})
	expect(actions(testFixture)).toEqual([])
})

test("every non-macOS lifecycle command fails closed before private or browser effects", () => {
	for (const command of ["start", "status", "stop"] as const) {
		const testFixture = fixture({ platform: "linux" })
		const result = run(testFixture, [command, "--run-id", `${command}-linux`])
		expectError(result, 21, {
			schemaVersion: 1,
			status: "error",
			command,
			resultCode: "PLATFORM_UNSUPPORTED",
			runId: `${command}-linux`,
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Run Warm Browser on a supported macOS host.",
			message: "Warm Browser supports macOS only.",
		})
		expect(existsSync(testFixture.sessionRoot)).toBe(false)
		expect(actions(testFixture)).toEqual([])
	}
})

test("status and stop are idempotent when the Browser Session is absent", () => {
	const testFixture = fixture()
	const status = run(testFixture, ["status", "--run-id", "absent-status"])
	expect(status.exitCode).toBe(0)
	expect(status.stderr.toString()).toBe("")
	expect(status.stdout.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "ok",
			command: "status",
			resultCode: "SESSION_ABSENT",
			runId: "absent-status",
			transactionState: "unchanged",
			retrySafe: true,
			nextAction: "Run warm-browser start --run-id ID to create a Browser Session.",
			data: { postcondition: "absent" },
		}),
	)
	const stop = run(testFixture, ["stop", "--run-id", "absent-stop"])
	expect(stop.exitCode).toBe(0)
	expect(stop.stderr.toString()).toBe("")
	expect(stop.stdout.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "ok",
			command: "stop",
			resultCode: "SESSION_ABSENT",
			runId: "absent-stop",
			transactionState: "unchanged",
			retrySafe: true,
			nextAction: "Run warm-browser start --run-id ID when a Browser Session is needed.",
			data: { postcondition: "absent" },
		}),
	)
	expect(actions(testFixture)).toEqual([])
})

test("start, status, and stop own one private Browser Session through literal public results", () => {
	const testFixture = fixture()
	const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	const commandLine =
		`${executable} --user-data-dir=${testFixture.profileRoot} --profile-directory=Default --remote-debugging-address=127.0.0.1 --remote-debugging-port=9242 --agent-browser-launch-marker=session-1`

	const started = run(testFixture, ["start", "--run-id", "start-run"])
	expect(started.exitCode).toBe(0)
	expect(started.stderr.toString()).toBe("")
	expect(started.stdout.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "ok",
			command: "start",
			resultCode: "SESSION_STARTED",
			runId: "start-run",
			transactionState: "started",
			retrySafe: false,
			nextAction: "Run warm-browser status --run-id ID to inspect the Browser Session.",
			data: {
				sessionId: "session-1",
				startRunId: "start-run",
				processId: 4101,
				endpoint: { host: "127.0.0.1", port: 9242 },
				controlledPage: { targetId: "page-1" },
				postcondition: "running",
				recoveredFrom: null,
			},
		}),
	)
	expect(statSync(testFixture.sessionRoot).mode & 0o777).toBe(0o700)
	expect(statSync(testFixture.lockPath).mode & 0o777).toBe(0o700)
	expect(statSync(testFixture.sessionPath).mode & 0o777).toBe(0o600)
	expect(readJson(testFixture.sessionPath)).toEqual({
		schemaVersion: 1,
		phase: "running",
		sessionId: "session-1",
		startRunId: "start-run",
		launchMarker: "session-1",
		createdAtEpochMs: 1_800_000_000_000,
		profileRoot: testFixture.profileRoot,
		process: {
			pid: 4101,
			processGroupId: 4101,
			startedAtToken: "fixture-start-4101",
			executable,
			commandLine,
		},
		endpoint: {
			host: "127.0.0.1",
			port: 9242,
			browserVersion: "Chrome/151.0.7922.174",
			controlledPageTargetId: "page-1",
		},
	})

	const status = run(testFixture, ["status", "--run-id", "status-run"])
	expect(status.exitCode).toBe(0)
	expect(status.stderr.toString()).toBe("")
	expect(status.stdout.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "ok",
			command: "status",
			resultCode: "SESSION_RUNNING",
			runId: "status-run",
			transactionState: "unchanged",
			retrySafe: true,
			nextAction:
				"Continue with an implemented Agent Browser command or run warm-browser stop --run-id ID.",
			data: {
				sessionId: "session-1",
				startRunId: "start-run",
				processId: 4101,
				endpoint: { host: "127.0.0.1", port: 9242 },
				controlledPage: { targetId: "page-1" },
				postcondition: "running",
			},
		}),
	)

	const stopped = run(testFixture, ["stop", "--run-id", "stop-run"])
	expect(stopped.exitCode).toBe(0)
	expect(stopped.stderr.toString()).toBe("")
	expect(stopped.stdout.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "ok",
			command: "stop",
			resultCode: "SESSION_STOPPED",
			runId: "stop-run",
			transactionState: "stopped",
			retrySafe: true,
			nextAction: "Run warm-browser start --run-id ID when another Browser Session is needed.",
			data: { sessionId: "session-1", stoppedProcessId: 4101, postcondition: "absent" },
		}),
	)
	expect(existsSync(testFixture.sessionPath)).toBe(false)
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toEqual({
		spawnCount: 1,
		processes: [
			{
				pid: 4101,
				processGroupId: 4101,
				startedAtToken: "fixture-start-4101",
				executable,
				commandLine,
				alive: false,
			},
		],
	})
	expect(actions(testFixture)).toEqual([
		{ action: "spawn", pid: 4101, processGroupId: 4101, port: 9242 },
		{ action: "verify", pid: 4101, port: 9242 },
		{ action: "verify", pid: 4101, port: 9242 },
		{ action: "verify", pid: 4101, port: 9242 },
		{ action: "terminate", pid: 4101, processGroupId: 4101 },
	])
})

test("start applies one port override without creating a durable preference", () => {
	const testFixture = fixture()
	const started = run(testFixture, ["start", "--port", "9333", "--run-id", "override-run"])
	expect(started.exitCode).toBe(0)
	expect(started.stderr.toString()).toBe("")
	expect(JSON.parse(started.stdout.toString())).toEqual({
		schemaVersion: 1,
		status: "ok",
		command: "start",
		resultCode: "SESSION_STARTED",
		runId: "override-run",
		transactionState: "started",
		retrySafe: false,
		nextAction: "Run warm-browser status --run-id ID to inspect the Browser Session.",
		data: {
			sessionId: "session-1",
			startRunId: "override-run",
			processId: 4101,
			endpoint: { host: "127.0.0.1", port: 9333 },
			controlledPage: { targetId: "page-1" },
			postcondition: "running",
			recoveredFrom: null,
		},
	})
	expect(readJson(testFixture.sessionPath)).toMatchObject({ endpoint: { port: 9333 } })
	expect(actions(testFixture)).toEqual([
		{ action: "spawn", pid: 4101, processGroupId: 4101, port: 9333 },
		{ action: "verify", pid: 4101, port: 9333 },
	])
})

test("a verified owner refuses a concurrent start without another process", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "first-run"]).exitCode).toBe(0)
	const second = run(testFixture, ["start", "--run-id", "second-run"])
	expectError(second, 21, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode: "SESSION_ALREADY_RUNNING",
		runId: "second-run",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser status --run-id ID or warm-browser stop --run-id ID.",
		message: "A verified Browser Session already owns the Agent Chrome Profile.",
	})
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({ spawnCount: 1 })
	expect(actions(testFixture).filter((entry) => entry.action === "spawn")).toHaveLength(1)
})

test("simultaneous starts deterministically leave one owner and one transient refusal", async () => {
	const releasePath = join(tmpdir(), `warm-browser-release-${crypto.randomUUID()}`)
	temporaryRoots.push(releasePath)
	const testFixture = fixture({ holdVerificationUntil: releasePath })
	const first = Bun.spawn({
		cmd: [process.execPath, fixtureEntry, "start", "--run-id", "concurrent-first"],
		cwd: packageRoot,
		env: testFixture.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
	await waitFor(testFixture.sessionPath)
	const second = run(testFixture, ["start", "--run-id", "concurrent-second"])
	expectError(second, 22, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode: "START_IN_PROGRESS",
		runId: "concurrent-second",
		transactionState: "unchanged",
		retrySafe: true,
		nextAction: "Wait briefly, then run warm-browser status --run-id ID.",
		message: "The owned Warm Browser start transaction has not completed.",
	})
	writeFileSync(releasePath, "release\n")
	const [exitCode, stdout, stderr] = await Promise.all([
		first.exited,
		new Response(first.stdout).text(),
		new Response(first.stderr).text(),
	])
	expect(exitCode).toBe(0)
	expect(stderr).toBe("")
	expect(JSON.parse(stdout)).toMatchObject({
		command: "start",
		resultCode: "SESSION_STARTED",
		runId: "concurrent-first",
		data: { postcondition: "running" },
	})
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({ spawnCount: 1 })
	expect(statSync(testFixture.sessionPath).mode & 0o777).toBe(0o600)
})

test.each(
	[
		[
			"unavailable installed Chrome",
			{ chromeStatus: "unavailable" },
			20,
			"CHROME_UNAVAILABLE",
			"The fixed installed Google Chrome executable is unavailable.",
			"Install Google Chrome at the fixed macOS application path before retrying.",
		],
		[
			"unsafe profile",
			{ profileStatus: "unsafe" },
			21,
			"PROFILE_UNSAFE",
			"The Agent Chrome Profile ownership or permissions are unsafe.",
			"Repair the Agent Chrome Profile ownership and private permissions before retrying.",
		],
		[
			"ambiguous profile processes",
			{ profileProcessCount: 2 },
			20,
			"PROFILE_PROCESS_AMBIGUOUS",
			"More than one live process claims the Agent Chrome Profile.",
			"Inspect the profile process owners before retrying; Warm Browser will not signal them.",
		],
		[
			"unowned profile process",
			{ profileProcessCount: 1 },
			21,
			"PROFILE_IN_USE",
			"An unowned process is using the Agent Chrome Profile.",
			"Close the existing profile owner, then retry Warm Browser start.",
		],
	] as const,
)(
	"start refuses %s without signalling any process",
	(_name, plan, exitCode, resultCode, message, nextAction) => {
		const testFixture = fixture(plan)
		const result = run(testFixture, ["start", "--run-id", "profile-refusal"])
		expectError(result, exitCode, {
			schemaVersion: 1,
			status: "error",
			command: "start",
			resultCode,
			runId: "profile-refusal",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction,
			message,
		})
		expect(actions(testFixture)).toEqual([])
		expect(existsSync(testFixture.sessionPath)).toBe(false)
	},
)

test.each(
	[
		[
			"occupied",
			"PORT_OCCUPIED",
			"The requested loopback CDP port is already occupied.",
			"Inspect the port owner or choose one free start --port override.",
		],
		[
			"unverifiable",
			"PORT_UNVERIFIABLE",
			"Warm Browser could not prove that the requested CDP port is free.",
			"Inspect loopback port state before retrying.",
		],
	] as const,
)(
	"start fails closed when the requested port is %s",
	(portStatus, resultCode, message, nextAction) => {
		const testFixture = fixture({ portStatus })
		const result = run(testFixture, ["start", "--port", "9444", "--run-id", "port-refusal"])
		expectError(result, 20, {
			schemaVersion: 1,
			status: "error",
			command: "start",
			resultCode,
			runId: "port-refusal",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction,
			message,
		})
		expect(actions(testFixture)).toEqual([])
		expect(existsSync(testFixture.lockPath)).toBe(false)
	},
)

test.each(
	[
		[
			"browser_unverified",
			"CDP_IDENTITY_UNVERIFIED",
			"The launched Chrome CDP identity could not be verified.",
		],
		[
			"listener_unverified",
			"CDP_IDENTITY_UNVERIFIED",
			"The launched Chrome CDP identity could not be verified.",
		],
		[
			"controlled_page_unavailable",
			"CONTROLLED_PAGE_UNAVAILABLE",
			"The verified CDP endpoint exposes no Controlled Page.",
		],
		[
			"controlled_page_ambiguous",
			"CONTROLLED_PAGE_AMBIGUOUS",
			"The verified CDP endpoint exposes more than one page.",
		],
	] as const,
)("failed start rolls back process and state for %s", (endpointKind, resultCode, message) => {
	const testFixture = fixture({ endpointKind })
	const result = run(testFixture, ["start", "--run-id", "endpoint-failure"])
	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode,
		runId: "endpoint-failure",
		transactionState: "rolled_back",
		retrySafe: false,
		nextAction: "Inspect installed Chrome and the explicit CDP endpoint before retrying.",
		message,
	})
	expect(existsSync(testFixture.sessionPath)).toBe(false)
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: false }],
	})
	expect(actions(testFixture).map((entry) => entry.action)).toEqual([
		"spawn",
		"verify",
		"terminate",
	])
})

test("browser crash before CDP acknowledgement cleans the failed start", () => {
	const testFixture = fixture({ crashBeforeVerify: true, endpointKind: "browser_unverified" })
	const result = run(testFixture, ["start", "--run-id", "crash-run"])
	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode: "CDP_IDENTITY_UNVERIFIED",
		runId: "crash-run",
		transactionState: "rolled_back",
		retrySafe: false,
		nextAction: "Inspect installed Chrome and the explicit CDP endpoint before retrying.",
		message: "The launched Chrome CDP identity could not be verified.",
	})
	expect(existsSync(testFixture.sessionPath)).toBe(false)
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: false }],
	})
})

test("spawn failure removes the ownership claim and returns the unexpected exit class", () => {
	const testFixture = fixture({ spawnThrows: true })
	const result = run(testFixture, ["start", "--run-id", "spawn-failure"])
	expectError(result, 1, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode: "UNEXPECTED_FAILURE",
		runId: "spawn-failure",
		transactionState: "rolled_back",
		retrySafe: false,
		nextAction: "Inspect private state and the owned process group before retrying.",
		message: "Warm Browser start failed unexpectedly.",
	})
	expect(existsSync(testFixture.sessionPath)).toBe(false)
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(actions(testFixture)).toEqual([])
})

test("post-spawn identity-read failure cleans the adapter-owned process group before rollback", () => {
	const testFixture = fixture({ postSpawnIdentityReadFailure: true })
	const result = run(testFixture, ["start", "--run-id", "identity-read-failure"])
	expectError(result, 1, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode: "UNEXPECTED_FAILURE",
		runId: "identity-read-failure",
		transactionState: "rolled_back",
		retrySafe: false,
		nextAction: "Inspect private state and the owned process group before retrying.",
		message: "Warm Browser start failed unexpectedly.",
	})
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: false }],
	})
	expect(actions(testFixture).map((entry) => entry.action)).toEqual(["spawn", "terminate"])
	expect(existsSync(testFixture.sessionPath)).toBe(false)
	expect(existsSync(testFixture.lockPath)).toBe(false)
})

test("status recovers crashed-process state and reports its literal trigger and postcondition", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "crashed-start"]).exitCode).toBe(0)
	const ledgerPath = join(testFixture.fakeRoot, "processes.json")
	const processLedger = readJson(ledgerPath) as unknown as {
		spawnCount: number
		processes: Array<{ alive: boolean }>
	}
	processLedger.processes[0]!.alive = false
	writeJson(ledgerPath, processLedger)

	const status = run(testFixture, ["status", "--run-id", "crashed-status"])
	expect(status.exitCode).toBe(0)
	expect(status.stderr.toString()).toBe("")
	expect(status.stdout.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "ok",
			command: "status",
			resultCode: "STALE_SESSION_RECOVERED",
			runId: "crashed-status",
			transactionState: "recovered",
			retrySafe: true,
			nextAction: "Run warm-browser start --run-id ID to create a new Browser Session.",
			data: {
				trigger: "status",
				postcondition: "absent",
				removedState: true,
				stoppedOwnedProcess: false,
			},
		}),
	)
	expect(existsSync(testFixture.sessionPath)).toBe(false)
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(actions(testFixture).filter((entry) => entry.action === "terminate")).toEqual([])
})

test("an expired state-less lock is preserved because its process receipt cannot be reconstructed", () => {
	const testFixture = fixture()
	mkdirSync(testFixture.lockPath, { recursive: true, mode: 0o700 })
	utimesSync(testFixture.lockPath, new Date(1_799_999_970_000), new Date(1_799_999_970_000))
	const status = run(testFixture, ["status", "--run-id", "empty-lock-status"])
	expectError(status, 20, {
		schemaVersion: 1,
		status: "error",
		command: "status",
		resultCode: "PROCESS_IDENTITY_UNVERIFIED",
		runId: "empty-lock-status",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction:
			"Inspect the private lock and profile processes; Warm Browser will not remove or signal them.",
		message: "An expired ownership lock has no durable launch intent.",
	})
	expect(existsSync(testFixture.lockPath)).toBe(true)
	expect(actions(testFixture)).toEqual([])
})

test("unverified post-spawn cleanup preserves durable launch intent and live process for inspection", () => {
	const testFixture = fixture({
		postSpawnIdentityReadFailure: true,
		postSpawnCleanupUnverified: true,
	})
	const started = run(testFixture, ["start", "--run-id", "cleanup-unverified"])
	expectError(started, 1, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode: "UNEXPECTED_FAILURE",
		runId: "cleanup-unverified",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the durable launch intent and marker-matched processes before retrying.",
		message: "Warm Browser could not verify cleanup of its launched browser process group.",
	})
	expect(existsSync(testFixture.lockPath)).toBe(true)
	expect(readJson(testFixture.sessionPath)).toMatchObject({
		phase: "launching",
		sessionId: "session-1",
		launchMarker: "session-1",
	})
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: true }],
	})
	expect(actions(testFixture).map((entry) => entry.action)).toEqual(["spawn"])
})

test("an unexpected post-spawn failure reports rollback only after the owned group is stopped", () => {
	const testFixture = fixture({ verifyThrows: true })
	const result = run(testFixture, ["start", "--run-id", "post-spawn-rollback"])
	expectError(result, 1, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode: "UNEXPECTED_FAILURE",
		runId: "post-spawn-rollback",
		transactionState: "rolled_back",
		retrySafe: false,
		nextAction: "Inspect private state and the owned process group before retrying.",
		message: "Warm Browser start failed unexpectedly.",
	})
	expect(existsSync(testFixture.sessionPath)).toBe(false)
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: false }],
	})
	expect(actions(testFixture).map((entry) => entry.action)).toEqual(["spawn", "terminate"])
})

test("an unstoppable owned group after an unexpected failure never claims a rollback", () => {
	const testFixture = fixture({ verifyThrows: true, terminateFails: true })
	const result = run(testFixture, ["start", "--run-id", "post-spawn-unstoppable"])
	expectError(result, 1, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode: "UNEXPECTED_FAILURE",
		runId: "post-spawn-unstoppable",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the durable launch intent and marker-matched processes before retrying.",
		message: "Warm Browser could not verify cleanup of its launched browser process group.",
	})
	expect(readJson(testFixture.sessionPath)).toMatchObject({
		phase: "starting",
		sessionId: "session-1",
		launchMarker: "session-1",
		process: { pid: 4101, processGroupId: 4101 },
	})
	expect(existsSync(testFixture.lockPath)).toBe(true)
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: true }],
	})
	expect(actions(testFixture).map((entry) => entry.action)).toEqual(["spawn"])
})

test("status terminates only an exact stale starting owner before cleanup", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "stale-start"]).exitCode).toBe(0)
	const state = readJson(testFixture.sessionPath)
	state.phase = "starting"
	state.createdAtEpochMs = 1_799_999_980_000
	writeJson(testFixture.sessionPath, state)
	chmodSync(testFixture.sessionPath, 0o600)

	const status = run(testFixture, ["status", "--run-id", "stale-status"])
	expect(status.exitCode).toBe(0)
	expect(status.stderr.toString()).toBe("")
	expect(status.stdout.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "ok",
			command: "status",
			resultCode: "STALE_SESSION_RECOVERED",
			runId: "stale-status",
			transactionState: "recovered",
			retrySafe: true,
			nextAction: "Run warm-browser start --run-id ID to create a new Browser Session.",
			data: {
				trigger: "status",
				postcondition: "absent",
				removedState: true,
				stoppedOwnedProcess: true,
			},
		}),
	)
	expect(existsSync(testFixture.sessionPath)).toBe(false)
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: false }],
	})
	expect(actions(testFixture).at(-1)).toEqual({
		action: "terminate",
		pid: 4101,
		processGroupId: 4101,
	})
})

test("start recovers a crashed owner before publishing one new running postcondition", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "first-start"]).exitCode).toBe(0)
	const ledgerPath = join(testFixture.fakeRoot, "processes.json")
	const processLedger = readJson(ledgerPath) as unknown as {
		spawnCount: number
		processes: Array<{ alive: boolean }>
	}
	processLedger.processes[0]!.alive = false
	writeJson(ledgerPath, processLedger)

	const restarted = run(testFixture, ["start", "--run-id", "recovery-start"])
	expect(restarted.exitCode).toBe(0)
	expect(restarted.stderr.toString()).toBe("")
	expect(restarted.stdout.toString()).toBe(
		output({
			schemaVersion: 1,
			status: "ok",
			command: "start",
			resultCode: "SESSION_STARTED",
			runId: "recovery-start",
			transactionState: "started",
			retrySafe: false,
			nextAction: "Run warm-browser status --run-id ID to inspect the Browser Session.",
			data: {
				sessionId: "session-2",
				startRunId: "recovery-start",
				processId: 4102,
				endpoint: { host: "127.0.0.1", port: 9242 },
				controlledPage: { targetId: "page-1" },
				postcondition: "running",
				recoveredFrom: "stale_session",
			},
		}),
	)
	const after = readJson(ledgerPath) as unknown as {
		spawnCount: number
		processes: Array<{ pid: number; alive: boolean }>
	}
	expect(after.spawnCount).toBe(2)
	expect(after.processes).toMatchObject([
		{ pid: 4101, alive: false },
		{ pid: 4102, alive: true },
	])
	expect(after.processes.filter((processIdentity) => processIdentity.alive)).toHaveLength(1)
})

test("wrong live process identity is preserved for inspection and never signalled", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "wrong-start"]).exitCode).toBe(0)
	const ledgerPath = join(testFixture.fakeRoot, "processes.json")
	const processLedger = readJson(ledgerPath) as unknown as {
		spawnCount: number
		processes: Array<{ startedAtToken: string; alive: boolean }>
	}
	processLedger.processes[0]!.startedAtToken = "reused-pid-start"
	writeJson(ledgerPath, processLedger)
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")

	const stopped = run(testFixture, ["stop", "--run-id", "wrong-stop"])
	expectError(stopped, 20, {
		schemaVersion: 1,
		status: "error",
		command: "stop",
		resultCode: "PROCESS_IDENTITY_UNVERIFIED",
		runId: "wrong-stop",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction:
			"Inspect the live process and private Warm Browser state; do not signal the stored process id.",
		message: "The stored browser process identity does not match the live process.",
	})
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expect(existsSync(testFixture.lockPath)).toBe(true)
	expect(processLedger.processes[0]!.alive).toBe(true)
	expect(actions(testFixture).filter((entry) => entry.action === "terminate")).toEqual([])
})

test("process-table uncertainty preserves the owned receipt and performs no terminate or spawn", () => {
	const testFixture = fixture()
	const started = run(testFixture, ["start", "--run-id", "uncertain-owner-start"])
	expect(started.exitCode).toBe(0)
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	const actionsBefore = actions(testFixture)
	writePlan(testFixture, { processInspectionUnverifiable: true })

	const result = run(testFixture, ["status", "--run-id", "uncertain-owner-status"])
	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "status",
		resultCode: "PROCESS_INSPECTION_UNVERIFIED",
		runId: "uncertain-owner-status",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the host process table and private Warm Browser state before retrying.",
		message: "Warm Browser could not verify the local process table.",
	})
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expect(actions(testFixture)).toEqual(actionsBefore)
})

test("profile process-table uncertainty refuses start before lock, spawn, or signal", () => {
	const testFixture = fixture({ profileProcessInspectionUnverifiable: true })
	const result = run(testFixture, ["start", "--run-id", "profile-uncertain"])
	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "start",
		resultCode: "PROCESS_INSPECTION_UNVERIFIED",
		runId: "profile-uncertain",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the host process table and private Warm Browser state before retrying.",
		message: "Warm Browser could not verify the local process table.",
	})
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(actions(testFixture)).toEqual([])
})

test("a running receipt whose exact launch marker disappears is preserved and never signalled", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "marker-prime"]).exitCode).toBe(0)
	const ledgerPath = join(testFixture.fakeRoot, "processes.json")
	const ledger = readJson(ledgerPath) as unknown as { processes: Array<{ commandLine: string }> }
	ledger.processes[0]!.commandLine = ledger.processes[0]!.commandLine.replace(
		" --agent-browser-launch-marker=session-1",
		"",
	)
	writeJson(ledgerPath, ledger)
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	const result = run(testFixture, ["stop", "--run-id", "marker-stop"])
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "PROCESS_IDENTITY_UNVERIFIED",
		transactionState: "unchanged",
	})
	expect(result.exitCode).toBe(20)
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expect(actions(testFixture).filter(({ action }) => action === "terminate")).toEqual([])
})

test("SIGKILL after fake spawn leaves durable intent that recovers exactly one marked owner", async () => {
	const barrier = join(tmpdir(), `warm-browser-never-release-${crypto.randomUUID()}`)
	const testFixture = fixture({ holdSpawnReturnUntil: barrier })
	const driver = Bun.spawn({
		cmd: [process.execPath, fixtureEntry, "start", "--run-id", "sigkill-start"],
		cwd: packageRoot,
		env: testFixture.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
	await waitFor(testFixture.sessionPath)
	await waitFor(join(testFixture.fakeRoot, "processes.json"))
	expect(readJson(testFixture.sessionPath)).toMatchObject({
		phase: "launching",
		sessionId: "session-1",
		launchMarker: "session-1",
	})
	driver.kill(9)
	await driver.exited

	const state = readJson(testFixture.sessionPath)
	state.createdAtEpochMs = 1_799_999_980_000
	writeJson(testFixture.sessionPath, state)
	chmodSync(testFixture.sessionPath, 0o600)
	writePlan(testFixture, {})
	const recovered = run(testFixture, ["status", "--run-id", "sigkill-recover"])
	expect(recovered.exitCode).toBe(0)
	expect(recovered.stdout.toString()).toBe(output({
		schemaVersion: 1,
		status: "ok",
		command: "status",
		resultCode: "STALE_SESSION_RECOVERED",
		runId: "sigkill-recover",
		transactionState: "recovered",
		retrySafe: true,
		nextAction: "Run warm-browser start --run-id ID to create a new Browser Session.",
		data: {
			trigger: "status",
			postcondition: "absent",
			removedState: true,
			stoppedOwnedProcess: true,
		},
	}))
	expect(recovered.stderr.toString()).toBe("")
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: false }],
	})
	expect(actions(testFixture).map(({ action }) => action)).toEqual(["spawn", "terminate"])
})

test("stale launch intent with confirmed absent marker cleans state without signalling", () => {
	const testFixture = fixture({
		postSpawnIdentityReadFailure: true,
		postSpawnCleanupUnverified: true,
	})
	expect(run(testFixture, ["start", "--run-id", "absent-marker-start"]).exitCode).toBe(1)
	const state = readJson(testFixture.sessionPath)
	state.createdAtEpochMs = 1_799_999_980_000
	writeJson(testFixture.sessionPath, state)
	chmodSync(testFixture.sessionPath, 0o600)
	const ledgerPath = join(testFixture.fakeRoot, "processes.json")
	const processLedger = readJson(ledgerPath) as unknown as { processes: Array<{ alive: boolean }> }
	processLedger.processes[0]!.alive = false
	writeJson(ledgerPath, processLedger)
	writePlan(testFixture, {})
	const result = run(testFixture, ["status", "--run-id", "absent-marker-status"])
	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		resultCode: "STALE_SESSION_RECOVERED",
		transactionState: "recovered",
		data: { trigger: "status", postcondition: "absent", stoppedOwnedProcess: false },
	})
	expect(actions(testFixture).filter(({ action }) => action === "terminate")).toEqual([])
	expect(existsSync(testFixture.lockPath)).toBe(false)
})

test("stale launch marker query uncertainty preserves intent and performs no signal", () => {
	const testFixture = fixture({
		postSpawnIdentityReadFailure: true,
		postSpawnCleanupUnverified: true,
	})
	expect(run(testFixture, ["start", "--run-id", "launch-query-start"]).exitCode).toBe(1)
	const state = readJson(testFixture.sessionPath)
	state.createdAtEpochMs = 1_799_999_980_000
	writeJson(testFixture.sessionPath, state)
	chmodSync(testFixture.sessionPath, 0o600)
	writePlan(testFixture, { launchProcessInspectionUnverifiable: true })
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	const result = run(testFixture, ["status", "--run-id", "launch-query-status"])
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "PROCESS_INSPECTION_UNVERIFIED",
		transactionState: "unchanged",
	})
	expect(result.exitCode).toBe(20)
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expect(actions(testFixture).filter(({ action }) => action === "terminate")).toEqual([])
})

test("stale launch recovery re-scans the exact marker immediately before signalling", () => {
	const testFixture = fixture({
		postSpawnIdentityReadFailure: true,
		postSpawnCleanupUnverified: true,
		launchProcessSecondQueryCount: 2,
	})
	expect(run(testFixture, ["start", "--run-id", "rescan-start"]).exitCode).toBe(1)
	const state = readJson(testFixture.sessionPath)
	state.createdAtEpochMs = 1_799_999_980_000
	writeJson(testFixture.sessionPath, state)
	chmodSync(testFixture.sessionPath, 0o600)
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	const result = run(testFixture, ["status", "--run-id", "rescan-status"])
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "LAUNCH_PROCESS_AMBIGUOUS",
		message: "The stale launch marker changed before cleanup.",
	})
	expect(result.exitCode).toBe(20)
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expect(actions(testFixture).filter(({ action }) => action === "terminate")).toEqual([])
})

test("malformed stale launch intent is preserved as unsafe state without process inspection", () => {
	const testFixture = fixture({
		postSpawnIdentityReadFailure: true,
		postSpawnCleanupUnverified: true,
	})
	expect(run(testFixture, ["start", "--run-id", "malformed-start"]).exitCode).toBe(1)
	const state = readJson(testFixture.sessionPath)
	state.createdAtEpochMs = 1_799_999_980_000
	state.launchMarker = "invalid marker with spaces"
	writeJson(testFixture.sessionPath, state)
	chmodSync(testFixture.sessionPath, 0o600)
	const actionsBefore = actions(testFixture)
	const result = run(testFixture, ["status", "--run-id", "malformed-status"])
	expect(JSON.parse(result.stderr.toString())).toMatchObject({ resultCode: "STATE_UNSAFE" })
	expect(result.exitCode).toBe(20)
	expect(existsSync(testFixture.sessionPath)).toBe(true)
	expect(actions(testFixture)).toEqual(actionsBefore)
})

test.each(["ambiguous", "mismatched"] as const)(
	"stale launch intent with %s marked identity is preserved without signalling",
	(shape) => {
		const testFixture = fixture({
			postSpawnIdentityReadFailure: true,
			postSpawnCleanupUnverified: true,
		})
		expect(run(testFixture, ["start", "--run-id", `${shape}-launch-start`]).exitCode).toBe(1)
		const state = readJson(testFixture.sessionPath)
		state.createdAtEpochMs = 1_799_999_980_000
		writeJson(testFixture.sessionPath, state)
		chmodSync(testFixture.sessionPath, 0o600)
		if (shape === "ambiguous") {
			writePlan(testFixture, { launchProcessCountOverride: 2 })
		} else {
			const ledgerPath = join(testFixture.fakeRoot, "processes.json")
			const processLedger = readJson(ledgerPath) as unknown as {
				processes: Array<{ commandLine: string }>
			}
			processLedger.processes[0]!.commandLine = processLedger.processes[0]!.commandLine.replace(
				testFixture.profileRoot,
				`${testFixture.profileRoot}-wrong`,
			)
			writeJson(ledgerPath, processLedger)
			writePlan(testFixture, {})
		}
		const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
		const result = run(testFixture, ["status", "--run-id", `${shape}-launch-status`])
		expect(result.exitCode).toBe(20)
		expect(JSON.parse(result.stderr.toString())).toMatchObject({
			status: "error",
			command: "status",
			resultCode: shape === "ambiguous"
				? "LAUNCH_PROCESS_AMBIGUOUS"
				: "PROCESS_IDENTITY_UNVERIFIED",
			transactionState: "unchanged",
		})
		expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
		expect(actions(testFixture).filter(({ action }) => action === "terminate")).toEqual([])
	},
)

test("start reports recovered transaction when later occupied-port inspection refuses", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "recovered-port-prime"]).exitCode).toBe(0)
	const ledgerPath = join(testFixture.fakeRoot, "processes.json")
	const processLedger = readJson(ledgerPath) as unknown as { processes: Array<{ alive: boolean }> }
	processLedger.processes[0]!.alive = false
	writeJson(ledgerPath, processLedger)
	writePlan(testFixture, { portStatus: "occupied" })
	const result = run(testFixture, ["start", "--run-id", "recovered-port-start"])
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		status: "error",
		command: "start",
		resultCode: "PORT_OCCUPIED",
		runId: "recovered-port-start",
		transactionState: "recovered",
	})
	expect(result.exitCode).toBe(20)
	expect(existsSync(testFixture.lockPath)).toBe(false)
})

test("unverifiable running CDP identity preserves the exact owned process for inspection", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "identity-start"]).exitCode).toBe(0)
	writePlan(testFixture, { endpointKind: "browser_unverified" })
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")

	const status = run(testFixture, ["status", "--run-id", "identity-status"])
	expectError(status, 20, {
		schemaVersion: 1,
		status: "error",
		command: "status",
		resultCode: "CDP_IDENTITY_UNVERIFIED",
		runId: "identity-status",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the Browser Session with its owned process still preserved.",
		message: "The stored CDP endpoint identity could not be verified.",
	})
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: true }],
	})
	expect(actions(testFixture).filter((entry) => entry.action === "terminate")).toEqual([])
})

test("unsafe private state fails closed without browser effects", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["status", "--run-id", "state-prime"]).exitCode).toBe(0)
	chmodSync(testFixture.sessionRoot, 0o755)
	const status = run(testFixture, ["status", "--run-id", "state-unsafe"])
	expectError(status, 20, {
		schemaVersion: 1,
		status: "error",
		command: "status",
		resultCode: "STATE_UNSAFE",
		runId: "state-unsafe",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Repair the private XDG state ownership and permissions before retrying.",
		message: "Warm Browser private state is unsafe or unreadable.",
	})
	expect(actions(testFixture)).toEqual([])
})

test.each([0o500, 0o1700] as const)(
	"state root mode %o is rejected because private directories require exact 0700",
	(mode) => {
		const testFixture = fixture()
		expect(run(testFixture, ["status", "--run-id", "state-mode-prime"]).exitCode).toBe(0)
		chmodSync(testFixture.sessionRoot, mode)
		const result = run(testFixture, ["status", "--run-id", `state-mode-${mode}`])
		expect(JSON.parse(result.stderr.toString())).toMatchObject({ resultCode: "STATE_UNSAFE" })
		expect(result.exitCode).toBe(20)
		expect(actions(testFixture)).toEqual([])
	},
)

test.each(["file", "symlink", "permissive-directory"] as const)(
	"an unsafe %s ownership lock is preserved and rejected before browser effects",
	(lockShape) => {
		const testFixture = fixture()
		expect(run(testFixture, ["status", "--run-id", `prime-${lockShape}`]).exitCode).toBe(0)
		if (lockShape === "file") {
			writeFileSync(testFixture.lockPath, "unsafe lock\n", { mode: 0o600 })
		} else if (lockShape === "symlink") {
			const target = join(testFixture.root, "lock-target")
			mkdirSync(target, { mode: 0o700 })
			symlinkSync(target, testFixture.lockPath)
		} else {
			mkdirSync(testFixture.lockPath, { mode: 0o755 })
			chmodSync(testFixture.lockPath, 0o755)
		}
		const status = run(testFixture, ["status", "--run-id", `unsafe-${lockShape}`])
		expectError(status, 20, {
			schemaVersion: 1,
			status: "error",
			command: "status",
			resultCode: "STATE_UNSAFE",
			runId: `unsafe-${lockShape}`,
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Repair the private XDG state ownership and permissions before retrying.",
			message: "Warm Browser private state is unsafe or unreadable.",
		})
		expect(existsSync(testFixture.lockPath)).toBe(true)
		expect(actions(testFixture)).toEqual([])
	},
)

test.each([0o500, 0o1700] as const)(
	"ownership lock mode %o is preserved and rejected because exact 0700 is required",
	(mode) => {
		const testFixture = fixture()
		mkdirSync(testFixture.sessionRoot, { recursive: true, mode: 0o700 })
		chmodSync(testFixture.sessionRoot, 0o700)
		mkdirSync(testFixture.lockPath, { mode: 0o700 })
		chmodSync(testFixture.lockPath, mode)
		const result = run(testFixture, ["status", "--run-id", `lock-mode-${mode}`])
		expect(JSON.parse(result.stderr.toString())).toMatchObject({ resultCode: "STATE_UNSAFE" })
		expect(result.exitCode).toBe(20)
		expect(statSync(testFixture.lockPath).mode & 0o7777).toBe(mode)
		expect(actions(testFixture)).toEqual([])
	},
)

test.each(["0400", "04600", "symlink"] as const)(
	"session receipt shape %s is preserved and rejected because exact regular 0600 is required",
	(shape) => {
		const testFixture = fixture()
		expect(run(testFixture, ["start", "--run-id", `receipt-${shape}-prime`]).exitCode).toBe(0)
		if (shape === "symlink") {
			const target = join(testFixture.root, "receipt-target")
			writeFileSync(target, readFileSync(testFixture.sessionPath), { mode: 0o600 })
			rmSync(testFixture.sessionPath)
			symlinkSync(target, testFixture.sessionPath)
		} else {
			chmodSync(testFixture.sessionPath, shape === "0400" ? 0o400 : 0o4600)
		}
		const actionsBefore = actions(testFixture)
		const result = run(testFixture, ["status", "--run-id", `receipt-${shape}-status`])
		expect(JSON.parse(result.stderr.toString())).toMatchObject({ resultCode: "STATE_UNSAFE" })
		expect(result.exitCode).toBe(20)
		expect(existsSync(testFixture.sessionPath)).toBe(true)
		expect(actions(testFixture)).toEqual(actionsBefore)
	},
)

test("lock-removal failure preserves the process identity receipt after stopping the exact owner", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "cleanup-start"]).exitCode).toBe(0)
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	writeFileSync(join(testFixture.lockPath, "unexpected-entry"), "preserve receipt\n", {
		mode: 0o600,
	})
	const stopped = run(testFixture, ["stop", "--run-id", "cleanup-stop"])
	expectError(stopped, 1, {
		schemaVersion: 1,
		status: "error",
		command: "stop",
		resultCode: "UNEXPECTED_FAILURE",
		runId: "cleanup-stop",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect private Warm Browser state before retrying.",
		message: "Warm Browser failed unexpectedly.",
	})
	const tombstone = join(testFixture.sessionRoot, ".cleanup-session-1")
	expect(readFileSync(join(tombstone, "session.json"), "utf8")).toBe(stateBefore)
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(statSync(join(tombstone, "session.json")).mode & 0o7777).toBe(0o600)
	expect(readJson(join(testFixture.fakeRoot, "processes.json"))).toMatchObject({
		processes: [{ alive: false }],
	})
	expect(actions(testFixture).at(-1)).toEqual({
		action: "terminate",
		pid: 4101,
		processGroupId: 4101,
	})
})
