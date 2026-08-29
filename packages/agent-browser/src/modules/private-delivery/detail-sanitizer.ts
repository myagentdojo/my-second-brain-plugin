import {
	interpretLoginItemDetail,
	interpretLoginItemList,
	sanitizedCredentialDetailReply,
	sanitizedCredentialListReply,
} from "./credential-match"
import { runVaultCommand } from "./credential-effects"
import { successfulVaultReplyText } from "./credential-reading"

/**
 * The disposable sanitizer for one full `op item get` reply.
 *
 * The wrapper and its full JSON reply exist only in this short-lived process.
 * Its parent receives one exact, bounded JSON shape containing only the item,
 * vault, origin, field-id, and purpose metadata needed to finish matching.
 */

/**
 * Runs the hidden sanitizer entry. Its three arguments are non-secret and
 * already custody-checked by the parent: wrapper path, item id, and vault.
 */
export async function runPrivateDeliveryDetailSanitizer(
	argumentList: readonly string[],
): Promise<number> {
	if (argumentList.length !== 3 || argumentList.some((argument) => argument === "")) return 20
	const [wrapper, itemId, vault] = argumentList as readonly [string, string, string]
	const reading = await runVaultCommand(wrapper, [
		"op",
		"item",
		"get",
		itemId,
		"--vault",
		vault,
		"--format",
		"json",
	], "current")
	const raw = successfulVaultReplyText(reading)
	const detail = raw === undefined ? undefined : interpretLoginItemDetail(raw)
	if (detail === undefined) return 20
	process.stdout.write(sanitizedCredentialDetailReply(detail))
	return 0
}

/** Runs the hidden sanitizer entry for one complete Login listing. */
export async function runPrivateDeliveryListSanitizer(
	argumentList: readonly string[],
): Promise<number> {
	if (argumentList.length !== 2 || argumentList.some((argument) => argument === "")) return 20
	const [wrapper, vault] = argumentList as readonly [string, string]
	const reading = await runVaultCommand(wrapper, [
		"op",
		"item",
		"list",
		"--vault",
		vault,
		"--categories",
		"Login",
		"--format",
		"json",
	], "current")
	const raw = successfulVaultReplyText(reading)
	const candidates = raw === undefined ? undefined : interpretLoginItemList(raw)
	if (candidates === undefined) return 20
	process.stdout.write(sanitizedCredentialListReply(candidates))
	return 0
}
