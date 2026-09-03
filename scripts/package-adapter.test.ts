import { createHash } from "node:crypto"
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { afterAll, expect, test } from "bun:test"

import { assertDistributionChecksumIdentity } from "./distribution-checksums"
import { sharedKitCheckout } from "./fixtures/kit-checkout"
import {
	KIT_NOT_ADMITTED_MESSAGE,
	KIT_PACKAGE_NAME,
	type PackageDependencies,
	type PackageOutcome,
	classifyKitOutcome,
	linkKitCheckout,
	packagePreparedPlugin,
	readCommittedKitPin,
	runPackageCommand,
} from "./package-adapter"
import { loadPluginConfig } from "./plugin-config"
import {
	PAYLOAD_PROJECTIONS,
	type PayloadRelease,
	type SourceIdentity,
	compareCodeUnits,
	copyPluginPayload,
	directoryArchiveEntries,
	payloadInventorySha256,
	pluginPayloadInventory,
} from "./plugin-files"
import { CanaryError, lineageFromPackageEvidence } from "./ship-canary"

const worktreeRoot = resolve(import.meta.dir, "..")
const fixtureCommitter = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"]
const temporaryRoots: string[] = []

interface CommittedConsumer {
	root: string
	headCommit: string
	identity: { sourceIdentity: SourceIdentity; release: PayloadRelease }
}

function git(root: string, ...arguments_: string[]): string {
	const result = Bun.spawnSync({
		cmd: ["git", "-C", root, ...arguments_],
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) throw new Error(result.stderr.toString())
	return result.stdout.toString().trim()
}

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix))
	temporaryRoots.push(directory)
	return directory
}

const hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

/**
 * A dirty Kit checkout for S06: a local clone of the shared checkout at the same commit with
 * frozen dependencies and one untracked file. Provisioned at module load, outside test timing.
 */
