import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, expect, test } from "bun:test"

const root = resolve(import.meta.dir, "..")
const afterHash = "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919"
const temporaryRoots: string[] = []

interface Fixture {
	root: string
	bin: string
	workspace: string
	promptFile: string
	resultFile: string
	stateHome: string
	commandLog: string
	deliveredPrompt: string
	livePanes: string
	splitCount: string
	transcript: string
	currentPaneJson: string
}

afterEach(() => {
	for (const temporaryRoot of temporaryRoots.splice(0)) {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

function bundledEntrypoint(): string {
	const inventory = JSON.parse(
		readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8"),
	) as { bundles: { "frontier-runner"?: { path: string } } }
	const path = inventory.bundles["frontier-runner"]?.path
	if (!path) throw new Error("frontier-runner bundle is absent; run bun run build")
	return join(root, "plugin", path)
}

function createExecutable(path: string, body = "exit 0\n"): void {
	writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`)
	chmodSync(path, 0o755)
}

function fixture(): Fixture {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "frontier-runner-bounded-"))
	temporaryRoots.push(fixtureRoot)
	const bin = join(fixtureRoot, "bin")
	const workspace = join(fixtureRoot, "workspace")
	const stateHome = join(fixtureRoot, "state")
	const promptFile = join(fixtureRoot, "prompt.md")
	const resultFile = join(workspace, "fixture.txt")
	const commandLog = join(fixtureRoot, "commands.log")
	const deliveredPrompt = join(fixtureRoot, "delivered-prompt.md")
	const livePanes = join(fixtureRoot, "live-panes")
	const splitCount = join(fixtureRoot, "split-count")
	const transcript = join(fixtureRoot, "transcript.txt")
	mkdirSync(bin)
	mkdirSync(workspace)
	writeFileSync(promptFile, "Replace fixture.txt with the requested final bytes. PROMPT_BODY_PRIVATE\n")
	writeFileSync(resultFile, "before\n")
	writeFileSync(commandLog, "")
	writeFileSync(deliveredPrompt, "")
	writeFileSync(livePanes, "w1:p1\n")
	writeFileSync(splitCount, "0\n")
	writeFileSync(transcript, "")

	createExecutable(
		join(bin, "tode"),
		`if [[ "\${1:-}" == "--help" ]]; then printf 'Usage: tode [path]\ntode <folder>\n'; fi\n`,
	)
	createExecutable(
		join(bin, "terminal-browser"),
		`if [[ "\${1:-}" == "--help" ]]; then printf 'Usage: terminal-browser open <url>\n'; fi\n`,
	)
	createExecutable(join(bin, "codex"))
	createExecutable(
		join(bin, "herdr"),
		`log="$FR_TEST_COMMAND_LOG"
if [[ "\${1:-} \${2:-}" == "agent prompt" ]]; then
	printf 'agent prompt <%s>\n' "\${3:-}" >> "$log"
else
	printf '%s' "\${1:-}" >> "$log"
	for argument in "\${@:2}"; do printf ' <%s>' "$argument" >> "$log"; done
	printf '\n' >> "$log"
fi

case "\${1:-} \${2:-}" in
	"pane current")
		printf '%s\n' "$FR_TEST_CURRENT_PANE_JSON"
		;;
	"pane split")
		count=$(tr -d '\\n' < "$FR_TEST_SPLIT_COUNT")
		count=$((count + 1))
		printf '%s\n' "$count" > "$FR_TEST_SPLIT_COUNT"
		case "$count" in
			1) pane='w1:p2' ;;
			2) pane='w1:p3' ;;
			3) pane='w1:p4' ;;
			*) pane="w1:p$((count + 1))" ;;
		esac
		printf '%s\n' "$pane" >> "$FR_TEST_LIVE_PANES"
		type='pane_info'
		workspace='w1'
		if [[ "$FR_TEST_PROTOCOL_MODE" == "split_wrong_type" ]]; then type='ok'; fi
		if [[ "$FR_TEST_PROTOCOL_MODE" == "split_wrong_workspace" ]]; then workspace='w9'; fi
		if [[ "$FR_TEST_PROTOCOL_MODE" == "split_source_pane" ]]; then pane="\${3:-}"; fi
		printf '{"id":"cli:pane:split","result":{"type":"%s","pane":{"pane_id":"%s","terminal_id":"term:%s","workspace_id":"%s","tab_id":"w1:t1","cwd":"%s","focused":false,"agent_status":"unknown","revision":1}}}\n' "$type" "$pane" "$pane" "$workspace" "$FR_TEST_WORKSPACE"
		;;
	"pane run")
		if [[ "$FR_TEST_PROTOCOL_MODE" == "pane_run_empty_success" ]]; then
			:
		elif [[ "$FR_TEST_PROTOCOL_MODE" == "pane_run_wrong_type" ]]; then
			printf '{"id":"cli:pane:run","result":{"type":"pane_info"}}\n'
		else
			printf '{"id":"cli:pane:run","result":{"type":"ok"}}\n'
		fi
		;;
	"pane get")
		pane="\${3:-}"
		if grep -Fqx "$pane" "$FR_TEST_LIVE_PANES"; then
			printf '{"id":"cli:pane:get","result":{"type":"pane_info","pane":{"pane_id":"%s","terminal_id":"term:%s","workspace_id":"w1","tab_id":"w1:t1","cwd":"%s","focused":false,"agent_status":"unknown","revision":1}}}\n' "$pane" "$pane" "$FR_TEST_WORKSPACE"
		else
			printf '{"id":"cli:pane:get","error":{"code":"pane_not_found","message":"absent"}}\n' >&2
			exit 1
		fi
		;;
	"pane close")
		pane="\${3:-}"
		if grep -Fqx "$pane" "$FR_TEST_LIVE_PANES"; then
			grep -Fvx "$pane" "$FR_TEST_LIVE_PANES" > "$FR_TEST_LIVE_PANES.tmp" || true
			mv "$FR_TEST_LIVE_PANES.tmp" "$FR_TEST_LIVE_PANES"
			printf '{"id":"cli:pane:close","result":{"type":"ok"}}\n'
		else
			printf '{"id":"cli:pane:close","error":{"code":"pane_not_found","message":"absent"}}\n' >&2
			exit 1
		fi
		;;
	"agent start")
		pane='w1:p4'
		if [[ "$FR_TEST_PROTOCOL_MODE" == "start_wrong_pane" ]]; then pane='w1:p9'; fi
		printf '{"id":"cli:agent:start","result":{"type":"agent_started","agent":{"name":"%s","pane_id":"%s","terminal_id":"term:%s","workspace_id":"w1","tab_id":"w1:t1","agent_status":"idle","interactive_ready":true,"focused":false,"revision":1},"argv":["codex"]}}\n' "\${3:-}" "$pane" "$pane"
		;;
	"agent prompt")
		printf '%s' "\${4:-}" > "$FR_TEST_DELIVERED_PROMPT"
		if [[ "$FR_TEST_PROMPT_MODE" != "error" ]]; then
			printf 'after\n' > "$FR_TEST_RESULT_FILE"
			case "$FR_TEST_TRANSCRIPT_MODE" in
				marker) printf 'completed fixture\nfrontier-result:%s\n' "$FR_TEST_AFTER_HASH" > "$FR_TEST_TRANSCRIPT" ;;
				wrapped) printf 'completed fixture\nfrontier-\nresult:%s\n%s\n' "\${FR_TEST_AFTER_HASH:0:32}" "\${FR_TEST_AFTER_HASH:32}" > "$FR_TEST_TRANSCRIPT" ;;
				codex_wrapped) printf '• Ran checksum\n  └ frontier-result:%s\n    %s\n    %s\n' "\${FR_TEST_AFTER_HASH:0:18}" "\${FR_TEST_AFTER_HASH:18:32}" "\${FR_TEST_AFTER_HASH:50}" > "$FR_TEST_TRANSCRIPT" ;;
				embedded) printf 'completed frontier-result:%s inside prose\n' "$FR_TEST_AFTER_HASH" > "$FR_TEST_TRANSCRIPT" ;;
				suffixed) printf 'frontier-result:%s suffix\n' "$FR_TEST_AFTER_HASH" > "$FR_TEST_TRANSCRIPT" ;;
				duplicate) printf 'frontier-result:%s\nfrontier-result:%s\n' "$FR_TEST_AFTER_HASH" "$FR_TEST_AFTER_HASH" > "$FR_TEST_TRANSCRIPT" ;;
				*) printf 'completed fixture without proof\n' > "$FR_TEST_TRANSCRIPT" ;;
			esac
		fi
		case "$FR_TEST_PROMPT_MODE" in
			timeout)
				printf '{"id":"cli:agent:prompt","error":{"code":"timeout","message":"timed out"}}\n' >&2
				exit 1
			;;
			stalled)
				printf '{"id":"cli:agent:prompt","error":{"code":"agent_prompt_stalled","message":"unsettled"}}\n' >&2
				exit 1
			;;
			error)
				printf '{"id":"cli:agent:prompt","error":{"code":"socket_closed","message":"unknown"}}\n' >&2
				exit 1
			;;
			*)
				pane='w1:p4'
				if [[ "$FR_TEST_PROTOCOL_MODE" == "prompt_wrong_pane" ]]; then pane='w1:p9'; fi
				printf '{"id":"cli:agent:prompt","result":{"type":"agent_prompted","agent":{"name":"%s","pane_id":"%s","terminal_id":"term:%s","workspace_id":"w1","tab_id":"w1:t1","agent_status":"idle","interactive_ready":true,"focused":false,"revision":1}}}\n' "\${3:-}" "$pane" "$pane"
				;;
		esac
		;;
	"agent get")
		printf '{"id":"cli:agent:get","result":{"type":"agent_info","agent":{"name":"%s","pane_id":"%s","terminal_id":"term:%s","workspace_id":"w1","tab_id":"w1:t1","agent_status":"%s","interactive_ready":true,"focused":false,"revision":1}}}\n' "\${3:-}" "$FR_TEST_AGENT_PANE" "$FR_TEST_AGENT_PANE" "$FR_TEST_AGENT_STATUS"
		;;
	"agent wait")
		if [[ "$FR_TEST_WAIT_MODE" == "timeout" ]]; then
			printf '{"id":"cli:agent:wait","error":{"code":"timeout","message":"timed out"}}\n' >&2
			exit 1
		fi
		printf '{"id":"cli:agent:wait","result":{"type":"agent_info","agent":{"name":"%s","pane_id":"%s","terminal_id":"term:%s","workspace_id":"w1","tab_id":"w1:t1","agent_status":"%s","interactive_ready":true,"focused":false,"revision":1}}}\n' "\${3:-}" "$FR_TEST_AGENT_PANE" "$FR_TEST_AGENT_PANE" "$FR_TEST_AGENT_STATUS"
		;;
	"agent read")
		cat "$FR_TEST_TRANSCRIPT"
		;;
	*)
		printf '{"error":{"code":"unexpected_fake_command","message":"unsupported"}}\n' >&2
		exit 1
		;;
