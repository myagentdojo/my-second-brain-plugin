import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, readFileSync } from "node:fs"

import * as productionAdapterModule from "../src/modules/warm-browser/production-adapter"
import {
	hostEffects,
	installedChrome,
	productionCliProbe,
	removeProductionCliProbes,
	runProductionCli,
	systemRows,
	verifiedReading,
	writeHostEffectsPlan,
} from "./fixtures/production-cli-harness"

afterEach(removeProductionCliProbes)

/**
 * Independent oracles for the launch contract. Every value is restated here so
 * no production table, catalog, or builder supplies its own expectation.
 */
const alwaysOnceByPrefix = [
	"--user-data-dir=",
	"--remote-debugging-port=",
	"--agent-browser-launch-marker=",
] as const

const healthyEndpoint = {
	"/json/version": {
		ok: true,
		body: {
			Browser: "Chrome/151.0.7922.174",
			webSocketDebuggerUrl: "ws://127.0.0.1:9242/devtools/browser/probe",
		},
	},
	"/json/list": { ok: true, body: [{ id: "page-1", type: "page" }] },
} as const

function launchPlan(): Record<string, unknown> {
	return {
		processTable: verifiedReading(systemRows),
		spawnOutcome: "leader",
		spawnedPid: 4242,
		listenerOwner: "spawned",
		loopbackJson: healthyEndpoint,
	}
}

test("the production Adapter is one fixed value with no injection surface", () => {
	expect(Object.keys(productionAdapterModule)).toEqual(["productionAdapter"])
	expect(typeof productionAdapterModule.productionAdapter).toBe("object")
})

test("the production launch carries each security-sensitive argument exactly once", () => {
	const probe = productionCliProbe(launchPlan())

	const started = runProductionCli(probe, ["start", "--run-id", "launch-argv"])

	expect(started.stderr.toString()).toBe("")
	expect(started.exitCode).toBe(0)
	const intent = JSON.parse(readFileSync(probe.sessionPath, "utf8")) as {
		launchMarker: string
		sessionId: string
		endpoint: { port: number }
	}
	const spawn = hostEffects(probe).find(({ action }) => action === "spawn") as {
		executable: string
		argumentList: string[]
	}

	expect(spawn.executable).toBe(installedChrome)
	expect(spawn.argumentList).toEqual([
		`--user-data-dir=${probe.profileRoot}`,
		"--profile-directory=Default",
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=9242",
		`--agent-browser-launch-marker=${intent.launchMarker}`,
		"--password-store=basic",
		"--use-mock-keychain",
		"--no-first-run",
		"--no-default-browser-check",
	])
	// No argument is repeated, so every argument above occurs exactly once.
	for (const argument of spawn.argumentList) {
		expect(spawn.argumentList.filter((value) => value === argument), argument).toHaveLength(1)
	}
	// The two arguments that decide credential exposure, named on purpose.
	expect(spawn.argumentList.filter((value) => value === "--password-store=basic")).toHaveLength(1)
	expect(spawn.argumentList.filter((value) => value === "--use-mock-keychain")).toHaveLength(1)
	// No second value may reach one single-valued argument.
	for (const prefix of alwaysOnceByPrefix) {
		expect(spawn.argumentList.filter((value) => value.startsWith(prefix)), prefix).toHaveLength(1)
	}
	expect(intent.launchMarker).toBe(intent.sessionId)
	expect(intent.endpoint.port).toBe(9242)
})

