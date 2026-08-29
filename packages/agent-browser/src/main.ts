import {
	privateDeliveryChildArgument,
	runPrivateDeliveryChild,
} from "./modules/private-delivery/child"
import {
	privateDeliveryDetailSanitizerArgument,
	privateDeliveryListSanitizerArgument,
} from "./modules/private-delivery/contract"
import {
	runPrivateDeliveryDetailSanitizer,
	runPrivateDeliveryListSanitizer,
} from "./modules/private-delivery/detail-sanitizer"
import { runWarmBrowserCli } from "./modules/warm-browser/warm-browser"

// Private re-entry is decided before the public parser ever runs, so the
// Command Vocabulary stays closed over what a caller can name: these arguments
// select the disposable sanitizer or delivery child, the parser never sees
// either one, and `help` never names them.
if (process.argv[2] === privateDeliveryDetailSanitizerArgument) {
	process.exitCode = await runPrivateDeliveryDetailSanitizer(process.argv.slice(3))
} else if (process.argv[2] === privateDeliveryListSanitizerArgument) {
	process.exitCode = await runPrivateDeliveryListSanitizer(process.argv.slice(3))
} else if (process.argv[2] === privateDeliveryChildArgument) {
	process.exitCode = await runPrivateDeliveryChild(process.argv.slice(3))
} else {
	const outcome = await runWarmBrowserCli(process.argv.slice(2))

	if (outcome.stdout) process.stdout.write(outcome.stdout)
	if (outcome.stderr) process.stderr.write(outcome.stderr)
	process.exitCode = outcome.exitCode
}