esac
`,
	)

	return {
		root: fixtureRoot,
		bin,
		workspace,
		promptFile,
		resultFile,
		stateHome,
		commandLog,
		deliveredPrompt,
		livePanes,
		splitCount,
		transcript,
		currentPaneJson: JSON.stringify({
			id: "cli:pane:current",
			result: {
				type: "pane_current",
				pane: {
					pane_id: "w1:p1",
					terminal_id: "term:w1:p1",
					workspace_id: "w1",
					tab_id: "w1:t1",
					foreground_cwd: workspace,
					focused: true,
					agent_status: "unknown",
					revision: 1,
				},
			},
		}),
	}
}

function environment(testFixture: Fixture, overrides: Record<string, string | undefined> = {}) {
	return {
		...process.env,
		PATH: `${testFixture.bin}:/usr/bin:/bin`,
		HERDR_ENV: "1",
		HERDR_WORKSPACE_ID: "w1",
		HERDR_TAB_ID: "w1:t1",
		HERDR_PANE_ID: "w1:p1",
		XDG_STATE_HOME: testFixture.stateHome,
		FR_TEST_COMMAND_LOG: testFixture.commandLog,
		FR_TEST_DELIVERED_PROMPT: testFixture.deliveredPrompt,
		FR_TEST_LIVE_PANES: testFixture.livePanes,
		FR_TEST_SPLIT_COUNT: testFixture.splitCount,
		FR_TEST_TRANSCRIPT: testFixture.transcript,
		FR_TEST_CURRENT_PANE_JSON: testFixture.currentPaneJson,
		FR_TEST_WORKSPACE: testFixture.workspace,
		FR_TEST_RESULT_FILE: testFixture.resultFile,
		FR_TEST_AFTER_HASH: afterHash,
		FR_TEST_PROMPT_MODE: "timeout",
		FR_TEST_TRANSCRIPT_MODE: "marker",
		FR_TEST_PROTOCOL_MODE: "valid",
		FR_TEST_AGENT_PANE: "w1:p4",
		FR_TEST_AGENT_STATUS: "idle",
		FR_TEST_WAIT_MODE: "settled",
		...overrides,
	}
}

function runCli(testFixture: Fixture, arguments_: string[], overrides: Record<string, string | undefined> = {}) {
	return Bun.spawnSync({
		cmd: [process.execPath, bundledEntrypoint(), ...arguments_],
		env: environment(testFixture, overrides),
		stdout: "pipe",
		stderr: "pipe",
	})
}

function runArguments(testFixture: Fixture): string[] {
	return [
		"run",
		"--unit-id",
		"fixture-one",
		"--workspace",
		testFixture.workspace,
		"--prompt-file",
		testFixture.promptFile,
		"--timeout-ms",
		"25",
		"--browser-url",
		"https://example.test/private-path?view=proof",
		"--result-file",
		"fixture.txt",
	]
}

function envelope(result: ReturnType<typeof Bun.spawnSync>): Record<string, unknown> {
	return JSON.parse(result.stdout.toString()) as Record<string, unknown>
}

function receiptPath(testFixture: Fixture, runId: string): string {
	return join(testFixture.stateHome, "my-second-brain-vault", "frontier-runner", `${runId}.json`)
}

function count(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0
}

test("bundled public executable exposes run, resume, and cleanup", () => {
	const testFixture = fixture()
	const result = runCli(testFixture, ["--help"])

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(result.stdout.toString()).toContain("frontier-runner run")
	expect(result.stdout.toString()).toContain("frontier-runner resume")
	expect(result.stdout.toString()).toContain("frontier-runner cleanup")
})

test("unknown commands return a structured usage failure", () => {
	const testFixture = fixture()
	const result = runCli(testFixture, ["invented"])

	expect(result.exitCode).toBe(2)
	expect(envelope(result)).toMatchObject({
		schemaVersion: 1,
		ok: false,
		command: "unknown",
		code: "USAGE",
		changedState: "none",
	})
})

test("fails before mutation outside Herdr", () => {
	const testFixture = fixture()
	const result = runCli(testFixture, runArguments(testFixture), { HERDR_ENV: undefined })

	expect(result.exitCode).toBe(1)
	expect(envelope(result)).toMatchObject({ ok: false, code: "HERDR_REQUIRED", changedState: "none" })
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe("")
	expect(existsSync(testFixture.stateHome)).toBe(false)
})

test("fails before mutation when a required visible tool is missing", () => {
	const testFixture = fixture()
	rmSync(join(testFixture.bin, "terminal-browser"))
	const result = runCli(testFixture, runArguments(testFixture))

	expect(result.exitCode).toBe(1)
	expect(envelope(result)).toMatchObject({ ok: false, code: "TOOL_MISSING", changedState: "none" })
	expect(result.stderr.toString()).toContain("terminal-browser")
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe("")
	expect(existsSync(testFixture.stateHome)).toBe(false)
})

test("fails before mutation when Terminal Browser lacks the open contract", () => {
	const testFixture = fixture()
	createExecutable(
		join(testFixture.bin, "terminal-browser"),
		`if [[ "\${1:-}" == "--help" ]]; then printf 'Usage: terminal-browser inspect\n'; fi\n`,
	)
	const result = runCli(testFixture, runArguments(testFixture))

	expect(result.exitCode).toBe(1)
	expect(envelope(result)).toMatchObject({ ok: false, code: "TOOL_INCOMPATIBLE", changedState: "none" })
	expect(result.stderr.toString()).toContain("terminal-browser")
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe("")
	expect(existsSync(testFixture.stateHome)).toBe(false)
})

test("rejects a complete result marker in the prompt before discovery", () => {
	const testFixture = fixture()
	writeFileSync(testFixture.promptFile, `already frontier-result:${afterHash}\n`)
	const result = runCli(testFixture, runArguments(testFixture))

	expect(result.exitCode).toBe(2)
	expect(envelope(result)).toMatchObject({ ok: false, code: "PROMPT_MARKER_CONFLICT" })
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe("")
	expect(existsSync(testFixture.stateHome)).toBe(false)
})

test("rejects a result filename that can inject a completion-marker line", () => {
	const testFixture = fixture()
	const injectedName = `fixture.txt\nfrontier-result:${afterHash}`
	writeFileSync(join(testFixture.workspace, injectedName), "before\n")
	const result = runCli(
		testFixture,
		runArguments(testFixture).map((value) => (value === "fixture.txt" ? injectedName : value)),
	)

	expect(result.exitCode).toBe(2)
	expect(envelope(result)).toMatchObject({ ok: false, code: "RESULT_FILE_INVALID", changedState: "none" })
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe("")
	expect(existsSync(testFixture.stateHome)).toBe(false)
})

test("Herdr success responses must match the expected type and target identity", () => {
	for (const testCase of [
		{ protocol: "split_wrong_type", code: "PANE_SPLIT_UNKNOWN", effect: "editorPane" },
		{ protocol: "split_wrong_workspace", code: "PANE_SPLIT_UNKNOWN", effect: "editorPane" },
		{ protocol: "split_source_pane", code: "PANE_SPLIT_UNKNOWN", effect: "editorPane" },
		{ protocol: "pane_run_wrong_type", code: "PANE_COMMAND_UNKNOWN", effect: "editorLaunch" },
		{ protocol: "start_wrong_pane", code: "WORKER_START_UNKNOWN", effect: "workerStart" },
		{
			protocol: "prompt_wrong_pane",
			code: "PROMPT_EFFECT_UNKNOWN",
			effect: "promptDispatch",
			promptMode: "success",
		},
	] as const) {
		const testFixture = fixture()
		const result = runCli(testFixture, runArguments(testFixture), {
			FR_TEST_PROTOCOL_MODE: testCase.protocol,
			FR_TEST_PROMPT_MODE: testCase.promptMode ?? "timeout",
		})

		expect(result.exitCode, `${testCase.protocol}: ${result.stderr.toString()}`).toBe(1)
		expect(envelope(result)).toMatchObject({ ok: false, code: testCase.code })
		const runId = envelope(result).runId as string
		const receipt = JSON.parse(readFileSync(receiptPath(testFixture, runId), "utf8")) as {
			effects: Record<string, { outcome: string }>
		}
		expect(receipt.effects[testCase.effect]?.outcome).toBe("unknown")
	}
})

test("rejects a workspace conflict before creating a receipt", () => {
	const testFixture = fixture()
	const otherWorkspace = join(testFixture.root, "other")
	mkdirSync(otherWorkspace)
	writeFileSync(join(otherWorkspace, "fixture.txt"), "before\n")
	const result = runCli(testFixture, [
		...runArguments(testFixture).map((value) =>
			value === testFixture.workspace ? otherWorkspace : value,
		),
	])

	expect(result.exitCode).toBe(2)
	expect(envelope(result)).toMatchObject({ ok: false, code: "WORKSPACE_CONFLICT", changedState: "none" })
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe("pane <current> <--current>\n")
	expect(existsSync(testFixture.stateHome)).toBe(false)
})

test("accepts Herdr pane run exit zero with no output as an acknowledged dispatch", () => {
	const testFixture = fixture()
	const result = runCli(testFixture, runArguments(testFixture), {
		FR_TEST_PROTOCOL_MODE: "pane_run_empty_success",
	})

	expect(result.exitCode, `${result.stderr.toString()}\n${result.stdout.toString()}`).toBe(124)
	const report = envelope(result)
	expect(report).toMatchObject({ ok: false, code: "PROMPT_TIMEOUT", state: "timed_out" })
	const receipt = JSON.parse(readFileSync(receiptPath(testFixture, report.runId as string), "utf8")) as {
		effects: Record<string, { outcome: string }>
	}
	expect(receipt.effects.editorLaunch).toMatchObject({ outcome: "succeeded" })
	expect(receipt.effects.browserLaunch).toMatchObject({ outcome: "succeeded" })
})

test("a deliberate timeout persists a private minimal receipt after one dispatch", () => {
	const testFixture = fixture()
	const result = runCli(testFixture, runArguments(testFixture))

	expect(result.exitCode, `${result.stderr.toString()}\n${result.stdout.toString()}`).toBe(124)
	const report = envelope(result)
	expect(report).toMatchObject({ ok: false, code: "PROMPT_TIMEOUT", state: "timed_out" })
	const runId = report.runId as string
	const path = receiptPath(testFixture, runId)
	const receiptText = readFileSync(path, "utf8")
	const receipt = JSON.parse(receiptText) as Record<string, unknown>
	expect(statSync(path).mode & 0o777).toBe(0o600)
	expect(statSync(join(path, ".." )).mode & 0o777).toBe(0o700)
	expect(receipt).toMatchObject({
		schemaVersion: 1,
		runId,
		state: "timed_out",
		resources: {
			editorPaneId: "w1:p2",
			browserPaneId: "w1:p3",
			workerPaneId: "w1:p4",
		},
	})
	expect(receiptText).not.toContain("PROMPT_BODY_PRIVATE")
	expect(receiptText).not.toContain("https://example.test/private-path")
	expect(receiptText).not.toContain(`frontier-result:${afterHash}`)
	const commands = readFileSync(testFixture.commandLog, "utf8")
	expect(count(commands, /^pane <split>/gm)).toBe(3)
	expect(count(commands, /^agent <start>/gm)).toBe(1)
	expect(count(commands, /^agent prompt/gm)).toBe(1)
})

test("the worker prompt requires a final shell action that emits the independently derived marker", () => {
	const testFixture = fixture()
	const result = runCli(testFixture, runArguments(testFixture))

	expect(result.exitCode, result.stderr.toString()).toBe(124)
	const deliveredPrompt = readFileSync(testFixture.deliveredPrompt, "utf8")
	expect(deliveredPrompt).toContain("As your final shell action")
	expect(deliveredPrompt).toContain("frontier-result:")
	expect(deliveredPrompt).toContain("shasum -a 256")
	expect(deliveredPrompt).toContain("fixture.txt")
})

test("agent_prompt_stalled is persisted as one uncertain dispatch and exit 124", () => {
	const testFixture = fixture()
	const result = runCli(testFixture, runArguments(testFixture), { FR_TEST_PROMPT_MODE: "stalled" })

	expect(result.exitCode, result.stderr.toString()).toBe(124)
	const report = envelope(result)
	expect(report).toMatchObject({ ok: false, code: "PROMPT_TIMEOUT", state: "timed_out" })
	const receipt = JSON.parse(
		readFileSync(receiptPath(testFixture, report.runId as string), "utf8"),
	) as { effects: { promptDispatch: { outcome: string; code: string } } }
	expect(receipt.effects.promptDispatch).toEqual(
		expect.objectContaining({ outcome: "timed_out", code: "agent_prompt_stalled" }),
	)
	expect(count(readFileSync(testFixture.commandLog, "utf8"), /^agent prompt/gm)).toBe(1)
})

test("resume proves the fixture marker without another split, worker, or prompt", () => {
	const testFixture = fixture()
	const timedOut = runCli(testFixture, runArguments(testFixture))
	const runId = envelope(timedOut).runId as string
	const beforeResume = readFileSync(testFixture.commandLog, "utf8")
	const resumed = runCli(testFixture, ["resume", "--run-id", runId])

	expect(resumed.exitCode, resumed.stderr.toString()).toBe(0)
	expect(envelope(resumed)).toMatchObject({
		ok: true,
		command: "resume",
		code: "RUN_COMPLETED",
		runId,
		state: "completed",
	})
	expect(readFileSync(testFixture.resultFile, "utf8")).toBe("after\n")
	const commands = readFileSync(testFixture.commandLog, "utf8")
	expect(count(commands, /^pane <split>/gm)).toBe(3)
	expect(count(commands, /^agent <start>/gm)).toBe(1)
	expect(count(commands, /^agent prompt/gm)).toBe(1)
	const workerName = commands.match(/agent prompt <(fr_[a-f0-9]+)>/)?.[1]
	expect(workerName).toMatch(/^fr_[a-f0-9]{12}$/)
	expect(commands.slice(beforeResume.length)).toBe(
		`pane <get> <w1:p2>\npane <get> <w1:p3>\npane <get> <w1:p4>\nagent <get> <${workerName}>\nagent <read> <${workerName}> <--source> <recent-unwrapped> <--lines> <120>\n`,
	)
	const receipt = JSON.parse(readFileSync(receiptPath(testFixture, runId), "utf8")) as {
		observation: { resultSha256: string; resultMarkerSha256: string }
	}
	expect(receipt.observation.resultSha256).toBe(afterHash)
	expect(receipt.observation.resultMarkerSha256).toMatch(/^[a-f0-9]{64}$/)
})

test("repeated resume converges without contacting Herdr", () => {
	const testFixture = fixture()
	const timedOut = runCli(testFixture, runArguments(testFixture))
	const runId = envelope(timedOut).runId as string
	expect(runCli(testFixture, ["resume", "--run-id", runId]).exitCode).toBe(0)
	writeFileSync(testFixture.commandLog, "")

	const repeated = runCli(testFixture, ["resume", "--run-id", runId])
	expect(repeated.exitCode, repeated.stderr.toString()).toBe(0)
	expect(envelope(repeated)).toMatchObject({ code: "RUN_COMPLETED", changedState: "none" })
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe("")
})

test("blocked and unknown workers stop without resending the prompt", () => {
	for (const [status, code] of [
		["blocked", "AGENT_BLOCKED"],
		["unknown", "AGENT_STATE_UNKNOWN"],
	] as const) {
		const testFixture = fixture()
		const timedOut = runCli(testFixture, runArguments(testFixture))
		const runId = envelope(timedOut).runId as string
		const resumed = runCli(testFixture, ["resume", "--run-id", runId], {
			FR_TEST_AGENT_STATUS: status,
		})
		expect(resumed.exitCode).toBe(1)
		expect(envelope(resumed)).toMatchObject({ ok: false, code })
		expect(count(readFileSync(testFixture.commandLog, "utf8"), /^agent prompt/gm)).toBe(1)
	}
})

test("a worker-name collision with another pane fails closed", () => {
	const testFixture = fixture()
	const timedOut = runCli(testFixture, runArguments(testFixture))
	const runId = envelope(timedOut).runId as string
	const resumed = runCli(testFixture, ["resume", "--run-id", runId], {
		FR_TEST_AGENT_PANE: "w1:p9",
	})

	expect(resumed.exitCode).toBe(1)
	expect(envelope(resumed)).toMatchObject({ ok: false, code: "WORKER_IDENTITY_CONFLICT" })
	expect(count(readFileSync(testFixture.commandLog, "utf8"), /^agent prompt/gm)).toBe(1)
})

test("an unclassified prompt effect is never replayed by resume", () => {
	const testFixture = fixture()
	const failed = runCli(testFixture, runArguments(testFixture), { FR_TEST_PROMPT_MODE: "error" })
	const runId = envelope(failed).runId as string
	expect(failed.exitCode).toBe(1)
	expect(envelope(failed)).toMatchObject({ code: "PROMPT_EFFECT_UNKNOWN" })

	const resumed = runCli(testFixture, ["resume", "--run-id", runId])
	expect(resumed.exitCode).toBe(1)
	expect(envelope(resumed)).toMatchObject({ code: "EFFECT_UNKNOWN" })
	expect(count(readFileSync(testFixture.commandLog, "utf8"), /^agent prompt/gm)).toBe(1)
})

test("terminal state without the independently derived marker is not completion", () => {
	const testFixture = fixture()
	const timedOut = runCli(testFixture, runArguments(testFixture), {
		FR_TEST_TRANSCRIPT_MODE: "missing",
	})
	const runId = envelope(timedOut).runId as string
	const resumed = runCli(testFixture, ["resume", "--run-id", runId], {
		FR_TEST_TRANSCRIPT_MODE: "missing",
	})

	expect(resumed.exitCode).toBe(1)
	expect(envelope(resumed)).toMatchObject({ code: "RESULT_NOT_PROVED", state: "settled_unproved" })
	expect(count(readFileSync(testFixture.commandLog, "utf8"), /^agent prompt/gm)).toBe(1)
})

test("completion requires exactly one standalone result marker line", () => {
	for (const transcriptMode of ["embedded", "suffixed", "duplicate"] as const) {
		const testFixture = fixture()
		const timedOut = runCli(testFixture, runArguments(testFixture), {
			FR_TEST_TRANSCRIPT_MODE: transcriptMode,
		})
		const runId = envelope(timedOut).runId as string
		const resumed = runCli(testFixture, ["resume", "--run-id", runId], {
			FR_TEST_TRANSCRIPT_MODE: transcriptMode,
		})

		expect(resumed.exitCode, transcriptMode).toBe(1)
		expect(envelope(resumed)).toMatchObject({ code: "RESULT_NOT_PROVED", state: "settled_unproved" })
		expect(count(readFileSync(testFixture.commandLog, "utf8"), /^agent prompt/gm)).toBe(1)
	}
})

test("resume recognizes one standalone result marker hard-wrapped across terminal rows", () => {
	const testFixture = fixture()
	const timedOut = runCli(testFixture, runArguments(testFixture), {
		FR_TEST_TRANSCRIPT_MODE: "wrapped",
	})
	const runId = envelope(timedOut).runId as string
	const resumed = runCli(testFixture, ["resume", "--run-id", runId], {
		FR_TEST_TRANSCRIPT_MODE: "wrapped",
	})

	expect(resumed.exitCode, resumed.stderr.toString()).toBe(0)
	expect(envelope(resumed)).toMatchObject({ code: "RUN_COMPLETED", state: "completed" })
	expect(count(readFileSync(testFixture.commandLog, "utf8"), /^agent prompt/gm)).toBe(1)
})

test("resume recognizes the exact marker in Codex-decorated wrapped tool output", () => {
	const testFixture = fixture()
	const timedOut = runCli(testFixture, runArguments(testFixture), {
		FR_TEST_TRANSCRIPT_MODE: "codex_wrapped",
	})
	const runId = envelope(timedOut).runId as string
	const resumed = runCli(testFixture, ["resume", "--run-id", runId], {
		FR_TEST_TRANSCRIPT_MODE: "codex_wrapped",
	})

	expect(resumed.exitCode, resumed.stderr.toString()).toBe(0)
	expect(envelope(resumed)).toMatchObject({ code: "RUN_COMPLETED", state: "completed" })
	expect(count(readFileSync(testFixture.commandLog, "utf8"), /^agent prompt/gm)).toBe(1)
})

test("terminal receipt states require their state-dependent evidence", () => {
	for (const [state, command] of [
		["completed", "resume"],
		["cleaned", "cleanup"],
	] as const) {
		const testFixture = fixture()
		const timedOut = runCli(testFixture, runArguments(testFixture))
		const runId = envelope(timedOut).runId as string
		const path = receiptPath(testFixture, runId)
		const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
		receipt.state = state
		receipt.resources = { workerName: (receipt.resources as { workerName: string }).workerName }
		receipt.effects = {}
		delete receipt.observation
		writeFileSync(path, `${JSON.stringify(receipt)}\n`)
		writeFileSync(testFixture.commandLog, "")

		const result = runCli(testFixture, [command, "--run-id", runId])
		expect(result.exitCode, state).toBe(1)
		expect(envelope(result)).toMatchObject({ ok: false, code: "RECEIPT_INVALID" })
		expect(readFileSync(testFixture.commandLog, "utf8")).toBe("")
	}
})

test("cleanup closes only recorded panes and repeating it is a no-op", () => {
	const testFixture = fixture()
	const timedOut = runCli(testFixture, runArguments(testFixture))
	const runId = envelope(timedOut).runId as string
	expect(runCli(testFixture, ["resume", "--run-id", runId]).exitCode).toBe(0)
	writeFileSync(testFixture.commandLog, "")

	const cleaned = runCli(testFixture, ["cleanup", "--run-id", runId])
	expect(cleaned.exitCode, cleaned.stderr.toString()).toBe(0)
	expect(envelope(cleaned)).toMatchObject({
		ok: true,
		code: "CLEANUP_CONVERGED",
		state: "cleaned",
		changedState: "complete",
	})
	const commands = readFileSync(testFixture.commandLog, "utf8")
	expect(commands).toContain("pane <close> <w1:p4>")
	expect(commands).toContain("pane <close> <w1:p3>")
	expect(commands).toContain("pane <close> <w1:p2>")
	expect(commands).not.toContain("pane <close> <w1:p1>")
	expect(readFileSync(testFixture.livePanes, "utf8")).toBe("w1:p1\n")
	writeFileSync(testFixture.commandLog, "")

	const repeated = runCli(testFixture, ["cleanup", "--run-id", runId])
	expect(repeated.exitCode, repeated.stderr.toString()).toBe(0)
	expect(envelope(repeated)).toMatchObject({ changedState: "none" })
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe("")
})

test("cleanup refuses to close the pane running the controller", () => {
	const testFixture = fixture()
	const timedOut = runCli(testFixture, runArguments(testFixture))
	const runId = envelope(timedOut).runId as string
	writeFileSync(testFixture.commandLog, "")

	const cleaned = runCli(testFixture, ["cleanup", "--run-id", runId], {
		HERDR_PANE_ID: "w1:p4",
	})
	expect(cleaned.exitCode).toBe(1)
	expect(envelope(cleaned)).toMatchObject({ code: "CLEANUP_CALLER_OWNED" })
	expect(readFileSync(testFixture.commandLog, "utf8")).toBe("")
})