test("one port override reaches the launch argument list without a durable preference", () => {
	const probe = productionCliProbe({ ...launchPlan(), listenerOwner: 4243 })

	const started = runProductionCli(probe, ["start", "--port", "9333", "--run-id", "launch-port"])

	// A foreign listener refuses the endpoint, so the overridden launch rolls
	// back; the recorded argument list is still the production one.
	expect(JSON.parse(started.stderr.toString())).toMatchObject({
		resultCode: "CDP_IDENTITY_UNVERIFIED",
		transactionState: "rolled_back",
	})
	const spawn = hostEffects(probe).find(({ action }) => action === "spawn") as {
		argumentList: string[]
	}
	expect(spawn.argumentList).toContain("--remote-debugging-port=9333")
	expect(spawn.argumentList.filter((value) => value.startsWith("--remote-debugging-port="))).toEqual(
		["--remote-debugging-port=9333"],
	)
	expect(existsSync(probe.sessionPath)).toBe(false)
	expect(existsSync(probe.lockPath)).toBe(false)
})

test("the production CLI starts, verifies, and stops one owned group through real effects", () => {
	const probe = productionCliProbe(launchPlan())

	const started = runProductionCli(probe, ["start", "--run-id", "production-start"])
	expect(started.stderr.toString()).toBe("")
	expect(JSON.parse(started.stdout.toString())).toMatchObject({
		schemaVersion: 1,
		status: "ok",
		command: "start",
		resultCode: "SESSION_STARTED",
		runId: "production-start",
		transactionState: "started",
		retrySafe: false,
		data: {
			processId: 4242,
			endpoint: { host: "127.0.0.1", port: 9242 },
			controlledPage: { targetId: "page-1" },
			postcondition: "running",
			recoveredFrom: null,
		},
	})
	expect(hostEffects(probe).map(({ action }) => action)).toEqual([
		"port",
		"spawn",
		"listener",
		"http",
		"http",
	])

	const stopped = runProductionCli(probe, ["stop", "--run-id", "production-stop"])
	expect(stopped.stderr.toString()).toBe("")
	expect(JSON.parse(stopped.stdout.toString())).toMatchObject({
		command: "stop",
		resultCode: "SESSION_STOPPED",
		transactionState: "stopped",
		retrySafe: true,
		data: { stoppedProcessId: 4242, postcondition: "absent" },
	})
	expect(hostEffects(probe).at(-1)).toEqual({
		action: "signal",
		processGroupId: 4242,
		signal: "SIGTERM",
	})
	expect(existsSync(probe.sessionPath)).toBe(false)
	expect(existsSync(probe.lockPath)).toBe(false)
})

test("the production missing-executable launch emits one redacted JSON line without a stack", () => {
	const probe = productionCliProbe({
		processTable: verifiedReading(systemRows),
		spawnOutcome: "missing_executable",
	})

	const result = runProductionCli(probe, ["start", "--run-id", "missing-child"])

	expect(result.exitCode).toBe(1)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(
		`${
			JSON.stringify({
				schemaVersion: 1,
				status: "error",
				command: "start",
				resultCode: "UNEXPECTED_FAILURE",
				runId: "missing-child",
				transactionState: "rolled_back",
				retrySafe: false,
				nextAction: "Inspect private state and the owned process group before retrying.",
				message: "Warm Browser start failed unexpectedly.",
			})
		}\n`,
	)
	expect(result.stderr.toString().trim().split("\n")).toHaveLength(1)
	expect(result.stderr.toString()).not.toContain("ENOENT")
	expect(existsSync(probe.lockPath)).toBe(false)
	expect(hostEffects(probe).filter(({ action }) => action === "signal")).toEqual([])
})

test("an unsafe Agent Chrome Profile refuses the launch before any host effect", () => {
	const probe = productionCliProbe(launchPlan())
	// The real production profile check runs against this harness-owned HOME.
	chmodSync(probe.profileRoot, 0o755)

	const result = runProductionCli(probe, ["start", "--run-id", "unsafe-profile"])

	expect(result.exitCode).toBe(21)
	expect(JSON.parse(result.stderr.toString())).toMatchObject({
		resultCode: "PROFILE_UNSAFE",
		transactionState: "unchanged",
	})
	expect(hostEffects(probe)).toEqual([])
	expect(existsSync(probe.lockPath)).toBe(false)
})
