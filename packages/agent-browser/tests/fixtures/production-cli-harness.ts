import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * The single harness for running the real Warm Browser CLI with only the
 * Module's private `host-effects` seam substituted. The production entry,
 * argument parser, fixed Adapter, argument list, process-table parser, private
 * state rules, and result vocabulary all stay real; the Agent Chrome Profile
 * and private XDG state are real directories this harness owns.
 */

export const packageRoot = resolve(import.meta.dir, "../..")
export const productionEntry = resolve(packageRoot, "src/main.ts")
export const preloadEntry = resolve(import.meta.dir, "production-seams-preload.ts")
export const installedChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export const startedAtToken = "Thu Aug 27 09:52:01 2026"

const probeRoots: string[] = []

export interface ProductionCliProbe {
	readonly root: string
	readonly fakeRoot: string
	readonly sessionRoot: string
	readonly sessionPath: string
	readonly lockPath: string
	readonly profileRoot: string
	readonly home: string
	readonly environment: Record<string, string>
}

export function productionCliProbe(plan: Record<string, unknown> = {}): ProductionCliProbe {
	const root = mkdtempSync(join(tmpdir(), "warm-browser-production-cli-"))
	probeRoots.push(root)
	chmodSync(root, 0o700)
	const fakeRoot = join(root, "fake")
	const stateHome = join(root, "state")
	const home = join(root, "home")
	// The Agent Chrome Profile the production Adapter fixes, rebuilt under the
	// probe's own HOME. Its path carries spaces, exactly as the real one does, so
	// every production-CLI test here runs the argument list, the process-table
	// reading, and the receipt rules against a space-containing profile root.
	const profileRoot = join(
		home,
		"Library",
		"Application Support",
		"Agent Chrome",
		"Chrome User Data",
	)
	for (const directory of [fakeRoot, stateHome, home, profileRoot, join(profileRoot, "Default")]) {
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		chmodSync(directory, 0o700)
	}
	// Private Delivery resolves its one credential wrapper under the caller's
	// home directory, and the probe owns that home. The file here is inert: the
	// credential-effects seam is substituted, so it is never executed. It exists
	// so the wrapper-path proof is about a real owned executable file, and so no
	// test can ever depend on the real dotfiles wrapper.
	const wrapperDirectory = join(home, "code", "dotfiles", "bin")
	mkdirSync(wrapperDirectory, { recursive: true, mode: 0o700 })
	const wrapperPath = join(wrapperDirectory, "with-one-password-token")
	writeFileSync(wrapperPath, "#!/bin/sh\n# inert test wrapper; never executed\nexit 70\n", {
		mode: 0o700,
	})
	chmodSync(wrapperPath, 0o700)
	const environment = { ...process.env } as Record<string, string>
	delete environment.AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED
	environment.WARM_BROWSER_FIXTURE_ROOT = fakeRoot
	environment.XDG_STATE_HOME = stateHome
	environment.HOME = home
	const sessionRoot = join(stateHome, "my-second-brain", "warm-browser")
	const probe: ProductionCliProbe = {
		root,
		fakeRoot,
		sessionRoot,
		sessionPath: join(sessionRoot, "session.lock", "session.json"),
		lockPath: join(sessionRoot, "session.lock"),
		profileRoot,
		home,
		environment,
	}
	writeHostEffectsPlan(probe, plan)
	return probe
}

export function removeProductionCliProbes(): void {
	for (const root of probeRoots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export function writeHostEffectsPlan(
	probe: ProductionCliProbe,
	plan: Record<string, unknown>,
): void {
	writeFileSync(join(probe.fakeRoot, "host-effects.json"), `${JSON.stringify(plan, null, 2)}\n`)
}

export function runProductionCli(
	probe: ProductionCliProbe,
	arguments_: readonly string[],
): Bun.ReadableSyncSubprocess {
	return Bun.spawnSync({
		cmd: [process.execPath, "--preload", preloadEntry, productionEntry, ...arguments_],
		cwd: packageRoot,
		env: probe.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
}

export interface AsyncCliResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * Runs the production CLI as a real process without blocking this one.
 *
 * A test that owns a live loopback fixture has to keep answering that fixture
 * while the CLI runs, so it can never wait on a synchronous child: the child
 * would be dialling a server whose event loop this process is holding.
 *
 * `root` names the package the CLI is run from. It is the real package unless a
 * negative control is running the same scenario against a mutated copy.
 */
export async function runProductionCliAsync(
	probe: ProductionCliProbe,
	arguments_: readonly string[],
	root: string = packageRoot,
): Promise<AsyncCliResult> {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			"--preload",
			resolve(root, "tests/fixtures/production-seams-preload.ts"),
			resolve(root, "src/main.ts"),
			...arguments_,
		],
		cwd: root,
		env: probe.environment,
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	return { exitCode, stdout, stderr }
}

export function hostEffects(probe: ProductionCliProbe): Array<Record<string, unknown>> {
	const path = join(probe.fakeRoot, "actions.jsonl")
	return existsSync(path)
		? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
		: []
}

export function seedSessionState(probe: ProductionCliProbe, state: Record<string, unknown>): void {
	mkdirSync(probe.lockPath, { recursive: true, mode: 0o700 })
	chmodSync(probe.lockPath, 0o700)
	writeFileSync(probe.sessionPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
	chmodSync(probe.sessionPath, 0o600)
}

/** Formats one `ps -axo pid=,pgid=,lstart=,command=` row. */
export function processRow(
	pid: string,
	processGroupId: string,
	command: string,
	token = startedAtToken,
): string {
	return `${pid.padStart(5)} ${processGroupId.padStart(5)} ${token} ${command}\n`
}

/** Two unrelated rows every reading carries, so no reading is ever empty. */
export const systemRows = `${processRow("1", "1", "/sbin/launchd")}${
	processRow("412", "412", "/usr/libexec/UserEventAgent (Aqua)")
}`

export function verifiedReading(stdout: string): Record<string, unknown> {
	return { status: 0, signal: null, failed: false, stdout }
}

export { expectError, expectRefusal } from "./cli-refusals"
