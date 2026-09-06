import { afterAll, beforeAll, expect, test } from "bun:test"
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import {
	privateEntryCommand,
	privateEntryPath,
} from "../packages/agent-browser/src/modules/private-delivery/private-entry"

const repositoryRoot = resolve(import.meta.dir, "..")
const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "compiled-plugin-")))
const fixtureRoot = join(temporaryRoot, "repository")
const payloadRoot = join(temporaryRoot, "payload")
const homeRoot = join(temporaryRoot, "home")
const compiledSkillIds = [
	"agent-browser",
	"frontier-runner",
	"hello-world",
	"skill-a",
	"skill-b",
] as const

function buildFixture(): void {
	const generation = Bun.spawnSync({
		cmd: [process.execPath, "scripts/generate.ts"],
		cwd: fixtureRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(generation.exitCode, generation.stderr.toString()).toBe(0)
	const result = Bun.spawnSync({
		cmd: [process.execPath, "scripts/build.ts"],
		cwd: fixtureRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(result.exitCode, result.stderr.toString()).toBe(0)
}

function inventory(): {
	readonly compiled?: {
		readonly path: string
		readonly skills: readonly string[]
	}
} {
	return JSON.parse(
		readFileSync(join(fixtureRoot, "plugin/runtime/bundle-inventory.json"), "utf8"),
	)
}

function invoke(
	launcher: string,
	argumentList: readonly string[] = [],
	environment: Readonly<Record<string, string>> = {},
): Bun.ReadableSyncSubprocess {
	const policy = `(version 1)(allow default)(deny network*)(deny file-read* (subpath ${JSON.stringify(repositoryRoot)}) (subpath ${JSON.stringify(fixtureRoot)}) (literal ${JSON.stringify(process.execPath)}))`
	return Bun.spawnSync({
		cmd: [
			"/usr/bin/sandbox-exec",
			"-p",
			policy,
			"/bin/sh",
			join(payloadRoot, "bin", launcher),
			...argumentList,
		],
		cwd: homeRoot,
		env: {
			HOME: homeRoot,
			PATH: "/usr/bin:/bin",
			TMPDIR: temporaryRoot,
			XDG_CACHE_HOME: join(homeRoot, "cache"),
			...environment,
		},
		stdout: "pipe",
		stderr: "pipe",
	})
}

function expectSuccess(result: Bun.ReadableSyncSubprocess): void {
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(result.stderr.toString()).toBe("")
}

beforeAll(() => {
	cpSync(repositoryRoot, fixtureRoot, {
		recursive: true,
		filter: (path) => ![".git", ".dev"].includes(basename(path)),
	})
	buildFixture()
	cpSync(join(fixtureRoot, "plugin"), payloadRoot, { recursive: true })
	mkdirSync(homeRoot)
}, 60_000)

afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }))

test("the compiled Plugin Payload admits every runtime-backed skill", () => {
	expect(inventory().compiled?.skills).toEqual(compiledSkillIds)
})

test("Private Delivery keeps source and compiled re-entry commands distinct", () => {
	const privateArguments = ["--sanitize-login-list", "/private/wrapper", "Agent Vault"]
	expect(
		privateEntryPath({
			executable: "/tooling/bun",
			invocationEntry: "/payload/runtime/warm-browser.js",
			compiledSkill: undefined,
		}),
	).toBe("/payload/runtime/warm-browser.js")
	expect(
		privateEntryCommand({
			executable: "/tooling/bun",
			entry: "/payload/runtime/warm-browser.js",
			compiledSkill: undefined,
			argumentList: privateArguments,
		}),
	).toEqual([
		"/tooling/bun",
		"--config=/dev/null",
		"--no-install",
		"--env-file=/dev/null",
		"/payload/runtime/warm-browser.js",
		...privateArguments,
	])

	expect(
		privateEntryPath({
			executable: "/payload/bin/darwin-arm64/my-second-brain",
			invocationEntry: "/$bunfs/root/dispatch.js",
			compiledSkill: "agent-browser",
		}),
	).toBe("/payload/bin/darwin-arm64/my-second-brain")
	expect(
		privateEntryCommand({
			executable: "/payload/bin/darwin-arm64/my-second-brain",
			entry: "/payload/bin/darwin-arm64/my-second-brain",
			compiledSkill: "agent-browser",
			argumentList: privateArguments,
		}),
	).toEqual([
		"/payload/bin/darwin-arm64/my-second-brain",
		"agent-browser",
		...privateArguments,
	])
})

test("the compiled Agent Browser enters one synthetic Private Delivery sanitizer child", () => {
	const wrapper = join(homeRoot, "credential-wrapper")
	writeFileSync(
		wrapper,
		`#!/bin/sh
set -eu
[ "$#" -eq 9 ]
[ "$1" = op ]
[ "$2" = item ]
[ "$3" = list ]
[ "$4" = --vault ]
[ "$5" = "Agent Vault" ]
[ "$6" = --categories ]
[ "$7" = Login ]
[ "$8" = --format ]
[ "$9" = json ]
printf '%s\\n' '[{"id":"item-2","title":"never-leave-child","vault":{"id":"vlt-1","name":"Agent Vault"},"urls":[{"href":"https://fixture.test/sign-in"}]}]'
`,
		{ mode: 0o700 },
	)
	chmodSync(wrapper, 0o700)

	const sanitizer = invoke("warm-browser", [
		"--sanitize-login-list",
		wrapper,
		"Agent Vault",
	])
	expectSuccess(sanitizer)
	expect(JSON.parse(sanitizer.stdout.toString())).toEqual({
		schemaVersion: 1,
		status: "sanitized",
		candidates: [
			{
				id: "item-2",
				vault: { id: "vlt-1", name: "Agent Vault" },
				urls: [{ href: "https://fixture.test" }],
			},
		],
	})
	expect(sanitizer.stdout.toString()).not.toContain("never-leave-child")
})

test("every runtime-backed public launcher runs from the extracted compiled Plugin Payload", () => {
	const browser = invoke("warm-browser", ["help", "--run-id", "compiled-browser-help"])
	expectSuccess(browser)
	expect(JSON.parse(browser.stdout.toString())).toMatchObject({
		schemaVersion: 1,
		status: "ok",
		command: "help",
		resultCode: "HELP",
		runId: "compiled-browser-help",
	})

	const frontier = invoke("frontier-runner", ["--help"])
	expectSuccess(frontier)
	expect(frontier.stdout.toString()).toContain("Usage:\n  frontier-runner run")

	const hello = invoke("hello-world", ["hello", "--json"], {
		HELLO_WORLD_RUN_ID: "compiled-hello",
	})
	expectSuccess(hello)
	expect(JSON.parse(hello.stdout.toString())).toEqual({
		ok: true,
		command: "hello",
		message: "Hello, world!",
		sideEffects: "none",
		runId: "compiled-hello",
	})

	const skillA = invoke("skill-a")
	expectSuccess(skillA)
	expect(JSON.parse(skillA.stdout.toString())).toEqual({
		skill: "skill-a",
		moduleShape: "esm",
		esmDependency: "skillAOfflineProof",
		cjsDependencyMilliseconds: 7_200_000,
		sideEffects: "none",
	})

	const skillB = invoke("skill-b")
	expectSuccess(skillB)
	expect(JSON.parse(skillB.stdout.toString())).toEqual({
		skill: "skill-b",
		moduleShape: "cjs",
		cjsDependencyDuration: "2 hours",
		conditionalExportDependency: "\u001b[32mconditional-export-proof\u001b[39m",
		sideEffects: "none",
	})
	expect(existsSync(join(homeRoot, "cache"))).toBe(false)

	const compiled = inventory().compiled
	if (compiled === undefined) throw new Error("compiled inventory is missing")
	const executable = join(payloadRoot, compiled.path)
	const unavailable = `${executable}.unavailable`
	cpSync(executable, unavailable)
	rmSync(executable)
	try {
		const negative = invoke("skill-b")
		expect(negative.exitCode).toBe(23)
		expect(JSON.parse(negative.stdout.toString())).toMatchObject({
			ok: false,
			code: "COMPILED_UNAVAILABLE",
			sideEffects: [],
		})
	} finally {
		cpSync(unavailable, executable)
		rmSync(unavailable)
	}
	expectSuccess(invoke("skill-b"))
}, 60_000)
