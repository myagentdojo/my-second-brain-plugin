import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createRequire } from "node:module"
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { chromium, type Browser } from "playwright-core"

const require = createRequire(import.meta.url)
const playwrightPackage = require("playwright-core/package.json") as { version?: unknown }

const schemaVersion = 1 as const
const proofCategory = "agent-browser-cdp-compatibility" as const
const expectedBunVersion = "1.4.0" as const
const expectedPlaywrightVersion = "1.62.1" as const
const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" as const
export const fixtureAcknowledgementVariable = "AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED" as const

interface ProofOptions {
	readonly runId: string
	readonly fixtureCloseBeforeConnect: boolean
}

interface ProofFailureEnvelope {
	readonly schemaVersion: typeof schemaVersion
	readonly ok: false
	readonly category: typeof proofCategory
	readonly runId: string
	readonly code: ProofFailureCode
	readonly message: string
	readonly retrySafe: boolean
	readonly nextAction: string
	readonly cleanup: {
		readonly browserProcessExited: boolean
		readonly fixtureRemoved: boolean
	}
}

type ProofFailureCode =
	| "USAGE_ERROR"
	| "FIXTURE_ACKNOWLEDGEMENT_REQUIRED"
	| "BUN_VERSION_MISMATCH"
	| "PLAYWRIGHT_VERSION_MISMATCH"
	| "PLATFORM_UNSUPPORTED"
	| "CHROME_NOT_INSTALLED"
	| "CHROME_VERSION_UNAVAILABLE"
	| "CHROME_LAUNCH_FAILED"
	| "CDP_ENDPOINT_UNAVAILABLE"
	| "CDP_TARGET_INVALID"
	| "CDP_CONNECT_FAILED"
	| "DEFAULT_CONTEXT_UNAVAILABLE"
	| "CLEANUP_FAILED"
	| "UNEXPECTED_PROOF_FAILURE"

class ProofFailure extends Error {
	constructor(
		readonly code: ProofFailureCode,
		message: string,
		readonly retrySafe: boolean,
		readonly nextAction: string,
	) {
		super(message)
	}
}

function optionValue(arguments_: readonly string[], name: string): string {
	const index = arguments_.indexOf(name)
	const value = index === -1 ? undefined : arguments_[index + 1]
	if (!value || value.startsWith("--")) {
		throw new ProofFailure("USAGE_ERROR", `${name} is required`, false, `Pass ${name} with a non-empty value.`)
	}
	return value
}

export function parseProofOptions(arguments_: readonly string[]): ProofOptions {
	const supported = new Set(["--run-id", "--fixture-close-before-connect", "--fixture-acknowledged"])
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (argument === undefined) continue
		if (!supported.has(argument)) {
			throw new ProofFailure(
				"USAGE_ERROR",
				`unknown option: ${argument}`,
				false,
				"Use only the documented compatibility-proof options.",
			)
		}
		if (argument === "--run-id") index += 1
	}
	const fixtureCloseBeforeConnect = arguments_.includes("--fixture-close-before-connect")
	if (fixtureCloseBeforeConnect && !arguments_.includes("--fixture-acknowledged")) {
		throw new ProofFailure(
			"USAGE_ERROR",
			"--fixture-acknowledged is required for the close-before-connect fixture",
			false,
			"Acknowledge the disposable failure fixture explicitly, then rerun it.",
		)
	}
	return {
		runId: optionValue(arguments_, "--run-id"),
		fixtureCloseBeforeConnect,
	}
}

export function realChromeFixtureAcknowledged(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return environment[fixtureAcknowledgementVariable] === "1"
}

function commandOutput(command: readonly string[]): string | undefined {
	const result = spawnSync(command[0]!, command.slice(1), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	})
	return result.status === 0 ? result.stdout.trim() : undefined
}

export function chromeLaunchArguments(profileRoot: string): string[] {
	return [
		"--headless=new",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-default-apps",
		"--disable-extensions",
		"--disable-sync",
		"--metrics-recording-only",
		"--no-default-browser-check",
		"--no-first-run",
		"--password-store=basic",
		"--use-mock-keychain",
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=0",
		`--user-data-dir=${profileRoot}`,
		"about:blank",
	]
}

function processGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0)
		return true
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH")
	}
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!processGroupAlive(pid)) return true
		await Bun.sleep(50)
	}
	return !processGroupAlive(pid)
}

async function terminateOwnedChrome(child: ChildProcess | undefined, force = false): Promise<boolean> {
	const pid = child?.pid
	if (pid === undefined || !processGroupAlive(pid)) return true
	if (force) {
		try {
			process.kill(-pid, "SIGKILL")
		} catch {
			// The bounded liveness check below owns the outcome.
		}
		return waitForProcessGroupExit(pid, 2_000)
	}
	try {
		process.kill(-pid, "SIGTERM")
	} catch {
		// The bounded liveness check below owns the outcome.
	}
	if (await waitForProcessGroupExit(pid, 5_000)) return true
	try {
		process.kill(-pid, "SIGKILL")
	} catch {
		// The bounded liveness check below owns the outcome.
	}
	return waitForProcessGroupExit(pid, 5_000)
}

async function readIndependentCdpTarget(endpoint: string): Promise<{
	browser: string
	protocolVersion: string
}> {
	const response = await fetch(`${endpoint}/json/version`, {
		signal: AbortSignal.timeout(1_000),
	})
	if (!response.ok) throw new Error("CDP version endpoint rejected the request")
	const value = (await response.json()) as Record<string, unknown>
	const browser = value.Browser
	const protocolVersion = value["Protocol-Version"]
	const webSocketDebuggerUrl = value.webSocketDebuggerUrl
	if (
		typeof browser !== "string" ||
		!browser.startsWith("Chrome/") ||
		typeof protocolVersion !== "string" ||
		typeof webSocketDebuggerUrl !== "string"
	) {
		throw new Error("CDP target metadata is incomplete")
	}
	const webSocketUrl = new URL(webSocketDebuggerUrl)
	const httpUrl = new URL(endpoint)
	if (webSocketUrl.hostname !== httpUrl.hostname || webSocketUrl.port !== httpUrl.port) {
		throw new Error("CDP target metadata identifies another endpoint")
	}
	return { browser, protocolVersion }
}

async function waitForCdpEndpoint(profileRoot: string, child: ChildProcess): Promise<string> {
	const activePortPath = join(profileRoot, "DevToolsActivePort")
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new ProofFailure(
				"CHROME_LAUNCH_FAILED",
				"Google Chrome exited before publishing its CDP endpoint",
				true,
				"Confirm installed stable Google Chrome can start with a disposable profile, then retry.",
			)
		}
		if (existsSync(activePortPath)) {
			const [portText] = readFileSync(activePortPath, "utf8").split(/\r?\n/)
			if (/^[1-9][0-9]{0,4}$/.test(portText ?? "")) {
				const port = Number(portText)
				if (port <= 65_535) return `http://127.0.0.1:${port}`
			}
		}
		await Bun.sleep(50)
	}
	throw new ProofFailure(
		"CDP_ENDPOINT_UNAVAILABLE",
		"Google Chrome did not publish a valid explicit CDP endpoint within the bounded wait",
		true,
		"Inspect the installed Chrome policy and retry the bounded compatibility proof.",
	)
}

function knownFailure(error: unknown): ProofFailure {
	return error instanceof ProofFailure
		? error
		: new ProofFailure(
				"UNEXPECTED_PROOF_FAILURE",
				"The compatibility proof failed without exposing raw process or browser diagnostics",
				false,
				"Inspect the private receipt and implementation locally before retrying.",
			)
}

