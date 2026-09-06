import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fakeCodexProfile } from "./test-support/codex-profile"

const root = resolve(import.meta.dir, "..")
const temporary = realpathSync(
	mkdtempSync(join(tmpdir(), "compiled-development-")),
)
const fixture = join(temporary, "repository")
const source = join(fixture, "packages/skill-a/src/main.js")
const skillSource = readFileSync(
	join(root, "packages/skill-a/src/main.js"),
	"utf8",
)
const home = join(temporary, "home")
const environment = {
	HOME: home,
	XDG_CACHE_HOME: join(home, "cache"),
	PATH: "/usr/bin:/bin",
	TMPDIR: temporary,
}
const literal = {
	skill: "skill-a",
	moduleShape: "esm",
	esmDependency: "skillAOfflineProof",
	cjsDependencyMilliseconds: 7200000,
	sideEffects: "none",
}
const hash = (path: string) =>
	createHash("sha256").update(readFileSync(path)).digest("hex")
const inventory = () =>
	JSON.parse(
		readFileSync(join(fixture, "plugin/runtime/bundle-inventory.json"), "utf8"),
	)
function build() {
	return Bun.spawnSync({
		cmd: [process.execPath, "scripts/build.ts"],
		cwd: fixture,
		stdout: "pipe",
		stderr: "pipe",
	})
}
function built() {
	const result = build()
	expect(result.exitCode, result.stderr.toString()).toBe(0)
}
function extracted(name: string) {
	const destination = join(temporary, name)
	cpSync(join(fixture, "plugin"), destination, { recursive: true })
	return destination
}
function invoke(
	payload: string,
	extra: Record<string, string> = {},
	args: string[] = [],
	stdin?: string,
) {
	const policy = `(version 1)(allow default)(deny network*)(deny file-read* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(fixture)}) (literal ${JSON.stringify(process.execPath)}))`
	return Bun.spawnSync({
		cmd: [
			"/usr/bin/sandbox-exec",
			"-p",
			policy,
			"/bin/sh",
			join(payload, "bin/skill-a"),
			...args,
		],
		cwd: home,
		env: { ...environment, ...extra },
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	})
}
function success(payload: string, expected = literal) {
	const result = invoke(payload)
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(result.stderr.toString()).toBe("")
	expect(JSON.parse(result.stdout.toString())).toEqual(expected)
}

beforeAll(() => {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error("CD01 to CD07 require darwin-arm64")
	mkdirSync(home)
	cpSync(root, fixture, {
		recursive: true,
		filter: (path) => ![".git", ".dev"].includes(basename(path)),
	})
	built()
}, 60000)
afterAll(() => rmSync(temporary, { recursive: true, force: true }))

test("CD01 extracted real skill runs with external runtime, repository and network denied", () => {
	const payload = extracted("offline")
	success(payload)
	expect(existsSync(environment.XDG_CACHE_HOME)).toBe(false)
	const executable = join(payload, inventory().compiled.path)
	expect(statSync(executable).mode & 0o111).toBe(0o111)
	expect(hash(executable)).toBe(inventory().compiled.sha256)
	rmSync(executable)
	expect(invoke(payload).exitCode).toBe(23)
}, 60000)

test("CD02 compiled public launcher preserves process arguments, cwd, environment and streams", () => {
	try {
		writeFileSync(
			source,
			`import { writeFileSync, statSync } from "node:fs"\nwriteFileSync("mode-proof", "ok"); console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),app:process.env.APP_PROOF,path:process.env.PATH,mode:statSync("mode-proof").mode & 511,input:await Bun.stdin.text()})); console.error("probe stderr"); process.exit(7)\n`,
		)
		built()
		const payload = extracted("process")
		const result = invoke(
			payload,
			{ APP_PROOF: "ordinary", PATH: "/no-external-runtime" },
			["a b", "--flag", ""],
			"probe stdin",
		)
		expect(result.exitCode).toBe(7)
		expect(result.stderr.toString()).toBe("probe stderr\n")
		expect(JSON.parse(result.stdout.toString())).toEqual({
			args: ["a b", "--flag", ""],
			cwd: home,
			app: "ordinary",
			path: "/no-external-runtime",
			mode: 0o666 & ~process.umask(),
			input: "probe stdin",
		})
	} finally {
		writeFileSync(source, skillSource)
		built()
	}
}, 60000)

