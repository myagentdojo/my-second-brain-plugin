import { credentialWrapperOutputLimit } from "./contract"
import type { VaultCommandReading } from "./credential-effects"

/**
 * Reduces one bounded wrapper reading to the text it safely proves. A failed
 * spawn, signal, non-zero exit, missing stream, or overlong reply proves no
 * bytes and therefore yields no partial interpretation.
 */
export function successfulVaultReplyText(
	reading: VaultCommandReading,
): string | undefined {
	if (reading.failed || reading.signal !== null || reading.status !== 0) return undefined
	if (reading.stdout === null || reading.stdout.length > credentialWrapperOutputLimit) {
		return undefined
	}
	return reading.stdout
}
