import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { validateBunOnlyPayload } from "./build"
import { loadPluginConfig } from "./plugin-config"
import {
	type PayloadRelease,
	type PreparedPayloadDeclaration,
	type SourceIdentity,
	preparePluginPayload,
} from "./plugin-files"

/** Package name of the pinned Agent Plugin Kit; also the consumer link directory name. */
export const KIT_PACKAGE_NAME = "agent-plugin-kit"
/** Tracked maintenance entry inside the Kit checkout that owns the admitted process. */
export const KIT_ENTRY_RELATIVE_PATH = "src/adapters/maintenance-command-facade/maintenance.ts"
/** Default physical Kit checkout location relative to the consumer root (ignored by Git). */
export const KIT_CHECKOUT_RELATIVE_PATH = join(".dev", KIT_PACKAGE_NAME)
/** Environment variable naming an existing physical Kit checkout to link instead of provisioning. */
export const KIT_CHECKOUT_ENVIRONMENT = "AGENT_PLUGIN_KIT_CHECKOUT"
/** Outer guard for one Kit package process; above the Kit's own 30-second compressor deadline. */
export const KIT_PROCESS_GUARD_MS = 45_000
/** Guard for network provisioning steps: clone, fetch, and frozen dependency installation. */
export const KIT_PROVISION_GUARD_MS = 120_000
/** Exact refusal message the Kit projects when Source Checkout Admission fails. */
export const KIT_NOT_ADMITTED_MESSAGE = "Maintenance source checkout is not admitted."