test("CD03 hostile Bun controls and cwd or HOME configuration cannot preload code", () => {
	writeFileSync(
		source,
		'if (process.env.APP_PROOF === "unsafe") throw new Error("dotenv autoload escaped");\n' +
			skillSource,
	)
	built()
	const payload = extracted("hostile")
	const marker = join(home, "preloaded")
	const preload = join(home, "preload.js")
	writeFileSync(preload, `await Bun.write(${JSON.stringify(marker)}, "unsafe")`)
	writeFileSync(
		join(home, "bunfig.toml"),
		`preload = [${JSON.stringify(preload)}]\n`,
	)
	writeFileSync(
		join(home, ".bunfig.toml"),
		`preload = [${JSON.stringify(preload)}]\n`,
	)
	writeFileSync(join(home, ".env"), "APP_PROOF=unsafe\nBUN_BE_BUN=1\n")
	try {
		const result = invoke(payload, {
			BUN_BE_BUN: "1",
			BUN_OPTIONS: `--preload=${preload}`,
			NODE_OPTIONS: `--require=${preload}`,
			BUN_CONFIG_FILE: join(home, "bunfig.toml"),
		})
		expect(result.exitCode, result.stderr.toString()).toBe(0)
		expect(JSON.parse(result.stdout.toString())).toEqual(literal)
		expect(existsSync(marker)).toBe(false)
		const engine = join(payload, "runtime/runtime-exec")
		writeFileSync(
			engine,
			readFileSync(engine, "utf8").replace("unset BUN_BE_BUN ", "unset "),
		)
		expect(invoke(payload, { BUN_BE_BUN: "1" }).exitCode).not.toBe(0)
		const builder = join(fixture, "scripts/build.ts")
		const original = readFileSync(builder, "utf8")
		try {
			writeFileSync(
				builder,
				original.replace(
					"--no-compile-autoload-dotenv",
					"--compile-autoload-dotenv",
				),
			)
			built()
			const dotenv = invoke(extracted("dotenv-unprotected"))
			expect(dotenv.exitCode).not.toBe(0)
			expect(dotenv.stderr.toString()).toContain("dotenv autoload escaped")
			writeFileSync(
				builder,
				original.replace(
					"--no-compile-autoload-bunfig",
					"--compile-autoload-bunfig",
				),
			)
			built()
			invoke(extracted("bunfig-unprotected"))
			expect(existsSync(marker)).toBe(true)
			rmSync(marker)
		} finally {
			writeFileSync(builder, original)
			built()
		}
		success(extracted("protections-restored"))
		expect(existsSync(marker)).toBe(false)
	} finally {
		for (const name of ["bunfig.toml", ".bunfig.toml", ".env"])
			rmSync(join(home, name))
		writeFileSync(source, skillSource)
		built()
	}
	success(extracted("hostile-restored"))
}, 60000)

test("CD04 missing, corrupt, symlinked, wrong-target and non-executable payloads refuse without repair", () => {
	const cases = ["missing", "corrupt", "symlink", "target", "mode"]
	for (const kind of cases) {
		const payload = extracted(`refuse-${kind}`)
		const executable = join(payload, inventory().compiled.path)
		if (kind === "missing") rmSync(executable)
		if (kind === "corrupt") writeFileSync(executable, "corrupt")
		if (kind === "symlink") {
			rmSync(executable)
			symlinkSync(join(fixture, inventory().compiled.path), executable)
		}
		if (kind === "mode") chmodSync(executable, 0o644)
		if (kind === "target") {
			const projection = join(payload, "runtime/bundle-inventory.sh")
			writeFileSync(
				projection,
				readFileSync(projection, "utf8").replace(
					"RUNTIME_COMPILED_TARGET='darwin-arm64'",
					"RUNTIME_COMPILED_TARGET='linux-arm64'",
				),
			)
		}
		const result = invoke(payload)
		expect(result.exitCode).toBe(23)
		expect(JSON.parse(result.stdout.toString())).toMatchObject({
			code:
				kind === "corrupt"
					? "COMPILED_MISMATCH"
					: kind === "target"
						? "COMPILED_WRONG_TARGET"
						: "COMPILED_UNAVAILABLE",
			ok: false,
			sideEffects: [],
			retrySafe: false,
		})
		expect(JSON.parse(result.stdout.toString()).nextAction).toMatch(
			/rebuild|reinstall/i,
		)
		expect(existsSync(environment.XDG_CACHE_HOME)).toBe(false)
	}
}, 60000)

