import {
	privateDeliveryChildArgument,
	runPrivateDeliveryChild,
} from "./modules/private-delivery/child"
import { runWarmBrowserCli } from "./modules/warm-browser/warm-browser"

// The private re-entry is decided before the public parser ever runs, so the
// Command Vocabulary stays closed over what a caller can name: the argument
// selects the disposable Private Delivery child, the parser never sees it, and
// `help` never names it.
if (process.argv[2] === privateDeliveryChildArgument) {
	process.exitCode = await runPrivateDeliveryChild(process.argv.slice(3))
} else {
	const outcome = await runWarmBrowserCli(process.argv.slice(2))

	if (outcome.stdout) process.stdout.write(outcome.stdout)
	if (outcome.stderr) process.stderr.write(outcome.stderr)
	process.exitCode = outcome.exitCode
}