const dirtyKitCheckout: string = (() => {
	const dirtyKit = join(temporaryDirectory("msb-kit-dirty-"), "kit")
	const clone = Bun.spawnSync({
		cmd: ["git", "clone", "--quiet", sharedKitCheckout, dirtyKit],
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	if (clone.exitCode !== 0) throw new Error(clone.stderr.toString())
	git(dirtyKit, "checkout", "--quiet", "--detach", git(sharedKitCheckout, "rev-parse", "HEAD"))
	const install = Bun.spawnSync({
		cmd: [process.execPath, "install", "--frozen-lockfile"],
		cwd: dirtyKit,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 120_000,
		killSignal: "SIGKILL",
	})
	if (install.exitCode !== 0) throw new Error(install.stderr.toString())
	writeFileSync(join(dirtyKit, "dirty.txt"), "uncommitted\n")
	return dirtyKit
})()

/**
 * A separate committed consumer: this worktree, including uncommitted work, at one commit.
 * The clone shares the worktree's object store so fixture creation stays far inside the
 * per-test budget; the fixture is disposable and never garbage-collected.
 */
function createCommittedConsumer(options: { pinCommit?: string; kitCheckout?: string } = {}): CommittedConsumer {
	const fixtureRoot = temporaryDirectory("msb-kit-consumer-")
	const root = join(fixtureRoot, "consumer")
	const clone = Bun.spawnSync({
		cmd: ["git", "clone", "--quiet", "--shared", worktreeRoot, root],
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	if (clone.exitCode !== 0) throw new Error(clone.stderr.toString())
	const patch = Bun.spawnSync({
		cmd: ["git", "-C", worktreeRoot, "diff", "--binary", "HEAD"],
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	if (patch.exitCode !== 0) throw new Error(patch.stderr.toString())
	if (patch.stdout.byteLength > 0) {
		const patchPath = join(fixtureRoot, "working-tree.patch")
		writeFileSync(patchPath, patch.stdout)
		git(root, "apply", "--binary", patchPath)
	}
	for (const file of git(worktreeRoot, "ls-files", "--others", "--exclude-standard", "-z")
		.split("\0")
		.filter((path) => path !== "")) {
		mkdirSync(dirname(join(root, file)), { recursive: true })
		cpSync(join(worktreeRoot, file), join(root, file))
	}
	if (options.pinCommit !== undefined) {
		const manifestPath = join(root, "package.json")
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
		manifest.dependencies[KIT_PACKAGE_NAME] =
			`git+https://github.com/myagentdojo/agent-plugin-kit.git#${options.pinCommit}`
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
	}
	git(root, "add", "--all")
	git(root, ...fixtureCommitter, "commit", "--quiet", "--allow-empty", "-m", "candidate")
	mkdirSync(join(root, "node_modules"))
	symlinkSync(options.kitCheckout ?? sharedKitCheckout, join(root, "node_modules", KIT_PACKAGE_NAME))
	const headCommit = git(root, "rev-parse", "HEAD")
	const config = loadPluginConfig(root)
	return {
		root,
		headCommit,
		identity: {
			sourceIdentity: { repository: { origin: config.repository }, commit: headCommit },
			release: { name: config.name, version: config.version, tag: `v${config.version}` },
		},
	}
}

function packageReal(consumer: CommittedConsumer, dependencies: Partial<PackageDependencies> = {}): PackageOutcome {
	return packagePreparedPlugin(
		{ consumerRoot: consumer.root, repositoryRoot: consumer.root, ...consumer.identity },
		dependencies,
	)
}

function recordingDependencies(): { dependencies: PackageDependencies; calls: string[] } {
	const calls: string[] = []
	return {
		calls,
		dependencies: {
			ensureKit: () => {
				calls.push("ensureKit")
				return "/nonexistent-kit"
			},
			linkKit: () => {
				calls.push("linkKit")
				return "/nonexistent-kit/entry.ts"
			},
			invokeKit: (invocation) => {
				calls.push("invokeKit")
				return {
					kind: "process-guard",
					exitCode: null,
					runId: invocation.runId,
					signal: null,
					diagnostics: "",
				}
			},
		},
	}
}

function errorEnvelope(input: {
	exitCode: number
	resultCode: string
	stationId: string
	transactionState: string
	message: string
	artifacts?: unknown
}): string {
	return `${JSON.stringify({
		record_type: "error_envelope",
		schema_version: 1,
		status: "error",
		message: input.message,
		run_id: "literal",
		data: {
			contract_id: "agent-plugin-kit.maintenance-command-result",
			command: "payload:package",
			result_code: input.resultCode,
			station_id: input.stationId,
			transaction_state: input.transactionState,
			next_action: { id: "maintenance.inspect-continuation", action: "inspect_state" },
			result:
				input.artifacts === undefined ? undefined : { kind: "failed", result: { kind: "failed", artifacts: input.artifacts } },
		},
		error: { code: input.resultCode, exitCodeHint: input.exitCode },
	})}\n`
}

let admittedConsumer: CommittedConsumer | undefined
function admitted(): CommittedConsumer {
	admittedConsumer ??= createCommittedConsumer()
	return admittedConsumer
}

afterAll(() => {
	for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("S01 source/preparation dispatch packages through the admitted Kit with complete evidence", () => {
	const consumer = admitted()
	const outcome = packageReal(consumer)
	if (outcome.kind !== "packaged") throw new Error(JSON.stringify(outcome))

	const data = outcome.envelope.data as Record<string, unknown>
	expect(outcome.exitCode).toBe(0)
	expect(data.result_code).toBe("completed")
	expect(data.station_id).toBe("payload-package.completed")
	expect(data.completed_effect_ids).toEqual(["effect:payload-packaged"])

	const { archive, checksums } = outcome.artifacts
	const packageName = `${consumer.identity.release.name}-${consumer.identity.release.version}`
	expect(archive.path).toBe(join(consumer.root, "dist", `${packageName}.tar.gz`))
	expect(checksums.path).toBe(join(consumer.root, "dist", `${packageName}.checksums.json`))
	const archiveBytes = readFileSync(archive.path)
	expect(hex(archiveBytes)).toBe(archive.sha256)
	expect(statSync(archive.path).size).toBe(archive.bytes)
	const checksumBytes = readFileSync(checksums.path)
	expect(hex(checksumBytes)).toBe(checksums.sha256)
	expect(statSync(checksums.path).size).toBe(checksums.bytes)

	const document = JSON.parse(checksumBytes.toString("utf8"))
	const inventory = pluginPayloadInventory(consumer.root)
	const payloadDigest = payloadInventorySha256(join(consumer.root, "plugin"), inventory)
	expect(document.sourceCommit).toBe(consumer.headCommit)
	expect(() =>
		assertDistributionChecksumIdentity(document, {
			repository: consumer.identity.sourceIdentity.repository.origin,
			sourceCommit: consumer.headCommit,
			tag: consumer.identity.release.tag,
			plugin: consumer.identity.release.name,
			version: consumer.identity.release.version,
			archive: basename(archive.path),
			archiveBytes: archiveBytes.byteLength,
			archiveSha256: hex(archiveBytes),
			payloadInventorySha256: payloadDigest,
		}),
	).not.toThrow()
	expect(outcome.payloadSha256).toBe(payloadDigest)
	expect(outcome.regularFiles).toEqual(inventory)

	const pluginRoot = join(consumer.root, "plugin")
	const files = inventory.map((path) => {
		const bytes = readFileSync(join(pluginRoot, path))
		return [path, bytes.byteLength, `sha256:${hex(bytes)}`, (lstatSync(join(pluginRoot, path)).mode & 0o111) !== 0]
	})
	const projections = [...PAYLOAD_PROJECTIONS]
		.sort((left, right) => compareCodeUnits(left.role, right.role) || compareCodeUnits(left.path, right.path))
		.map((projection) => {
			const bytes = readFileSync(join(consumer.root, projection.path))
			return [projection.role, projection.path, bytes.byteLength, `sha256:${hex(bytes)}`]
		})
	const { origin } = consumer.identity.sourceIdentity.repository
	const { name, version, tag } = consumer.identity.release
	expect(outcome.bindingSha256).toBe(
		hex(JSON.stringify([1, origin, consumer.headCommit, name, version, tag, files, projections, `sha256:${payloadDigest}`])),
	)

	const staging = temporaryDirectory("msb-kit-staging-")
	copyPluginPayload(consumer.root, join(staging, packageName))
	const listing = Bun.spawnSync({ cmd: ["tar", "-tzf", archive.path], stdout: "pipe", stderr: "pipe" })
	expect(listing.exitCode, listing.stderr.toString()).toBe(0)
	expect(listing.stdout.toString().split("\n").filter((line) => line !== "")).toEqual(
		directoryArchiveEntries(join(staging, packageName), packageName),
	)
})

test("S02 a preparation refusal invokes no Kit", () => {
	const identity = admitted().identity
	const unsafe = temporaryDirectory("msb-kit-unsafe-")
	mkdirSync(join(unsafe, "plugin"))
	writeFileSync(join(unsafe, "plugin", "a.txt"), "a\n")
	symlinkSync("a.txt", join(unsafe, "plugin", "link"))
	const unsafeRecorder = recordingDependencies()
	expect(() =>
		packagePreparedPlugin({ consumerRoot: unsafe, repositoryRoot: unsafe, ...identity }, unsafeRecorder.dependencies),
	).toThrow('unsafe plugin payload entry "plugin/link": symlink')
	expect(unsafeRecorder.calls).toEqual([])
	expect(existsSync(join(unsafe, "dist"))).toBe(false)

	const stale = temporaryDirectory("msb-kit-stale-")
	for (const projection of PAYLOAD_PROJECTIONS) {
		if (projection.role === "runtime-lock") continue
		mkdirSync(dirname(join(stale, projection.path)), { recursive: true })
		writeFileSync(join(stale, projection.path), "{}\n")
	}
	const staleRecorder = recordingDependencies()
	expect(() =>
		packagePreparedPlugin({ consumerRoot: stale, repositoryRoot: stale, ...identity }, staleRecorder.dependencies),
	).toThrow("missing runtime-lock projection: runtime/runtime.lock.json")
	expect(staleRecorder.calls).toEqual([])
	expect(existsSync(join(stale, "dist"))).toBe(false)
})

test("S03 an explicit source commit that differs from git HEAD invokes no Kit", () => {
	for (const variable of ["SOURCE_COMMIT", "GITHUB_SHA"] as const) {
		const recorder = recordingDependencies()
		const environment = { ...process.env, SOURCE_COMMIT: undefined, GITHUB_SHA: undefined, [variable]: "b".repeat(40) }
		expect(() => runPackageCommand(worktreeRoot, environment, recorder.dependencies)).toThrow(
			`${variable} does not match git HEAD`,
		)
		expect(recorder.calls).toEqual([])
	}
})

test("S04 a Kit refusal and a partial outcome are forwarded, never fabricated", () => {
	const consumer = createCommittedConsumer()
	const packageName = `${consumer.identity.release.name}-${consumer.identity.release.version}`
	const conflicting = join(consumer.root, "dist", `${packageName}.tar.gz`)
	mkdirSync(dirname(conflicting), { recursive: true })
	writeFileSync(conflicting, "not an archive\n")

	const outcome = packageReal(consumer)
	if (outcome.kind !== "refused") throw new Error(JSON.stringify(outcome))
	expect(outcome.exitCode).toBe(21)
	expect(outcome.resultCode).toBe("command-refused")
	expect(outcome.stationId).toBe("payload-package.command-refused")
	expect(outcome.transactionState).toBe("unchanged")
	expect(outcome.artifacts).toEqual({ archive: null, checksums: null })
	expect(outcome.nextAction).toBeTruthy()
	expect(readFileSync(conflicting, "utf8")).toBe("not an archive\n")
	expect(existsSync(join(consumer.root, "dist", `${packageName}.checksums.json`))).toBe(false)

	const partial = classifyKitOutcome({
		exitCode: 20,
		signal: null,
		stdout: "",
		stderr: errorEnvelope({
			exitCode: 20,
			resultCode: "continuation-required",
			stationId: "payload-package.continuation-required",
			transactionState: "partially-completed",
			message: 'Maintenance command failed with result code "continuation-required".',
			artifacts: { archive: { path: "/dist/x.tar.gz", bytes: 3, sha256: `sha256:${"a".repeat(64)}` }, checksums: null },
		}),
		runId: "literal",
	})
	if (partial.kind !== "partial") throw new Error(JSON.stringify(partial))
	expect(partial.resultCode).toBe("continuation-required")
	expect(partial.transactionState).toBe("partially-completed")
	expect(partial.artifacts).toEqual({
		archive: { path: "/dist/x.tar.gz", bytes: 3, sha256: "a".repeat(64) },
		checksums: null,
	})
	expect(partial.envelope?.record_type).toBe("error_envelope")

	const failed = classifyKitOutcome({ exitCode: 1, signal: null, stdout: "", stderr: "boom\n", runId: "literal" })
	expect(failed.kind).toBe("failed")
	const truncated = classifyKitOutcome({ exitCode: 0, signal: null, stdout: '{"status":"ok"}\n', stderr: "", runId: "literal" })
	expect(truncated.kind).toBe("failed")
})

test("S05 Canary lineage consumes package evidence", () => {
	const consumer = admitted()
	const outcome = packageReal(consumer)
	if (outcome.kind !== "packaged") throw new Error(JSON.stringify(outcome))
	const installedPayloadHash = payloadInventorySha256(join(consumer.root, "plugin"), pluginPayloadInventory(consumer.root))
	const bound = {
		repository: "myagentdojo/my-second-brain-plugin",
		candidateRef: "refs/heads/canary/candidate",
		expectedSourceCommit: consumer.headCommit,
		outcome,
		installedPayloadHash,
	}

	expect(lineageFromPackageEvidence(bound)).toEqual({
		sourceCommit: consumer.headCommit,
		archiveSha256: hex(readFileSync(outcome.artifacts.archive.path)),
		packagedPayloadHash: installedPayloadHash,
		installedPayloadHash,
	})

	const refused: PackageOutcome = {
		kind: "refused",
		exitCode: 21,
		runId: "literal",
		resultCode: "command-refused",
		stationId: "payload-package.command-refused",
		transactionState: "unchanged",
		message: "",
		nextAction: null,
		artifacts: { archive: null, checksums: null },
		envelope: null,
		diagnostics: "",
	}
	let category: string | undefined
	try {
		lineageFromPackageEvidence({ ...bound, outcome: refused })
	} catch (error) {
		category = error instanceof CanaryError ? error.category : undefined
		expect((error as Error).message).toContain("cannot be bound")
	}
	expect(category).toBe("qualification_lineage_invalid")

	expect(() => lineageFromPackageEvidence({ ...bound, expectedSourceCommit: "c".repeat(40) })).toThrow(
		"qualification checksum source commit does not match the exact candidate",
	)
})

test("S06 a dirty Kit checkout and a fake pin identity are refused by the real source-link observer", () => {
	const dirtyKit = dirtyKitCheckout
	const dirtyConsumer = createCommittedConsumer({ kitCheckout: dirtyKit })
	const dirtyOutcome = packageReal(dirtyConsumer, { ensureKit: () => dirtyKit, linkKit: linkKitCheckout })
	if (dirtyOutcome.kind !== "not-admitted") throw new Error(JSON.stringify(dirtyOutcome))
	expect(dirtyOutcome.exitCode).toBe(2)
	expect(dirtyOutcome.message).toBe(KIT_NOT_ADMITTED_MESSAGE)
	expect(dirtyOutcome.resultCode).toBe("usage-refused")
	expect(dirtyOutcome.stationId).toBe("maintenance.usage-refused")
	expect(dirtyOutcome.artifacts).toEqual({ archive: null, checksums: null })
	expect(existsSync(join(dirtyConsumer.root, "dist"))).toBe(false)

	const fakeConsumer = createCommittedConsumer({ pinCommit: "f".repeat(40) })
	expect(readCommittedKitPin(fakeConsumer.root).commit).toBe("f".repeat(40))
	const fakeOutcome = packageReal(fakeConsumer, { ensureKit: () => sharedKitCheckout })
	if (fakeOutcome.kind !== "not-admitted") throw new Error(JSON.stringify(fakeOutcome))
	expect(fakeOutcome.exitCode).toBe(2)
	expect(fakeOutcome.message).toBe(KIT_NOT_ADMITTED_MESSAGE)
	expect(fakeOutcome.artifacts).toEqual({ archive: null, checksums: null })
	expect(existsSync(join(fakeConsumer.root, "dist"))).toBe(false)
})
