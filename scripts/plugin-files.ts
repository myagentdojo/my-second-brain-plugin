import { createHash } from "node:crypto"
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

/** Canonical directory copied by development staging and release packaging. */
export const PLUGIN_DIRECTORY = "plugin"

/** Hex SHA-256 digest carrying the Kit Interface prefix. */
export type Sha256Digest = `sha256:${string}`

/** Explicit plugin source identity the consumer observes and binds into preparation. */
export interface SourceIdentity {
	repository: { origin: string }
	commit: string
}

/** Release values projected into the package name, archive root, and checksum document. */
export interface PayloadRelease {
	name: string
	version: string
	tag: string
}

/** One regular file under `plugin/` with its bytes, digest, and executable mode. */
export interface PreparedFileDeclaration {
	path: string
	bytes: number
	sha256: Sha256Digest
	executable: boolean
}

/** Semantic input roles the consumer binds beside the payload closure. */
export type PreparedProjectionRole =
	| "config"
	| "runtime-lock"
	| "bundle-inventory"
	| "skill-inventory"
	| "native-manifest"

/** One repository-relative input file whose bytes the package binds. */
export interface PreparedProjectionDeclaration {
	role: PreparedProjectionRole
	path: string
	bytes: number
	sha256: Sha256Digest
}

/** The sealed preparation declaration handed to the Kit package process. */
export interface PreparedPayloadDeclaration {
	sourceIdentity: SourceIdentity
	files: readonly PreparedFileDeclaration[]
	projections: readonly PreparedProjectionDeclaration[]
	payloadSha256: Sha256Digest
	bindingSha256: Sha256Digest
}

/** Repository-relative projection inputs the consumer binds into every package. */
export const PAYLOAD_PROJECTIONS: readonly { role: PreparedProjectionRole; path: string }[] = [
	{ role: "bundle-inventory", path: "plugin/runtime/bundle-inventory.json" },
	{ role: "config", path: "plugin.config.json" },
	{ role: "native-manifest", path: "plugin/.claude-plugin/plugin.json" },
	{ role: "native-manifest", path: "plugin/.codex-plugin/plugin.json" },
	{ role: "runtime-lock", path: "runtime/runtime.lock.json" },
	{ role: "skill-inventory", path: "runtime/skill-catalog.json" },
]

/**
 * Order paths by JavaScript code units so inventories never depend on process locale.
 *
 * @param left - First path or entry name
 * @param right - Second path or entry name
 * @returns Negative when left sorts first, positive when right sorts first, or zero when equal
 *
 * @example
 * ```ts
 * ["ä", "Z", "a"].sort(compareCodeUnits)
 * ```
 */
export function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

function framedLength(length: number): Buffer {
	const frame = Buffer.allocUnsafe(8)
	frame.writeBigUInt64BE(BigInt(length))
	return frame
}

/** Hash an ordered payload inventory with collision-free path/body framing. */
export function payloadInventorySha256(
	payloadRoot: string,
	inventory: readonly string[],
): string {
	return payloadBuffersSha256(
		inventory.map((relativePath) => ({
			path: relativePath,
			bytes: readFileSync(join(payloadRoot, relativePath)),
		})),
	)
}

function payloadBuffersSha256(files: readonly { path: string; bytes: Uint8Array }[]): string {
	const hash = createHash("sha256")
	for (const file of files) {
		const pathBytes = Buffer.from(file.path, "utf8")
		hash.update(framedLength(pathBytes.byteLength))
		hash.update(pathBytes)
		hash.update(framedLength(file.bytes.byteLength))
		hash.update(file.bytes)
	}
	return hash.digest("hex")
}

/**
 * List one directory tree in the exact depth-first order used by deterministic tar input.
 *
 * @param directory - Absolute directory whose entries have already passed payload validation
 * @param prefix - Archive-relative root name
 * @returns Root, directory, and file entries with directories carrying trailing slashes
 *
 * @example
 * ```ts
 * directoryArchiveEntries("/tmp/plugin", "hello-0.1.0")
 * ```
 */
