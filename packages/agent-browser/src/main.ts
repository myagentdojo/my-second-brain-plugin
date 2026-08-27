import { productionAdapter } from "./modules/warm-browser/production-adapter"
import { runWarmBrowserCli } from "./modules/warm-browser/warm-browser"

const outcome = await runWarmBrowserCli(process.argv.slice(2), productionAdapter)

if (outcome.stdout) process.stdout.write(outcome.stdout)
if (outcome.stderr) process.stderr.write(outcome.stderr)
process.exitCode = outcome.exitCode
