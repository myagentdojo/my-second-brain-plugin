import { join } from "node:path"

import type { WarmBrowserAdapter } from "../../src/modules/warm-browser/contract"
import { productionAdapter } from "../../src/modules/warm-browser/production-adapter"
import { runWarmBrowserCli } from "../../src/modules/warm-browser/warm-browser"

const root = process.env.WARM_BROWSER_FIXTURE_ROOT
if (!root) throw new Error("WARM_BROWSER_FIXTURE_ROOT is required")

const adapter: WarmBrowserAdapter = {
	...productionAdapter,
	platform: () => "darwin",
	chromeExecutable: () => join(root, "missing-chrome"),
	inspectChrome: () => "installed",
	profileRoot: () => join(root, ".agent-warm-profile"),
	inspectProfile: () => "safe",
	findProfileProcesses: () => ({ kind: "verified", processes: [] }),
	inspectPort: async () => "free",
}

const outcome = await runWarmBrowserCli(["start", "--run-id", "missing-child"], adapter)
if (outcome.stdout) process.stdout.write(outcome.stdout)
if (outcome.stderr) process.stderr.write(outcome.stderr)
process.exitCode = outcome.exitCode