export function directoryArchiveEntries(directory: string, prefix: string): string[] {
	const entries = [`${prefix}/`]
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
		compareCodeUnits(left.name, right.name),
	)) {
		const relativePath = `${prefix}/${entry.name}`
		if (entry.isDirectory()) {
			entries.push(...directoryArchiveEntries(join(directory, entry.name), relativePath))
		} else {
			entries.push(relativePath)
		}
	}
	return entries
}

function unsafeEntry(relativePath: string, reason: string): Error {
	const entry = relativePath ? `${PLUGIN_DIRECTORY}/${relativePath}` : PLUGIN_DIRECTORY
	return new Error(`unsafe plugin payload entry "${entry}": ${reason}`)
}

/**
 * Discover the one deterministic set of regular files that may become a Plugin Payload.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @returns Sorted paths relative to `plugin/`, using forward slashes
 * @throws {Error} When the plugin root or any descendant is empty, a symlink, or a special file
 *
 * @example
 * ```ts
 * const files = pluginPayloadInventory(process.cwd())
 * ```
 */
export function pluginPayloadInventory(sourceRoot: string): string[] {
	const pluginRoot = resolve(sourceRoot, PLUGIN_DIRECTORY)
	const pluginRootStatus = lstatSync(pluginRoot)
	if (pluginRootStatus.isSymbolicLink()) throw unsafeEntry("", "symlink")
	if (!pluginRootStatus.isDirectory()) throw unsafeEntry("", "special file (expected directory)")

	const pluginRealRoot = realpathSync(pluginRoot)
	const inventory: string[] = []

	function walk(directory: string, relativeDirectory: string): void {
		const entries = readdirSync(directory).sort(compareCodeUnits)
		if (entries.length === 0) throw unsafeEntry(relativeDirectory, "empty directory")
		for (const entry of entries) {
			const absolutePath = join(directory, entry)
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry
			const status = lstatSync(absolutePath)

			if (status.isSymbolicLink()) throw unsafeEntry(relativePath, "symlink")
			if (!status.isDirectory() && !status.isFile()) {
				throw unsafeEntry(relativePath, "special file (FIFO, device, or socket)")
			}
			if (status.isDirectory()) {
				walk(absolutePath, relativePath)
				continue
			}
			inventory.push(relativePath)
		}
	}

	// Walk from the resolved root. Every descendant is lstat'd and symlinks are
	// rejected before descent, so valid POSIX names need no per-entry realpath.
	walk(pluginRealRoot, "")
	return inventory.sort(compareCodeUnits)
}

/**
 * Copy the exact canonical plugin payload without repository tooling or source.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @param targetRoot - Empty or replaceable directory receiving plugin contents
 * @returns The validated inventory copied into the target
 * @throws {Error} When the canonical payload contains an empty directory, symlink, special file, or realpath escape
 *
 * @example
 * ```ts
 * copyPluginPayload(process.cwd(), "/tmp/installed-plugin")
 * ```
 */
export function copyPluginPayload(sourceRoot: string, targetRoot: string): string[] {
	const pluginRoot = resolve(sourceRoot, PLUGIN_DIRECTORY)
	const inventory = pluginPayloadInventory(sourceRoot)
	mkdirSync(targetRoot, { recursive: true })
	for (const relativePath of inventory) {
		const sourcePath = join(pluginRoot, relativePath)
		const targetPath = join(targetRoot, relativePath)
		const sourceStatus = lstatSync(sourcePath)
		if (!sourceStatus.isFile()) throw unsafeEntry(relativePath, "changed after inventory (expected file)")
		mkdirSync(dirname(targetPath), { recursive: true })
		copyFileSync(sourcePath, targetPath)
		chmodSync(targetPath, sourceStatus.mode & 0o7777)
	}
	return inventory
}