export async function proveCdpCompatibility(options: ProofOptions): Promise<Record<string, unknown>> {
	let child: ChildProcess | undefined
	let browser: Browser | undefined
	let failure: ProofFailure | undefined
	let observation: Record<string, unknown> | undefined
	let fixtureRoot: string | undefined
	let browserProcessExited = true
	let fixtureRemoved = true

	try {
		if (!realChromeFixtureAcknowledged()) {
			throw new ProofFailure(
				"FIXTURE_ACKNOWLEDGEMENT_REQUIRED",
				`Real Chrome proof requires ${fixtureAcknowledgementVariable}=1`,
				false,
				`Set ${fixtureAcknowledgementVariable}=1 only for one reviewed, bounded Chrome proof.`,
			)
		}
		if (Bun.version !== expectedBunVersion) {
			throw new ProofFailure(
				"BUN_VERSION_MISMATCH",
				`Compatibility proof requires Bun ${expectedBunVersion}`,
				false,
				`Run the proof through the reviewed Bun ${expectedBunVersion} runtime.`,
			)
		}
		if (playwrightPackage.version !== expectedPlaywrightVersion) {
			throw new ProofFailure(
				"PLAYWRIGHT_VERSION_MISMATCH",
				`Compatibility proof requires playwright-core ${expectedPlaywrightVersion}`,
				false,
				"Restore the exact reviewed package and frozen lockfile, then retry.",
			)
		}
		if (process.platform !== "darwin" || process.arch !== "arm64") {
			throw new ProofFailure(
				"PLATFORM_UNSUPPORTED",
				"This bounded compatibility proof currently requires macOS arm64",
				false,
				"Run the proof on the approved macOS arm64 host.",
			)
		}
		if (!existsSync(chromeExecutable)) {
			throw new ProofFailure(
				"CHROME_NOT_INSTALLED",
				"Installed stable Google Chrome was not found at the approved macOS path",
				false,
				"Install stable Google Chrome through the machine-owned installation path, then retry.",
			)
		}
		const chromeVersionOutput = commandOutput([chromeExecutable, "--version"])
		const chromeVersion = /^Google Chrome ([0-9]+(?:\.[0-9]+){3})$/.exec(chromeVersionOutput ?? "")?.[1]
		if (chromeVersion === undefined) {
			throw new ProofFailure(
				"CHROME_VERSION_UNAVAILABLE",
				"Installed Google Chrome did not return its expected stable version identity",
				false,
				"Verify the stable Google Chrome executable identity, then retry.",
			)
		}

		fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-browser-cdp-")))
		chmodSync(fixtureRoot, 0o700)
		const profileRoot = join(fixtureRoot, "profile")
		child = spawn(
			chromeExecutable,
			chromeLaunchArguments(profileRoot),
			{
				detached: true,
				env: {
					HOME: fixtureRoot,
					LANG: "en_US.UTF-8",
					PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
					TMPDIR: fixtureRoot,
				},
				stdio: "ignore",
			},
		)
		child.unref()
		if (child.pid === undefined) {
			throw new ProofFailure(
				"CHROME_LAUNCH_FAILED",
				"Google Chrome launch returned no owned process identity",
				false,
				"Inspect the installed Chrome executable locally before retrying.",
			)
		}

		const endpoint = await waitForCdpEndpoint(profileRoot, child)
		let independentTarget: Awaited<ReturnType<typeof readIndependentCdpTarget>>
		try {
			independentTarget = await readIndependentCdpTarget(endpoint)
		} catch {
			throw new ProofFailure(
				"CDP_TARGET_INVALID",
				"The independently read CDP target did not identify the owned Google Chrome endpoint",
				true,
				"Confirm local Chrome remote-debugging policy and retry the bounded fixture.",
			)
		}

		if (options.fixtureCloseBeforeConnect) {
			if (!(await terminateOwnedChrome(child, true))) {
				throw new ProofFailure(
					"CLEANUP_FAILED",
					"The acknowledged failure fixture could not remove its owned Google Chrome process",
					false,
					"Remove the process identified in the private receipt before retrying.",
				)
			}
		}

		try {
			browser = await chromium.connectOverCDP(endpoint, {
				isLocal: true,
				noDefaults: true,
				timeout: options.fixtureCloseBeforeConnect ? 250 : 5_000,
			})
		} catch {
			throw new ProofFailure(
				"CDP_CONNECT_FAILED",
				"playwright-core could not attach to the independently verified explicit CDP endpoint",
				true,
				"Confirm the installed Chrome and playwright-core compatibility identities, then retry.",
			)
		}

		const contexts = browser.contexts()
		const defaultContext = contexts[0]
		if (contexts.length !== 1 || defaultContext === undefined) {
			throw new ProofFailure(
				"DEFAULT_CONTEXT_UNAVAILABLE",
				"playwright-core did not expose exactly one existing default Chrome context",
				false,
				"Recheck connectOverCDP default-context compatibility before Warm Browser implementation.",
			)
		}
		const pages = defaultContext.pages()
		if (pages.length === 0) {
			throw new ProofFailure(
				"DEFAULT_CONTEXT_UNAVAILABLE",
				"The existing default Chrome context exposed no Controlled Page candidate",
				false,
				"Recheck the bounded Chrome launch fixture before Warm Browser implementation.",
			)
		}

		const macosVersion = commandOutput(["/usr/bin/sw_vers", "-productVersion"])
		const macosBuild = commandOutput(["/usr/bin/sw_vers", "-buildVersion"])
		const endpointUrl = new URL(endpoint)
		observation = {
			schemaVersion,
			ok: true,
			category: proofCategory,
			runId: options.runId,
			bun: { version: Bun.version },
			playwright: { package: "playwright-core", version: playwrightPackage.version },
			chrome: { product: "Google Chrome", version: chromeVersion },
			macos: { version: macosVersion, build: macosBuild, arch: process.arch },
			endpoint: {
				scheme: endpointUrl.protocol.slice(0, -1),
				host: endpointUrl.hostname,
				port: Number(endpointUrl.port),
			},
			process: { pid: child.pid },
			independentTarget,
			playwrightObservation: {
				browserVersion: browser.version(),
				contextCount: contexts.length,
				defaultContextPageCount: pages.length,
			},
			browserDownloads: { packageFlavor: "no-browser", downloadedByProof: false },
		}
	} catch (error) {
		failure = knownFailure(error)
	} finally {
		if (browser !== undefined) {
			try {
				await browser.close()
			} catch {
				// Process-group cleanup below owns the terminal outcome.
			}
		}
		browserProcessExited = await terminateOwnedChrome(child)
		if (fixtureRoot !== undefined) {
			try {
				rmSync(fixtureRoot, { recursive: true, force: true })
				fixtureRemoved = !existsSync(fixtureRoot)
			} catch {
				fixtureRemoved = false
			}
		}
	}

	if (!browserProcessExited || !fixtureRemoved) {
		failure = new ProofFailure(
			"CLEANUP_FAILED",
			"The compatibility proof could not confirm complete fixture cleanup",
			false,
			"Remove the owned process or private fixture identified in the private receipt before retrying.",
		)
	}
	if (failure !== undefined) {
		const envelope: ProofFailureEnvelope = {
			schemaVersion,
			ok: false,
			category: proofCategory,
			runId: options.runId,
			code: failure.code,
			message: failure.message,
			retrySafe: failure.retrySafe,
			nextAction: failure.nextAction,
			cleanup: { browserProcessExited, fixtureRemoved },
		}
		throw Object.assign(failure, { envelope })
	}
	return {
		...observation,
		cleanup: { browserProcessExited, fixtureRemoved },
	}
}

function failureEnvelope(error: unknown, runId: string): ProofFailureEnvelope {
	if (error instanceof ProofFailure && "envelope" in error) {
		return error.envelope as ProofFailureEnvelope
	}
	const failure = knownFailure(error)
	return {
		schemaVersion,
		ok: false,
		category: proofCategory,
		runId,
		code: failure.code,
		message: failure.message,
		retrySafe: failure.retrySafe,
		nextAction: failure.nextAction,
		cleanup: { browserProcessExited: true, fixtureRemoved: true },
	}
}

if (import.meta.main) {
	let runId = "unparsed"
	try {
		const options = parseProofOptions(process.argv.slice(2))
		runId = options.runId
		console.log(JSON.stringify(await proveCdpCompatibility(options)))
	} catch (error) {
		console.error(JSON.stringify(failureEnvelope(error, runId)))
		process.exit(error instanceof ProofFailure && error.code === "USAGE_ERROR" ? 2 : 1)
	}
}
