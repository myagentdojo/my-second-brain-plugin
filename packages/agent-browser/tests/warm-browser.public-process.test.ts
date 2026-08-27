import { afterEach, expect, test } from "bun:test"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { startingTimeoutMs } from "../src/modules/warm-browser/bounds"
import * as contractModule from "../src/modules/warm-browser/contract"
import { expectError, expectRefusal } from "./fixtures/cli-refusals"
import { commandVocabulary } from "../src/modules/warm-browser/contract"
import { productionAdapter } from "../src/modules/warm-browser/production-adapter"
import { runWarmBrowserCli } from "../src/modules/warm-browser/warm-browser"

const packageRoot = resolve(import.meta.dir, "..")
const productionEntry = resolve(packageRoot, "src/main.ts")
const driverPreload = resolve(import.meta.dir, "fixtures/warm-browser-driver.ts")
/** The clock the driver fixture reports. */
const fixtureNowEpochMs = 1_800_000_000_000
/**
 * An age comfortably past the staleness bound, derived from the bound itself so
 * these fixtures cannot silently stop being stale when the bound changes.
 */
const staleEpochMs = fixtureNowEpochMs - startingTimeoutMs - 60_000
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
		cmd: [process.execPath, "--preload", driverPreload, productionEntry, ...arguments_],
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

interface ProcessLedger {
	spawnCount: number
	processes: Array<{
		pid: number
		processGroupId: number
		startedAtToken: string
		executable: string
		commandLine: string
		alive: boolean
	}>
}

function ledgerPath(testFixture: Fixture): string {
	return join(testFixture.fakeRoot, "processes.json")
}

/** The driver fixture's own ledger of every process it has spawned. */
function readLedger(testFixture: Fixture): ProcessLedger {
	return readJson(ledgerPath(testFixture)) as unknown as ProcessLedger
}

/**
 * Applies one perturbation to that ledger, so each test states only the change
 * it depends on and never restates how the ledger is read and written.
 */
function perturbLedger(testFixture: Fixture, change: (ledger: ProcessLedger) => void): void {
	const ledger = readLedger(testFixture)
	change(ledger)
	writeJson(ledgerPath(testFixture), ledger)
}

/**
 * Ages the stored session receipt past the staleness bound and restores its
 * exact private mode. `patch` carries whatever else one test needs to change.
 */
function makeStateStale(testFixture: Fixture, patch: Record<string, unknown> = {}): void {
	writeJson(testFixture.sessionPath, {
		...readJson(testFixture.sessionPath),
		createdAtEpochMs: staleEpochMs,
		...patch,
	})
	chmodSync(testFixture.sessionPath, 0o600)
}

/**
 * Ages the receipt into a stale starting phase. A starting receipt carries no
 * verified endpoint, so the verification fields are dropped with the phase
 * rather than left behind on a state production would never write.
 */
function makeStartingStale(testFixture: Fixture): void {
	const endpoint = readJson(testFixture.sessionPath).endpoint as Record<string, unknown>
	makeStateStale(testFixture, {
		phase: "starting",
		endpoint: { host: endpoint.host, port: endpoint.port },
	})
}

/** The one spawned process and whether the driver fixture still reports it alive. */
function expectSoleProcessAlive(testFixture: Fixture, alive: boolean): void {
	expect(readJson(ledgerPath(testFixture))).toMatchObject({ processes: [{ alive }] })
}

/** No owned browser process group was signalled. */
function expectNoTerminate(testFixture: Fixture): void {
	expect(actions(testFixture).filter(({ action }) => action === "terminate")).toEqual([])
}

async function waitFor(path: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (existsSync(path)) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`test barrier did not appear: ${path}`)
}

/**
 * Waits for a document another process is writing to be readable in full. A
 * receipt caught mid-write exists but does not parse, so existence alone is not
 * the barrier these tests need.
 */