function sha256Digest(bytes: Uint8Array | string): Sha256Digest {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

/**
 * Bind a preparation to its source identity, release, file tuples, projection tuples, and payload digest.
 *
 * The digest hashes the UTF-8 JSON array
 * `[1, origin, commit, name, version, tag, files, projections, payloadSha256]` without whitespace.
 *
 * @param input - Prepared values in their declared order
 * @returns The prefixed binding digest
 *
 * @example
 * ```ts
 * preparationBindingSha256({ sourceIdentity, release, files, projections, payloadSha256 })
 * ```
 */
export function preparationBindingSha256(input: {
	sourceIdentity: SourceIdentity
	release: PayloadRelease
	files: readonly PreparedFileDeclaration[]
	projections: readonly PreparedProjectionDeclaration[]
	payloadSha256: Sha256Digest
}): Sha256Digest {
	const tuple = [
		1,
		input.sourceIdentity.repository.origin,
		input.sourceIdentity.commit,
		input.release.name,
		input.release.version,
		input.release.tag,
		input.files.map((file) => [file.path, file.bytes, file.sha256, file.executable]),
		input.projections.map((projection) => [
			projection.role,
			projection.path,
			projection.bytes,
			projection.sha256,
		]),
		input.payloadSha256,
	]
	return sha256Digest(JSON.stringify(tuple))
}

/**
 * Prepare the exact plugin payload the Kit may package: the regular-file closure with
 * bytes, digests, and executable modes, the bound projection inputs, the framed payload
 * digest, and the preparation binding. This never invokes the Kit.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @param identity - Observed source identity and release values to bind
 * @returns The sealed preparation declaration
 * @throws {Error} When the payload is unsafe or a projection input is missing or not a regular file
 *
 * @example
 * ```ts
 * const prepared = preparePluginPayload(process.cwd(), { sourceIdentity, release })
 * ```
 */
export function preparePluginPayload(
	sourceRoot: string,
	identity: { sourceIdentity: SourceIdentity; release: PayloadRelease },
): PreparedPayloadDeclaration {
	const pluginRoot = resolve(sourceRoot, PLUGIN_DIRECTORY)
	const inventory = pluginPayloadInventory(sourceRoot)
	const loadedFiles = inventory.map((relativePath) => {
		const absolutePath = join(pluginRoot, relativePath)
		const status = lstatSync(absolutePath)
		if (!status.isFile()) throw unsafeEntry(relativePath, "changed after inventory (expected file)")
		const bytes = readFileSync(absolutePath)
		return {
			bytes,
			declaration: {
				path: relativePath,
				bytes: bytes.byteLength,
				sha256: sha256Digest(bytes),
				executable: (status.mode & 0o111) !== 0,
			},
		}
	})
	const files = loadedFiles.map((file) => file.declaration)
	const projections = PAYLOAD_PROJECTIONS.map((projection) => {
		const absolutePath = resolve(sourceRoot, projection.path)
		let status: ReturnType<typeof lstatSync> | undefined
		try {
			status = lstatSync(absolutePath)
		} catch {
			status = undefined
		}
		if (status === undefined || !status.isFile()) {
			throw new Error(
				`missing ${projection.role} projection: ${projection.path} must be a regular file`,
			)
		}
		const bytes = readFileSync(absolutePath)
		return {
			role: projection.role,
			path: projection.path,
			bytes: bytes.byteLength,
			sha256: sha256Digest(bytes),
		}
	}).sort((left, right) => compareCodeUnits(left.role, right.role) || compareCodeUnits(left.path, right.path))
	const payloadSha256: Sha256Digest = `sha256:${payloadBuffersSha256(
		loadedFiles.map((file) => ({ path: file.declaration.path, bytes: file.bytes })),
	)}`
	return {
		sourceIdentity: identity.sourceIdentity,
		files,
		projections,
		payloadSha256,
		bindingSha256: preparationBindingSha256({
			sourceIdentity: identity.sourceIdentity,
			release: identity.release,
			files,
			projections,
			payloadSha256,
		}),
	}
}