const commitPattern = /^[0-9a-f]{40}$/
const hexDigestPattern = /^[0-9a-f]{64}$/
const pinPattern = /^git\+(https:\/\/[^#]+\.git)#([0-9a-f]{40})$/u
const runIdPattern = /[^A-Za-z0-9._-]/g

/** Committed consumer authority: the Kit origin and exact commit pinned in `package.json`. */
export interface KitPin {
	origin: string
	commit: string
}

/** The package request the Kit validates after Source Checkout Admission. */
export interface KitPackageRequest {
	repositoryRoot: string
	mode: "package"
	sourceIdentity: SourceIdentity
	release: PayloadRelease
	prepared: PreparedPayloadDeclaration
}

/** One published artifact as the Kit reported it, with a bare hex digest. */
export interface PackageArtifactRecord {
	path: string
	bytes: number
	sha256: string
}

/** Every outcome the consumer can observe from one Kit package process. */
export type PackageOutcome =
	| {
			kind: "packaged"
			exitCode: 0
			runId: string
			sourceIdentity: SourceIdentity
			release: PayloadRelease
			bindingSha256: string
			payloadSha256: string
			regularFiles: readonly string[]
			artifacts: { archive: PackageArtifactRecord; checksums: PackageArtifactRecord }
			envelope: Record<string, unknown>
	  }
	| {
			kind: "not-admitted" | "refused" | "partial" | "recovery" | "retry" | "failed"
			exitCode: number
			runId: string
			resultCode: string
			stationId: string
			transactionState: string
			message: string
			nextAction: unknown
			artifacts: { archive: PackageArtifactRecord | null; checksums: PackageArtifactRecord | null }
			envelope: Record<string, unknown> | null
			/** Raw process stderr. Private diagnostics; never print to the public stream. */
			diagnostics: string
	  }
	| {
			kind: "process-guard"
			exitCode: number | null
			runId: string
			signal: string | null
			diagnostics: string
	  }

/** Inputs for one real Kit process. */
export interface KitInvocation {
	consumerRoot: string
	entryPath: string
	request: KitPackageRequest
	runId: string
	environment?: NodeJS.ProcessEnv
	guardMs?: number
}

/** The seam through which every consumer caller reaches the Kit process. */
export type KitInvoker = (invocation: KitInvocation) => PackageOutcome

/** Collaborators the package flow composes; tests inject recorders here. */
export interface PackageDependencies {
	ensureKit: typeof ensureKitCheckout
	linkKit: typeof linkKitCheckout
	invokeKit: KitInvoker
}

/** Inputs for packaging one prepared plugin repository through the admitted Kit. */
export interface PackagePreparedPluginInput {
	consumerRoot: string
	repositoryRoot: string
	sourceIdentity: SourceIdentity
	release: PayloadRelease
	environment?: NodeJS.ProcessEnv
	runId?: string
}

interface ProcessResult {
	exitCode: number | null
	signal: string | null
	stdout: string
	stderr: string
}

function run(
	cmd: string[],
	options: { cwd: string; environment: NodeJS.ProcessEnv; guardMs: number; stdin?: Buffer },
): ProcessResult {
	const result = Bun.spawnSync({
		cmd,
		cwd: options.cwd,
		env: { ...options.environment, FORCE_COLOR: "0", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
		stdin: options.stdin ?? "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: options.guardMs,
		killSignal: "SIGKILL",
	})
	return {
		exitCode: result.signalCode ? null : result.exitCode,
		signal: result.signalCode ?? null,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	}
}

function git(
	root: string,
	arguments_: string[],
	environment: NodeJS.ProcessEnv,
	guardMs = KIT_PROCESS_GUARD_MS,
): ProcessResult {
	return run(["git", "-C", root, ...arguments_], { cwd: root, environment, guardMs })
}

function gitOutput(root: string, arguments_: string[], environment: NodeJS.ProcessEnv): string {
	const result = git(root, arguments_, environment)
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${arguments_[0]} failed in ${root}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
		)
	}
	return result.stdout.trim()
}

/**
 * Parse the Kit pin from a manifest object.
 *
 * @param manifest - Parsed `package.json` content
 * @returns The origin and commit, or undefined when absent or not `git+https://<origin>.git#<40 hex>`
 *
 * @example
 * ```ts
 * parseKitPin(JSON.parse(readFileSync("package.json", "utf8")))
 * ```
 */
export function parseKitPin(manifest: unknown): KitPin | undefined {
	if (typeof manifest !== "object" || manifest === null) return undefined
	const dependencies = (manifest as { dependencies?: unknown }).dependencies
	if (typeof dependencies !== "object" || dependencies === null) return undefined
	const value = (dependencies as Record<string, unknown>)[KIT_PACKAGE_NAME]
	if (typeof value !== "string") return undefined
	const match = pinPattern.exec(value)
	if (match?.[1] === undefined || match[2] === undefined) return undefined
	return { origin: match[1], commit: match[2] }
}

/**
 * Read the committed Kit pin: `package.json` at the consumer HEAD, which must also match the
 * working tree. This mirrors what Source Checkout Admission judges, so a request cannot
 * invent its authority.
 *
 * @param consumerRoot - Consumer Git repository root
 * @param environment - Process environment for Git
 * @returns The committed pin
 * @throws {Error} When the manifest is uncommitted, dirty, or lacks a canonical pin
 *
 * @example
 * ```ts
 * const pin = readCommittedKitPin(process.cwd())
 * ```
 */
export function readCommittedKitPin(
	consumerRoot: string,
	environment: NodeJS.ProcessEnv = process.env,
): KitPin {
	const head = git(consumerRoot, ["rev-parse", "--verify", "HEAD^{commit}"], environment)
	if (head.exitCode !== 0) {
		throw new Error(
			`Kit pin authority requires a committed package.json; ${consumerRoot} has no HEAD commit`,
		)
	}
	const manifest = git(consumerRoot, ["show", "HEAD:package.json"], environment)
	if (manifest.exitCode !== 0) {
		throw new Error("Kit pin authority requires package.json to be committed at HEAD")
	}
	const dirty = gitOutput(
		consumerRoot,
		["status", "--porcelain=v1", "--untracked-files=all", "--", "package.json"],
		environment,
	)
	if (dirty !== "") {
		throw new Error("package.json differs from HEAD; commit the Kit pin before packaging")
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(manifest.stdout)
	} catch {
		throw new Error("package.json at HEAD is not valid JSON")
	}
	const pin = parseKitPin(parsed)
	if (pin === undefined) {
		throw new Error(
			`package.json at HEAD must pin ${KIT_PACKAGE_NAME} as git+https://<origin>.git#<40-hex> in dependencies`,
		)
	}
	return pin
}

function kitManifestAtHead(checkoutRoot: string, environment: NodeJS.ProcessEnv): unknown {
	try {
		return JSON.parse(gitOutput(checkoutRoot, ["show", "HEAD:package.json"], environment))
	} catch (error) {
		throw new Error(
			`Kit checkout ${checkoutRoot} has no readable package.json at HEAD: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

function commitPresent(checkoutRoot: string, commit: string, environment: NodeJS.ProcessEnv): boolean {
	return git(checkoutRoot, ["cat-file", "-e", `${commit}^{commit}`], environment).exitCode === 0
}

function checkoutCommit(checkoutRoot: string, pin: KitPin, environment: NodeJS.ProcessEnv): void {
	if (!commitPresent(checkoutRoot, pin.commit, environment)) {
		const fetch = git(
			checkoutRoot,
			["fetch", "--quiet", "origin", pin.commit],
			environment,
			KIT_PROVISION_GUARD_MS,
		)
		if (fetch.exitCode !== 0) {
			throw new Error(`Kit commit ${pin.commit} is not available from ${pin.origin}`)
		}
	}
	const checkout = git(checkoutRoot, ["checkout", "--quiet", "--detach", pin.commit], environment)
	if (checkout.exitCode !== 0) {
		throw new Error(`Kit checkout ${checkoutRoot} cannot check out ${pin.commit}`)
	}
}

/**
 * Ensure a clean physical Kit checkout at the pinned commit with frozen dependencies.
 *
 * The location is `AGENT_PLUGIN_KIT_CHECKOUT` when set (it must already exist and match; it
 * is never mutated), otherwise `<consumerRoot>/.dev/agent-plugin-kit`, cloned from the pin
 * origin when absent and moved to the pinned commit when it points elsewhere.
 *
 * @param input - Consumer root, committed pin, and environment
 * @returns The checkout realpath
 * @throws {Error} When the checkout cannot be provisioned, is dirty, or is not the pinned Kit
 *
 * @example
 * ```ts
 * const checkout = ensureKitCheckout({ consumerRoot: process.cwd(), pin })
 * ```
 */
export function ensureKitCheckout(input: {
	consumerRoot: string
	pin: KitPin
	environment?: NodeJS.ProcessEnv
}): string {
	const environment = input.environment ?? process.env
	const explicit = environment[KIT_CHECKOUT_ENVIRONMENT]
	const checkoutRoot = explicit
		? resolve(explicit)
		: join(input.consumerRoot, KIT_CHECKOUT_RELATIVE_PATH)
	if (!existsSync(checkoutRoot)) {
		if (explicit) {
			throw new Error(`${KIT_CHECKOUT_ENVIRONMENT} names a missing checkout: ${checkoutRoot}`)
		}
		mkdirSync(dirname(checkoutRoot), { recursive: true })
		const clone = run(["git", "clone", "--quiet", "--no-checkout", input.pin.origin, checkoutRoot], {
			cwd: input.consumerRoot,
			environment,
			guardMs: KIT_PROVISION_GUARD_MS,
		})
		if (clone.exitCode !== 0) {
			rmSync(checkoutRoot, { recursive: true, force: true })
			throw new Error(`Kit clone from ${input.pin.origin} failed`)
		}
		checkoutCommit(checkoutRoot, input.pin, environment)
	}
	const realRoot = realpathSync(checkoutRoot)
	const topLevel = git(realRoot, ["rev-parse", "--show-toplevel"], environment)
	if (topLevel.exitCode !== 0 || realpathSync(topLevel.stdout.trim()) !== realRoot) {
		throw new Error(`Kit checkout ${realRoot} is not the top level of a Git repository`)
	}
	const head = gitOutput(realRoot, ["rev-parse", "--verify", "HEAD^{commit}"], environment)
	if (head !== input.pin.commit) {
		if (explicit) {
			throw new Error(
				`${KIT_CHECKOUT_ENVIRONMENT} checkout is at ${head}, not the pinned ${input.pin.commit}`,
			)
		}
		checkoutCommit(realRoot, input.pin, environment)
	}
	const install = run([process.execPath, "install", "--frozen-lockfile"], {
		cwd: realRoot,
		environment,
		guardMs: KIT_PROVISION_GUARD_MS,
	})
	if (install.exitCode !== 0) {
		throw new Error(`Kit frozen dependency installation failed in ${realRoot}`)
	}
	const status = gitOutput(
		realRoot,
		["status", "--porcelain=v1", "--untracked-files=all"],
		environment,
	)
	if (status !== "") throw new Error(`Kit checkout ${realRoot} is not clean`)
	const manifest = kitManifestAtHead(realRoot, environment) as {
		name?: unknown
		repository?: { url?: unknown }
	}
	if (manifest.name !== KIT_PACKAGE_NAME || manifest.repository?.url !== input.pin.origin) {
		throw new Error(`Kit checkout ${realRoot} is not ${KIT_PACKAGE_NAME} from ${input.pin.origin}`)
	}
	return realRoot
}

/**
 * Make the consumer's installed Kit link resolve to the physical checkout.
 *
 * @param consumerRoot - Consumer repository root
 * @param checkoutRoot - Physical Kit checkout realpath
 * @returns The maintenance entry path reached through the link
 *
 * @example
 * ```ts
 * const entry = linkKitCheckout(process.cwd(), checkout)
 * ```
 */
export function linkKitCheckout(consumerRoot: string, checkoutRoot: string): string {
	const link = join(consumerRoot, "node_modules", KIT_PACKAGE_NAME)
	let resolved: string | undefined
	try {
		resolved = realpathSync(link)
	} catch {
		resolved = undefined
	}
	if (resolved !== checkoutRoot) {
		mkdirSync(dirname(link), { recursive: true })
		let present = false
		try {
			lstatSync(link)
			present = true
		} catch {
			present = false
		}
		if (present) rmSync(link, { recursive: true, force: true })
		symlinkSync(checkoutRoot, link)
	}
	return join(link, KIT_ENTRY_RELATIVE_PATH)
}

function lastLine(text: string): string {
	const lines = text.split("\n").filter((line) => line.trim() !== "")
	return lines.at(-1) ?? ""
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line)
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}
}

function stripPrefix(value: unknown): string {
	return typeof value === "string" && value.startsWith("sha256:") ? value.slice("sha256:".length) : ""
}

function artifactRecord(value: unknown): PackageArtifactRecord | null {
	const artifact = record(value)
	if (typeof artifact.path !== "string" || typeof artifact.bytes !== "number") return null
	const sha256 = stripPrefix(artifact.sha256)
	return hexDigestPattern.test(sha256) ? { path: artifact.path, bytes: artifact.bytes, sha256 } : null
}

function failedOutcome(
	input: { exitCode: number; runId: string; stderr: string },
	message: string,
): PackageOutcome {
	return {
		kind: "failed",
		exitCode: input.exitCode,
		runId: input.runId,
		resultCode: "runtime-failed",
		stationId: "",
		transactionState: "unknown",
		message,
		nextAction: null,
		artifacts: { archive: null, checksums: null },
		envelope: null,
		diagnostics: input.stderr,
	}
}

function classifySuccess(input: {
	exitCode: number
	stdout: string
	stderr: string
	runId: string
}): PackageOutcome {
	const envelope = parseJsonObject(lastLine(input.stdout))
	const data = record(envelope?.data)
	const owner = record(record(data.result).result)
	const archive = artifactRecord(record(owner.artifacts).archive)
	const checksums = artifactRecord(record(owner.artifacts).checksums)
	const sourceIdentity = record(owner.sourceIdentity)
	const origin = record(sourceIdentity.repository).origin
	const release = record(owner.release)
	const payload = record(owner.payload)
	const bindingSha256 = stripPrefix(owner.bindingSha256)
	const payloadSha256 = stripPrefix(payload.payloadSha256)
	const complete =
		envelope?.status === "ok" &&
		hexDigestPattern.test(bindingSha256) &&
		hexDigestPattern.test(payloadSha256) &&
		data.result_code === "completed" &&
		owner.kind === "packaged" &&
		archive !== null &&
		checksums !== null &&
		typeof origin === "string" &&
		typeof sourceIdentity.commit === "string" &&
		typeof release.name === "string" &&
		typeof release.version === "string" &&
		typeof release.tag === "string" &&
		Array.isArray(payload.regularFiles)
	if (!complete || envelope === undefined || archive === null || checksums === null) {
		return failedOutcome(input, "Kit exited 0 without a complete packaged envelope")
	}
	return {
		kind: "packaged",
		exitCode: 0,
		runId: input.runId,
		sourceIdentity: {
			repository: { origin: origin as string },
			commit: sourceIdentity.commit as string,
		},
		release: {
			name: release.name as string,
			version: release.version as string,
			tag: release.tag as string,
		},
		bindingSha256,
		payloadSha256,
		regularFiles: (payload.regularFiles as unknown[]).filter(
			(file): file is string => typeof file === "string",
		),
		artifacts: { archive, checksums },
		envelope,
	}
}

function outcomeKind(
	exitCode: number,
	resultCode: string,
	message: string,
): Exclude<PackageOutcome["kind"], "packaged" | "process-guard"> {
	if (exitCode === 2 && message === KIT_NOT_ADMITTED_MESSAGE) return "not-admitted"
	if (exitCode === 2 || exitCode === 21 || exitCode === 23) return "refused"
	if (exitCode === 20) return resultCode === "continuation-required" ? "partial" : "recovery"
	if (exitCode === 22) return "retry"
	return "failed"
}

function classifyError(input: { exitCode: number; stderr: string; runId: string }): PackageOutcome {
	const envelope = parseJsonObject(lastLine(input.stderr))
	if (envelope === undefined || envelope.record_type !== "error_envelope") {
		return failedOutcome(input, `Kit exited ${input.exitCode} without an error envelope`)
	}
	const data = record(envelope.data)
	const resultCode = typeof data.result_code === "string" ? data.result_code : ""
	const message = typeof envelope.message === "string" ? envelope.message : ""
	const artifacts = record(record(record(data.result).result).artifacts)
	return {
		kind: outcomeKind(input.exitCode, resultCode, message),
		exitCode: input.exitCode,
		runId: input.runId,
		resultCode,
		stationId: typeof data.station_id === "string" ? data.station_id : "",
		transactionState: typeof data.transaction_state === "string" ? data.transaction_state : "",
		message,
		nextAction: data.next_action ?? null,
		artifacts: {
			archive: artifactRecord(artifacts.archive),
			checksums: artifactRecord(artifacts.checksums),
		},
		envelope,
		diagnostics: input.stderr,
	}
}

/**
 * Classify one Kit process result into a consumer outcome without fabricating success.
 *
 * @param input - Exit code, signal, and captured streams of the Kit process
 * @returns The outcome; `packaged` only for a complete success envelope
 *
 * @example
 * ```ts
 * classifyKitOutcome({ exitCode: 21, signal: null, stdout: "", stderr, runId })
 * ```
 */
export function classifyKitOutcome(input: {
	exitCode: number | null
	signal: string | null
	stdout: string
	stderr: string
	runId: string
}): PackageOutcome {
	if (input.exitCode === null || input.signal !== null) {
		return {
			kind: "process-guard",
			exitCode: input.exitCode,
			runId: input.runId,
			signal: input.signal,
			diagnostics: input.stderr,
		}
	}
	const settled = { ...input, exitCode: input.exitCode }
	return input.exitCode === 0 ? classifySuccess(settled) : classifyError(settled)
}

/**
 * Run the admitted Kit package process once. This is the only place the consumer spawns the Kit.
 *
 * @param invocation - Consumer root, entry reached through the installed link, request, and run id
 * @returns The classified outcome
 *
 * @example
 * ```ts
 * invokeKitPackage({ consumerRoot, entryPath, request, runId: "package-abc" })
 * ```
 */
export const invokeKitPackage: KitInvoker = (invocation) => {
	const result = run(
		[
			process.execPath,
			invocation.entryPath,
			"--run-id",
			invocation.runId,
			"maintenance",
			"payload",
			"package",
			"--request",
			"-",
		],
		{
			cwd: invocation.consumerRoot,
			environment: invocation.environment ?? process.env,
			guardMs: invocation.guardMs ?? KIT_PROCESS_GUARD_MS,
			stdin: Buffer.from(`${JSON.stringify(invocation.request)}\n`, "utf8"),
		},
	)
	return classifyKitOutcome({ ...result, runId: invocation.runId })
}

const realDependencies: PackageDependencies = {
	ensureKit: ensureKitCheckout,
	linkKit: linkKitCheckout,
	invokeKit: invokeKitPackage,
}

function packageRunId(commit: string, version: string): string {
	return `package-${commit.slice(0, 12)}-${version}`.replace(runIdPattern, "-").slice(0, 64)
}

/**
 * Package one prepared plugin repository through the admitted Kit: prepare first (a
 * preparation refusal invokes no Kit), then read the committed pin, ensure and link the
 * physical checkout, and run the process from the consumer root.
 *
 * @param input - Consumer root, repository root, observed source identity, and release
 * @param dependencies - Collaborators to replace; defaults to the real provisioning and process
 * @returns The Kit outcome, never fabricated
 * @throws {Error} When preparation or Kit provisioning refuses before any process runs
 *
 * @example
 * ```ts
 * const outcome = packagePreparedPlugin({ consumerRoot: root, repositoryRoot: root, sourceIdentity, release })
 * ```
 */
export function packagePreparedPlugin(
	input: PackagePreparedPluginInput,
	dependencies: Partial<PackageDependencies> = {},
): PackageOutcome {
	const collaborators = { ...realDependencies, ...dependencies }
	const environment = input.environment ?? process.env
	const repositoryRoot = resolve(input.repositoryRoot)
	const prepared = preparePluginPayload(repositoryRoot, {
		sourceIdentity: input.sourceIdentity,
		release: input.release,
	})
	const pin = readCommittedKitPin(input.consumerRoot, environment)
	const checkoutRoot = collaborators.ensureKit({ consumerRoot: input.consumerRoot, pin, environment })
	const entryPath = collaborators.linkKit(input.consumerRoot, checkoutRoot)
	return collaborators.invokeKit({
		consumerRoot: input.consumerRoot,
		entryPath,
		request: {
			repositoryRoot,
			mode: "package",
			sourceIdentity: input.sourceIdentity,
			release: input.release,
			prepared,
		},
		runId: input.runId ?? packageRunId(input.sourceIdentity.commit, input.release.version),
		environment,
	})
}

function validateSourceCommit(value: string, source: string): string {
	if (!commitPattern.test(value)) {
		throw new Error(`${source} must be exactly 40 lowercase hexadecimal characters`)
	}
	return value
}

/**
 * Observe the package source commit: an explicit `SOURCE_COMMIT` or `GITHUB_SHA` must agree
 * with the Git HEAD of the repository, which Source Checkout Admission also requires.
 *
 * @param root - Consumer repository root
 * @param environment - Process environment carrying the explicit inputs
 * @returns The 40-hex source commit
 * @throws {Error} When an explicit input is malformed or disagrees, or Git HEAD is unavailable
 *
 * @example
 * ```ts
 * const sourceCommit = resolveSourceCommit(process.cwd(), process.env)
 * ```
 */
export function resolveSourceCommit(
	root: string,
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const sourceCommit = environment.SOURCE_COMMIT
	const githubSha = environment.GITHUB_SHA
	const configuredSource =
		sourceCommit !== undefined
			? { name: "SOURCE_COMMIT", value: sourceCommit }
			: githubSha !== undefined
				? { name: "GITHUB_SHA", value: githubSha }
				: undefined
	const configuredCommit = configuredSource
		? validateSourceCommit(configuredSource.value, configuredSource.name)
		: undefined
	const head = git(root, ["rev-parse", "HEAD"], environment)
	if (head.exitCode !== 0) {
		throw new Error(
			"Unable to resolve the package source commit from git HEAD; Source Checkout Admission requires the consumer Git repository",
		)
	}
	const gitHead = validateSourceCommit(head.stdout.trim(), "git HEAD")
	if (configuredCommit !== undefined && configuredCommit !== gitHead) {
		throw new Error(`${configuredSource?.name} does not match git HEAD`)
	}
	return gitHead
}

/**
 * The `scripts/package.ts` flow: admit the bundled payload, observe the source commit, then
 * package the repository through the Kit with the plugin configuration's identity and release.
 *
 * @param root - Consumer repository root
 * @param environment - Process environment
 * @param dependencies - Collaborators to replace; defaults to the real provisioning and process
 * @returns The Kit outcome
 *
 * @example
 * ```ts
 * const outcome = runPackageCommand(process.cwd(), process.env)
 * ```
 */
export function runPackageCommand(
	root: string,
	environment: NodeJS.ProcessEnv = process.env,
	dependencies: Partial<PackageDependencies> = {},
): PackageOutcome {
	validateBunOnlyPayload(root)
	const commit = resolveSourceCommit(root, environment)
	const config = loadPluginConfig(root)
	return packagePreparedPlugin(
		{
			consumerRoot: root,
			repositoryRoot: root,
			sourceIdentity: { repository: { origin: config.repository }, commit },
			release: { name: config.name, version: config.version, tag: `v${config.version}` },
			environment,
		},
		dependencies,
	)
}