function development(
	profile: ReturnType<typeof fakeCodexProfile>,
	args: string[] = [],
) {
	return Bun.spawnSync({
		cmd: [
			process.execPath,
			"scripts/dev.ts",
			"codex",
			"install",
			"--json",
			"--no-input",
			"--no-launch",
			...args,
		],
		cwd: fixture,
		env: { ...profile.environment, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	})
}
function preview(profile: ReturnType<typeof fakeCodexProfile>) {
	const result = development(profile)
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	return JSON.parse(result.stdout.toString()).candidate.candidateHash as string
}

test("CD05 two real edits rebuild and stage distinct independently copied executable results", () => {
	const profile = fakeCodexProfile(fixture, {
		realBuild: true,
		marketplaceRoot: null,
	})
	try {
		const identities: string[] = []
		for (const [index, input, expected] of [
			[1, "compiled cycle one", "compiledCycleOne"],
			[2, "compiled cycle two", "compiledCycleTwo"],
		] as const) {
			writeFileSync(source, skillSource.replace("skill a offline proof", input))
			const candidate = preview(profile)
			expect(preview(profile)).toBe(candidate)
			const applied = development(profile, [
				"--apply",
				"--candidate-hash",
				candidate,
			])
			expect(applied.exitCode, applied.stderr.toString()).toBe(0)
			const installed = join(temporary, `cycle-${index}`)
			cpSync(
				join(profile.marketplaceRoot, "plugins/my-second-brain-dev"),
				installed,
				{ recursive: true },
			)
			success(installed, { ...literal, esmDependency: expected })
			identities.push(hash(join(installed, inventory().compiled.path)))
		}
		expect(identities[0]).not.toBe(identities[1])
	} finally {
		profile.cleanup()
		writeFileSync(source, skillSource)
		built()
	}
}, 120000)

test("CD06 changed post-preview payload invalidates apply before native mutation", () => {
	const profile = fakeCodexProfile(fixture, {
		realBuild: true,
		marketplaceRoot: null,
	})
	try {
		const candidate = preview(profile)
		writeFileSync(
			source,
			skillSource.replace("skill a offline proof", "changed candidate"),
		)
		const result = development(profile, [
			"--apply",
			"--candidate-hash",
			candidate,
		])
		expect(result.exitCode).not.toBe(0)
		expect(
			profile
				.readState()
				.commands.filter((command) =>
					/plugin (add|remove|marketplace add)/.test(command),
				),
		).toEqual([])
	} finally {
		profile.cleanup()
		writeFileSync(source, skillSource)
		built()
	}
}, 60000)

test("CD07 failed compilation cannot install stale bytes or disturb the prior installation", () => {
	const profile = fakeCodexProfile(fixture, {
		realBuild: true,
		marketplaceRoot: null,
	})
	try {
		const candidate = preview(profile)
		expect(
			development(profile, ["--apply", "--candidate-hash", candidate]).exitCode,
		).toBe(0)
		const priorState = profile.readState()
		const priorBytes = hash(
			join(
				profile.marketplaceRoot,
				"plugins/my-second-brain-dev",
				inventory().compiled.path,
			),
		)
		const builder = join(fixture, "scripts/build.ts")
		const original = readFileSync(builder, "utf8")
		try {
			writeFileSync(
				builder,
				original.replace(
					'"--target=bun-darwin-arm64"',
					'"--target=not-a-target"',
				),
			)
			const result = development(profile, [
				"--apply",
				"--candidate-hash",
				candidate,
			])
			expect(result.exitCode).not.toBe(0)
			expect(profile.readState()).toEqual(priorState)
			expect(
				hash(
					join(
						profile.marketplaceRoot,
						"plugins/my-second-brain-dev",
						inventory().compiled.path,
					),
				),
			).toBe(priorBytes)
			expect(
				JSON.parse(
					readFileSync(join(fixture, ".dev/claude/build-receipt.json"), "utf8"),
				).outcome,
			).toBe("failed")
		} finally {
			writeFileSync(builder, original)
			built()
		}
	} finally {
		profile.cleanup()
	}
}, 60000)
