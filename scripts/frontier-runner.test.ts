import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, expect, test } from "bun:test"

const root = resolve(import.meta.dir, "..")
const launcher = join(root, "plugin", "skills", "frontier-runner", "scripts", "frontier-runner.sh")
const skill = join(root, "plugin", "skills", "frontier-runner", "SKILL.md")
const temporaryRoots: string[] = []

afterEach(() => {
	for (const temporaryRoot of temporaryRoots.splice(0)) {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

function fixture(): {
	bin: string
	commandLog: string
	managedWorkspace: string
	requestedWorkspace: string
} {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "frontier-runner-"))
	temporaryRoots.push(temporaryRoot)
	const bin = join(temporaryRoot, "bin")
	const commandLog = join(temporaryRoot, "commands.log")
	const managedWorkspace = join(temporaryRoot, "managed-workspace")
	const requestedWorkspace = join(temporaryRoot, "requested-workspace")
	mkdirSync(bin)
	mkdirSync(managedWorkspace)
	mkdirSync(requestedWorkspace)
	writeFileSync(commandLog, "")
	for (const command of ["herdr", "open", "tode"]) {
		const path = join(bin, command)
		const environmentObservation =
			command === "open" ? `printf ' no_color=<%s>' "\${NO_COLOR-unset}" >> "$FRONTIER_RUNNER_TEST_COMMAND_LOG"\n` : ""
		const response =
			command === "herdr"
				? `if [ "$*" = "pane current --current" ]; then
	printf '%s\\n' "$FRONTIER_RUNNER_TEST_PANE_JSON"
	elif [ "\${1:-}" = "pane" ] && [ "\${2:-}" = "split" ]; then
	printf '%s\\n' "$FRONTIER_RUNNER_TEST_SPLIT_JSON"
fi
`
				: ""
		writeFileSync(
			path,
			`#!/usr/bin/env bash\nprintf '%s' '${command}' >> "$FRONTIER_RUNNER_TEST_COMMAND_LOG"\n${environmentObservation}printf ' <%s>' "$@" >> "$FRONTIER_RUNNER_TEST_COMMAND_LOG"\nprintf '\\n' >> "$FRONTIER_RUNNER_TEST_COMMAND_LOG"\n${response}`,
		)
		chmodSync(path, 0o755)
	}
	return {
		bin,
		commandLog,
		managedWorkspace: realpathSync(managedWorkspace),
		requestedWorkspace: realpathSync(requestedWorkspace),
	}
}

function run(
	workspace: string | undefined,
	options: { bin: string; commandLog: string; environment?: Record<string, string> },
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: ["bash", launcher, ...(workspace === undefined ? [] : [workspace])],
		env: {
			...process.env,
			HERDR_ENV: undefined,
			HERDR_PANE_ID: undefined,
			FRONTIER_RUNNER_TEST_PANE_JSON: undefined,
			FRONTIER_RUNNER_TEST_SPLIT_JSON: undefined,
			PATH: `${options.bin}:${process.env.PATH ?? ""}`,
			FRONTIER_RUNNER_TEST_COMMAND_LOG: options.commandLog,
			...options.environment,
		},
		stdout: "pipe",
		stderr: "pipe",
	})
}

test("skill installs a missing Herdr before launching", () => {
	const document = readFileSync(skill, "utf8")
	const installStep = document.indexOf("curl -fsSL https://herdr.dev/install.sh | sh")
	const launchStep = document.indexOf('bash <skill-directory>/scripts/frontier-runner.sh "$PWD"')

	expect(installStep).toBeGreaterThan(-1)
	expect(launchStep).toBeGreaterThan(installStep)
	expect(document).toContain("herdr --version")
})

test("outside Herdr opens the named session for the requested workspace", () => {
	const testFixture = fixture()
	const result = run(testFixture.requestedWorkspace, {
		...testFixture,
		environment: { NO_COLOR: "1" },
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(result.stdout.toString()).toBe(
		`session=frontier-runner-v0\nworkspace=${testFixture.requestedWorkspace}\nnext=run frontier-runner again inside the managed pane to open Terminal Code\n`,
	)
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe(
		`open no_color=<1> <-Ra> <Ghostty.app>\nopen no_color=<unset> <-na> <Ghostty.app> <--args> <--working-directory=${testFixture.requestedWorkspace}> <-e> <herdr> <--session> <frontier-runner-v0>\n`,
	)
})

test("inside Herdr opens Terminal Code only on the active pane workspace", () => {
	const testFixture = fixture()
	const editorPaneId = "w1:p8"
	const paneJson = JSON.stringify({
		id: "cli:pane:current",
		result: {
			type: "pane_current",
			pane: {
				pane_id: "w1:p7",
				foreground_cwd: testFixture.managedWorkspace,
			},
		},
	})
	const splitJson = JSON.stringify({
		id: "cli:pane:split",
		result: {
			type: "pane_split",
			pane: { pane_id: editorPaneId },
		},
	})
	const result = run(testFixture.requestedWorkspace, {
		...testFixture,
		environment: {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p7",
			FRONTIER_RUNNER_TEST_PANE_JSON: paneJson,
			FRONTIER_RUNNER_TEST_SPLIT_JSON: splitJson,
		},
	})

	expect(result.exitCode).toBe(2)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toContain("workspace argument does not match managed pane")
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe(
		"herdr <pane> <current> <--current>\n",
	)
	writeFileSync(testFixture.commandLog, "")

	const canonical = run(undefined, {
		...testFixture,
		environment: {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p7",
			FRONTIER_RUNNER_TEST_PANE_JSON: paneJson,
			FRONTIER_RUNNER_TEST_SPLIT_JSON: splitJson,
		},
	})
	expect(canonical.exitCode, canonical.stderr.toString()).toBe(0)
	expect(canonical.stdout.toString()).toBe(
		`editor=terminal-code\npane=w1:p7\neditor_pane=${editorPaneId}\nworkspace=${testFixture.managedWorkspace}\nnext=start or resume one bounded worker in this Herdr workspace\n`,
	)
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe(
		`herdr <pane> <current> <--current>\nherdr <pane> <split> <--current> <--direction> <right> <--cwd> <${testFixture.managedWorkspace}> <--no-focus>\nherdr <pane> <run> <${editorPaneId}> <exec tode .>\n`,
	)
})

test("inside Herdr fails closed when the foreground cwd is unavailable", () => {
	const testFixture = fixture()
	const result = run(undefined, {
		...testFixture,
		environment: {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p7",
			FRONTIER_RUNNER_TEST_PANE_JSON: JSON.stringify({
				id: "cli:pane:current",
				result: {
					type: "pane_current",
					pane: { pane_id: "w1:p7" },
				},
			}),
		},
	})

	expect(result.exitCode).toBe(1)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toContain("Herdr returned no foreground cwd")
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe(
		"herdr <pane> <current> <--current>\n",
	)
})
