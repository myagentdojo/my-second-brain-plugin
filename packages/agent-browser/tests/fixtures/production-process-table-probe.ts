import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { WarmBrowserAdapter } from "../../src/modules/warm-browser/contract"
import type { ProcessTableReading } from "../../src/modules/warm-browser/process-table"
import { createProductionAdapter } from "../../src/modules/warm-browser/production-adapter"
import { runWarmBrowserCli } from "../../src/modules/warm-browser/warm-browser"

const root = process.env.WARM_BROWSER_FIXTURE_ROOT
if (!root) throw new Error("WARM_BROWSER_FIXTURE_ROOT is required by the private test probe")
const readingPath = join(root, "process-table.json")
const actionsPath = join(root, "actions.jsonl")

function action(value: Record<string, unknown>): void {
	appendFileSync(actionsPath, `${JSON.stringify(value)}\n`)
}

function reading(): ProcessTableReading {
	return JSON.parse(readFileSync(readingPath, "utf8")) as ProcessTableReading
}

const adapter: WarmBrowserAdapter = {
	...createProductionAdapter(reading),
	createSessionId: () => "session-probe",
	platform: () => "darwin",
	inspectChrome: () => "installed",
	profileRoot: () => join(root, ".agent-warm-profile"),
	inspectProfile: () => "safe",
	inspectPort: async () => "free",
	spawnChrome: async ({ port, launchMarker }) => {
		action({ action: "spawn", port, launchMarker })
		throw new Error("the private probe never launches a browser")
	},
	verifyEndpoint: async ({ port, process: expected }) => {
		action({ action: "verify", pid: expected.pid, port })
		return { kind: "browser_unverified" }
	},
	terminateProcessGroup: async (expected) => {
		action({ action: "terminate", pid: expected.pid, processGroupId: expected.processGroupId })
		return false
	},
}

const outcome = await runWarmBrowserCli(process.argv.slice(2), adapter)
if (outcome.stdout) process.stdout.write(outcome.stdout)
if (outcome.stderr) process.stderr.write(outcome.stderr)
process.exitCode = outcome.exitCode