async function waitForJson(path: string): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (existsSync(path)) {
			try {
				return readJson(path)
			} catch {
				// Still being written; poll again rather than read a partial document.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`test barrier never produced a readable document: ${path}`)
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
						{
							name: "start",
							sideEffects:
								"may stop a proved stale owned browser process group, then starts one owned browser process group",
						},
						{
							name: "status",
							sideEffects:
								"may stop a proved stale owned browser process group and remove its private state",
						},
						{ name: "stop", sideEffects: "stops one verified owned browser process group" },
					],
				},
			})
		}\n`,
	)
	expect(result.stderr.toString()).toBe("")
})

test("help states every side effect each command can actually have", () => {
	// Independent oracle: the side effects restated by hand. Nothing here is
	// derived from the production vocabulary, so a vocabulary that stopped
	// naming an effect it has would disagree with this list rather than match it.
	const expectedSideEffects = [
		["help", "none"],
		[
			"start",
			"may stop a proved stale owned browser process group, then starts one owned browser process group",
		],
		["status", "may stop a proved stale owned browser process group and remove its private state"],
		["stop", "stops one verified owned browser process group"],
	] as const
	const result = Bun.spawnSync({
		cmd: [process.execPath, productionEntry, "help", "--run-id", "effects-run"],
		cwd: packageRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	const commands = (JSON.parse(result.stdout.toString()).data as {
		commands: Array<{ name: string; sideEffects: string }>
	}).commands

	expect(commands.map(({ name, sideEffects }) => [name, sideEffects])).toEqual(
		expectedSideEffects.map((entry) => [...entry]),
	)
	// The two commands that can signal say so, because both can recover a stale
	// session and that recovery stops an owned process group.
	for (const name of ["start", "status"] as const) {
		const advertised = commands.find((command) => command.name === name)?.sideEffects ?? ""
		expect(advertised, name).toContain("stop a proved stale owned browser process group")
	}
})

test("help usage names every command from the single Command Vocabulary owner", () => {
	// Independent oracle: the sealed Command Vocabulary, restated by hand.
	const expectedNames = ["help", "start", "status", "stop"] as const
	const result = Bun.spawnSync({
		cmd: [process.execPath, productionEntry, "help", "--run-id", "usage-run"],
		cwd: packageRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	const usage = (JSON.parse(result.stdout.toString()).data as { usage: string }).usage

	expect(usage).toBe("warm-browser <help|start|status|stop> [--run-id ID] [--port NUMBER]")
	expect(usage.slice("warm-browser <".length, usage.indexOf(">")).split("|")).toEqual([
		...expectedNames,
	])
	// The domain comes from the vocabulary; the expected value never does.
	expect(commandVocabulary.map(({ name }) => name)).toEqual([...expectedNames])
	// One owner: the usage command list is generated, never restated in source.
	const moduleSource = readFileSync(
		resolve(packageRoot, "src/modules/warm-browser/warm-browser.ts"),
		"utf8",
	)
	expect(moduleSource).not.toContain("help|start|status|stop")
})

test("production fixes the Agent Chrome Profile to HOME without predecessor overrides", () => {
	const expected = join(homedir(), ".agent-warm-profile")
	expect(productionAdapter.profileRoot()).toBe(expected)
	const source = readFileSync(
		resolve(packageRoot, "src/modules/warm-browser/production-adapter.ts"),
		"utf8",
	)
	expect(source).not.toContain("WARM_CHROME_PROFILE_DIR")
	expect(source).not.toContain("createProductionAdapter")
	expect(source).toContain("commandHasArgument(processIdentity.commandLine, marker)")
})

test("the production entry passes the argument list and selects no Adapter", () => {
	const entry = readFileSync(productionEntry, "utf8")
	expect(entry).toContain("runWarmBrowserCli(process.argv.slice(2))")
	// The entry names no Adapter at all, so there is nothing for it to select.
	expect(entry).not.toContain("Adapter")
	expect(entry).not.toContain("process.env")
})

test("the public entry accepts an argument list and no injected Adapter", () => {
	// One declared parameter: a caller has no second argument to pass.
	expect(runWarmBrowserCli).toHaveLength(1)
	const module = readFileSync(
		resolve(packageRoot, "src/modules/warm-browser/warm-browser.ts"),
		"utf8",
	)
	expect(module).toContain("export async function runWarmBrowserCli(arguments_: readonly string[])")
	// The one Adapter is bound inside the Module, never handed in.
	expect(module).toContain('import { productionAdapter } from "./production-adapter"')
})

test("the Warm Browser contract publishes no Adapter injection surface", () => {
	// Independent oracle: the exact contract surface a caller may depend on.
	const contractSource = readFileSync(
		resolve(packageRoot, "src/modules/warm-browser/contract.ts"),
		"utf8",
	)
	expect(contractSource).not.toContain("WarmBrowserAdapter")
	expect(Object.keys(contractModule).toSorted()).toEqual([
		"SpawnCleanupUnverifiedError",
		"commandVocabulary",
		"schemaVersion",
	])
	// The seam still exists, privately, and exactly one module declares it.
	const moduleRoot = resolve(packageRoot, "src/modules/warm-browser")
	const declaring = readdirSync(moduleRoot)
		.filter((entry) => entry.endsWith(".ts"))
		.filter((entry) =>
			readFileSync(join(moduleRoot, entry), "utf8").includes("interface WarmBrowserAdapter")
		)
	expect(declaring).toEqual(["adapter.ts"])
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
	// Independent oracle: the whole production launch, restated by hand.
	const commandLine = [
		executable,
		`--user-data-dir=${testFixture.profileRoot}`,
		"--profile-directory=Default",
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=9242",
		"--agent-browser-launch-marker=session-1",
		"--password-store=basic",
		"--use-mock-keychain",
		"--no-first-run",
		"--no-default-browser-check",
	].join(" ")

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
		launch: { executable, commandLine },
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
	expect(readJson(ledgerPath(testFixture))).toEqual({
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

	expect(run(testFixture, ["stop", "--run-id", "override-stop"]).exitCode).toBe(0)
	const restarted = run(testFixture, ["start", "--run-id", "default-run"])
	expect(restarted.exitCode).toBe(0)
	expect(restarted.stderr.toString()).toBe("")
	expect(JSON.parse(restarted.stdout.toString())).toMatchObject({
		command: "start",
		resultCode: "SESSION_STARTED",
		runId: "default-run",
		data: { sessionId: "session-2", endpoint: { host: "127.0.0.1", port: 9242 } },
	})
	expect(readJson(testFixture.sessionPath)).toMatchObject({ endpoint: { port: 9242 } })
	expect(actions(testFixture)).toEqual([
		{ action: "spawn", pid: 4101, processGroupId: 4101, port: 9333 },
		{ action: "verify", pid: 4101, port: 9333 },
		{ action: "verify", pid: 4101, port: 9333 },
		{ action: "terminate", pid: 4101, processGroupId: 4101 },
		{ action: "spawn", pid: 4102, processGroupId: 4102, port: 9242 },
		{ action: "verify", pid: 4102, port: 9242 },
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
	expect(readJson(ledgerPath(testFixture))).toMatchObject({ spawnCount: 1 })
	expect(actions(testFixture).filter((entry) => entry.action === "spawn")).toHaveLength(1)
})

test("simultaneous starts deterministically leave one owner and one transient refusal", async () => {
	const releasePath = join(tmpdir(), `warm-browser-release-${crypto.randomUUID()}`)
	temporaryRoots.push(releasePath)
	const testFixture = fixture({ holdVerificationUntil: releasePath })
	const first = Bun.spawn({
		cmd: [process.execPath, "--preload", driverPreload, productionEntry, "start", "--run-id", "concurrent-first"],
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
	expect(readJson(ledgerPath(testFixture))).toMatchObject({ spawnCount: 1 })
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
	expectSoleProcessAlive(testFixture, false)
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
	expectSoleProcessAlive(testFixture, false)
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
	expectSoleProcessAlive(testFixture, false)
	expect(actions(testFixture).map((entry) => entry.action)).toEqual(["spawn", "terminate"])
	expect(existsSync(testFixture.sessionPath)).toBe(false)
	expect(existsSync(testFixture.lockPath)).toBe(false)
})

test("status recovers crashed-process state and reports its literal trigger and postcondition", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "crashed-start"]).exitCode).toBe(0)
	perturbLedger(testFixture, (ledger) => {
		ledger.processes[0]!.alive = false
	})

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
	expectNoTerminate(testFixture)
})

test("an expired state-less lock is preserved because its process receipt cannot be reconstructed", () => {
	const testFixture = fixture()
	mkdirSync(testFixture.lockPath, { recursive: true, mode: 0o700 })
	utimesSync(testFixture.lockPath, new Date(staleEpochMs), new Date(staleEpochMs))
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
	expectSoleProcessAlive(testFixture, true)
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
	expectSoleProcessAlive(testFixture, false)
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
	expectSoleProcessAlive(testFixture, true)
	expect(actions(testFixture).map((entry) => entry.action)).toEqual(["spawn"])
})

test("status terminates only an exact stale starting owner before cleanup", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "stale-start"]).exitCode).toBe(0)
	makeStartingStale(testFixture)

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
	expectSoleProcessAlive(testFixture, false)
	expect(actions(testFixture).at(-1)).toEqual({
		action: "terminate",
		pid: 4101,
		processGroupId: 4101,
	})
})

test("start recovers a crashed owner before publishing one new running postcondition", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "first-start"]).exitCode).toBe(0)
	perturbLedger(testFixture, (ledger) => {
		ledger.processes[0]!.alive = false
	})

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
	const after = readLedger(testFixture)
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
	perturbLedger(testFixture, (ledger) => {
		ledger.processes[0]!.startedAtToken = "reused-pid-start"
	})
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
	expectSoleProcessAlive(testFixture, true)
	expectNoTerminate(testFixture)
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
	perturbLedger(testFixture, (ledger) => {
		ledger.processes[0]!.commandLine = ledger.processes[0]!.commandLine.replace(
			" --agent-browser-launch-marker=session-1",
			"",
		)
	})
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	const result = run(testFixture, ["stop", "--run-id", "marker-stop"])
	expectRefusal(result, 20, {
		resultCode: "PROCESS_IDENTITY_UNVERIFIED",
		transactionState: "unchanged",
	})
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expectNoTerminate(testFixture)
})

test("SIGKILL after fake spawn leaves durable intent that recovers exactly one marked owner", async () => {
	const barrier = join(tmpdir(), `warm-browser-never-release-${crypto.randomUUID()}`)
	const testFixture = fixture({ holdSpawnReturnUntil: barrier })
	const driver = Bun.spawn({
		cmd: [process.execPath, "--preload", driverPreload, productionEntry, "start", "--run-id", "sigkill-start"],
		cwd: packageRoot,
		env: testFixture.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
	await waitFor(ledgerPath(testFixture))
	expect(await waitForJson(testFixture.sessionPath)).toMatchObject({
		phase: "launching",
		sessionId: "session-1",
		launchMarker: "session-1",
	})
	driver.kill(9)
	await driver.exited

	makeStateStale(testFixture)
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
	expectSoleProcessAlive(testFixture, false)
	expect(actions(testFixture).map(({ action }) => action)).toEqual(["spawn", "terminate"])
})

test("stale launch intent with confirmed absent marker cleans state without signalling", () => {
	const testFixture = fixture({
		postSpawnIdentityReadFailure: true,
		postSpawnCleanupUnverified: true,
	})
	expect(run(testFixture, ["start", "--run-id", "absent-marker-start"]).exitCode).toBe(1)
	makeStateStale(testFixture)
	perturbLedger(testFixture, (ledger) => {
		ledger.processes[0]!.alive = false
	})
	writePlan(testFixture, {})
	const result = run(testFixture, ["status", "--run-id", "absent-marker-status"])
	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		resultCode: "STALE_SESSION_RECOVERED",
		transactionState: "recovered",
		data: { trigger: "status", postcondition: "absent", stoppedOwnedProcess: false },
	})
	expectNoTerminate(testFixture)
	expect(existsSync(testFixture.lockPath)).toBe(false)
})

test("stale launch marker query uncertainty preserves intent and performs no signal", () => {
	const testFixture = fixture({
		postSpawnIdentityReadFailure: true,
		postSpawnCleanupUnverified: true,
	})
	expect(run(testFixture, ["start", "--run-id", "launch-query-start"]).exitCode).toBe(1)
	makeStateStale(testFixture)
	writePlan(testFixture, { launchProcessInspectionUnverifiable: true })
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	const result = run(testFixture, ["status", "--run-id", "launch-query-status"])
	expectRefusal(result, 20, {
		resultCode: "PROCESS_INSPECTION_UNVERIFIED",
		transactionState: "unchanged",
	})
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expectNoTerminate(testFixture)
})

test("stale launch recovery re-scans the exact marker immediately before signalling", () => {
	const testFixture = fixture({
		postSpawnIdentityReadFailure: true,
		postSpawnCleanupUnverified: true,
		launchProcessSecondQueryCount: 2,
	})
	expect(run(testFixture, ["start", "--run-id", "rescan-start"]).exitCode).toBe(1)
	makeStateStale(testFixture)
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	const result = run(testFixture, ["status", "--run-id", "rescan-status"])
	expectRefusal(result, 20, {
		resultCode: "LAUNCH_PROCESS_AMBIGUOUS",
		message: "The stale launch marker changed before cleanup.",
	})
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expectNoTerminate(testFixture)
})

test("malformed stale launch intent is preserved as unsafe state without process inspection", () => {
	const testFixture = fixture({
		postSpawnIdentityReadFailure: true,
		postSpawnCleanupUnverified: true,
	})
	expect(run(testFixture, ["start", "--run-id", "malformed-start"]).exitCode).toBe(1)
	makeStateStale(testFixture, { launchMarker: "invalid marker with spaces" })
	const actionsBefore = actions(testFixture)
	const result = run(testFixture, ["status", "--run-id", "malformed-status"])
	expectRefusal(result, 20, { resultCode: "STATE_UNSAFE" })
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
		makeStateStale(testFixture)
		if (shape === "ambiguous") {
			writePlan(testFixture, { launchProcessCountOverride: 2 })
		} else {
			perturbLedger(testFixture, (ledger) => {
				ledger.processes[0]!.commandLine = ledger.processes[0]!.commandLine.replace(
					testFixture.profileRoot,
					`${testFixture.profileRoot}-wrong`,
				)
			})
			writePlan(testFixture, {})
		}
		const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
		const result = run(testFixture, ["status", "--run-id", `${shape}-launch-status`])
		expectRefusal(result, 20, {
			status: "error",
			command: "status",
			resultCode: shape === "ambiguous"
				? "LAUNCH_PROCESS_AMBIGUOUS"
				: "PROCESS_IDENTITY_UNVERIFIED",
			transactionState: "unchanged",
		})
		expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
		expectNoTerminate(testFixture)
	},
)

test("start reports recovered transaction when later occupied-port inspection refuses", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "recovered-port-prime"]).exitCode).toBe(0)
	perturbLedger(testFixture, (ledger) => {
		ledger.processes[0]!.alive = false
	})
	writePlan(testFixture, { portStatus: "occupied" })
	const result = run(testFixture, ["start", "--run-id", "recovered-port-start"])
	expectRefusal(result, 20, {
		status: "error",
		command: "start",
		resultCode: "PORT_OCCUPIED",
		runId: "recovered-port-start",
		transactionState: "recovered",
	})
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
	expectSoleProcessAlive(testFixture, true)
	expectNoTerminate(testFixture)
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
		expectRefusal(result, 20, { resultCode: "STATE_UNSAFE" })
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
		expectRefusal(result, 20, { resultCode: "STATE_UNSAFE" })
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
		expectRefusal(result, 20, { resultCode: "STATE_UNSAFE" })
		expect(existsSync(testFixture.sessionPath)).toBe(true)
		expect(actions(testFixture)).toEqual(actionsBefore)
	},
)

test("a stop whose cleanup fails reports the stop it performed and keeps repairable state", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "cleanup-start"]).exitCode).toBe(0)
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	writeFileSync(join(testFixture.lockPath, "unexpected-entry"), "preserve receipt\n", {
		mode: 0o600,
	})
	const stopped = run(testFixture, ["stop", "--run-id", "cleanup-stop"])
	expectError(stopped, 20, {
		schemaVersion: 1,
		status: "error",
		command: "stop",
		resultCode: "STATE_UNSAFE",
		runId: "cleanup-stop",
		transactionState: "stopped",
		retrySafe: false,
		nextAction:
			"Repair the retained private Warm Browser session state; the owned browser process group is already stopped.",
		message:
			"Warm Browser stopped the owned browser process group but could not remove its private session state.",
	})
	const tombstone = join(testFixture.sessionRoot, ".cleanup-session-1")
	expect(readFileSync(join(tombstone, "session.json"), "utf8")).toBe(stateBefore)
	expect(existsSync(testFixture.lockPath)).toBe(false)
	expect(statSync(join(tombstone, "session.json")).mode & 0o7777).toBe(0o600)
	expectSoleProcessAlive(testFixture, false)
	expect(actions(testFixture).at(-1)).toEqual({
		action: "terminate",
		pid: 4101,
		processGroupId: 4101,
	})

	const actionsAfterStop = actions(testFixture)
	const retried = run(testFixture, ["stop", "--run-id", "cleanup-retry"])
	expectError(retried, 20, {
		schemaVersion: 1,
		status: "error",
		command: "stop",
		resultCode: "STATE_UNSAFE",
		runId: "cleanup-retry",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Repair the private XDG state ownership and permissions before retrying.",
		message: "Warm Browser private state is unsafe or unreadable.",
	})
	expect(actions(testFixture)).toEqual(actionsAfterStop)
	expect(readFileSync(join(tombstone, "session.json"), "utf8")).toBe(stateBefore)
})

test("a stale starting cleanup whose state removal fails reports the stop it performed", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "stale-cleanup-start"]).exitCode).toBe(0)
	makeStartingStale(testFixture)
	writeFileSync(join(testFixture.lockPath, "unexpected-entry"), "preserve receipt\n", {
		mode: 0o600,
	})

	const status = run(testFixture, ["status", "--run-id", "stale-cleanup-status"])

	expectError(status, 20, {
		schemaVersion: 1,
		status: "error",
		command: "status",
		resultCode: "STATE_UNSAFE",
		runId: "stale-cleanup-status",
		transactionState: "stopped",
		retrySafe: false,
		nextAction:
			"Repair the retained private Warm Browser session state; the owned browser process group is already stopped.",
		message:
			"Warm Browser stopped the owned browser process group but could not remove its private session state.",
	})
	expectSoleProcessAlive(testFixture, false)
	expect(actions(testFixture).at(-1)).toEqual({
		action: "terminate",
		pid: 4101,
		processGroupId: 4101,
	})
	expect(
		existsSync(join(testFixture.sessionRoot, ".cleanup-session-1", "session.json")),
	).toBe(true)
})

test.each(
	[
		["status", "status", "argv-status"],
		["stop", "stop", "argv-stop"],
	] as const,
)(
	"%s never claims an owned process whose live argument list gained an argument",
	(_name, command, runId) => {
		const testFixture = fixture()
		expect(run(testFixture, ["start", "--run-id", `${runId}-prime`]).exitCode).toBe(0)
		perturbLedger(testFixture, (ledger) => {
			ledger.processes[0]!.commandLine += " --load-extension=/tmp/unowned"
		})
		const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
		const actionsBefore = actions(testFixture)

		const result = run(testFixture, [command, "--run-id", runId])

		expectError(result, 20, {
			schemaVersion: 1,
			status: "error",
			command,
			resultCode: "PROCESS_IDENTITY_UNVERIFIED",
			runId,
			transactionState: "unchanged",
			retrySafe: false,
			nextAction:
				"Inspect the live process and private Warm Browser state; do not signal the stored process id.",
			message: "The stored browser process identity does not match the live process.",
		})
		expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
		expect(existsSync(testFixture.lockPath)).toBe(true)
		expect(actions(testFixture)).toEqual(actionsBefore)
		expectSoleProcessAlive(testFixture, true)
	},
)

test("stale cleanup never signals a stale owner whose live argument list gained an argument", () => {
	const testFixture = fixture()
	expect(run(testFixture, ["start", "--run-id", "argv-stale-prime"]).exitCode).toBe(0)
	makeStartingStale(testFixture)
	perturbLedger(testFixture, (ledger) => {
		ledger.processes[0]!.commandLine += " --load-extension=/tmp/unowned"
	})
	const stateBefore = readFileSync(testFixture.sessionPath, "utf8")
	const actionsBefore = actions(testFixture)

	const status = run(testFixture, ["status", "--run-id", "argv-stale-status"])

	expectError(status, 20, {
		schemaVersion: 1,
		status: "error",
		command: "status",
		resultCode: "PROCESS_IDENTITY_UNVERIFIED",
		runId: "argv-stale-status",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction:
			"Inspect the live process and private Warm Browser state; do not signal the stored process id.",
		message: "The stored browser process identity does not match the live process.",
	})
	expect(readFileSync(testFixture.sessionPath, "utf8")).toBe(stateBefore)
	expect(actions(testFixture)).toEqual(actionsBefore)
	expectSoleProcessAlive(testFixture, true)

	// start refuses the same unproved ownership without launching a second group.
	const started = run(testFixture, ["start", "--run-id", "argv-stale-start"])
	expectRefusal(started, 20, {
		resultCode: "PROCESS_IDENTITY_UNVERIFIED",
		transactionState: "unchanged",
	})
	expect(readJson(ledgerPath(testFixture))).toMatchObject({ spawnCount: 1 })
	expect(actions(testFixture)).toEqual(actionsBefore)
})
