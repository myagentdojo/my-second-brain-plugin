/**
 * Exact-origin unique matching over already-read op replies.
 *
 * Pure interpretation, no effects: the bytes were read elsewhere, and this
 * file only decides what they say. It reads an item's identity, its vault,
 * its declared websites, and its fields' purposes and ids, and nothing else.
 * An `op item get` reply carries field values beside those purposes, and no
 * value is ever copied into a reading this file returns, so the reply's
 * secrets stop existing when the reply is dropped.
 */

/**
 * Every bound one op reply is read within, named here so the whole
 * interpretation works to one table. A reply outside any of them is not
 * interpreted at all, because a truncated interpretation could read a present
 * declaration as an absent one.
 */

/** The most Login items one listing reply may name. */
const candidateListLimit = 512

/** The most websites one item may declare. */
const declaredUrlLimit = 32

/** The most fields one item may carry. */
const itemFieldLimit = 128

/** The longest identifier, name, purpose, or address read from a reply. */
const replyTextLimit = 2_048

export interface CredentialItemField {
	readonly id: string
	readonly purpose: string
}

export interface CredentialItemReading {
	readonly id: string
	readonly vaultId: string
	readonly vaultName: string
	readonly declaredOrigins: readonly string[]
	readonly fields: readonly CredentialItemField[]
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function boundedText(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" && value.length <= replyTextLimit
		? value
		: undefined
}

/**
 * The candidate ids one listing reply names, in listed order, or `undefined`
 * when the reply is not an array of records each carrying a non-empty string
 * id. A repeated id refuses the whole listing with them: a healthy listing
 * names each item once, and a doubled id would let one item read as two
 * matches.
 */
export function interpretLoginItemList(text: string): readonly string[] | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	if (!Array.isArray(parsed) || parsed.length > candidateListLimit) return undefined
	const ids: string[] = []
	for (const entry of parsed) {
		const id = boundedText(record(entry)?.id)
		if (id === undefined || ids.includes(id)) return undefined
		ids.push(id)
	}
	return ids
}

/**
 * The origins one item's urls declare. A href that does not parse, or whose
 * protocol is not http or https, contributes nothing and never fails the
 * item: an item is matched on what it does declare, never refused for a
 * website this Module cannot read.
 */
function declaredOrigins(urls: unknown): readonly string[] | undefined {
	if (urls === undefined) return []
	if (!Array.isArray(urls) || urls.length > declaredUrlLimit) return undefined
	const origins: string[] = []
	for (const entry of urls) {
		const href = record(entry)?.href
		if (typeof href !== "string" || href.length > replyTextLimit) continue
		let parsed: URL
		try {
			parsed = new URL(href)
		} catch {
			continue
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue
		origins.push(parsed.origin)
	}
	return origins
}

/**
 * The fields one item carries, as purpose and id only. A field's value sits
 * beside these in the reply, and it is deliberately never read: only the
 * shape crosses out of the interpretation.
 */
function itemFields(fields: unknown): readonly CredentialItemField[] | undefined {
	if (fields === undefined) return []
	if (!Array.isArray(fields) || fields.length > itemFieldLimit) return undefined
	const readings: CredentialItemField[] = []
	for (const entry of fields) {
		const field = record(entry)
		if (field === undefined) return undefined
		const id = field.id
		if (typeof id !== "string" || id.length > replyTextLimit) return undefined
		const purpose = field.purpose
		if (purpose !== undefined && typeof purpose !== "string") return undefined
		if (typeof purpose === "string" && purpose.length > replyTextLimit) return undefined
		readings.push({ id, purpose: typeof purpose === "string" ? purpose : "" })
	}
	return readings
}

/**
 * One `op item get` reply as the small record the matching needs, or
 * `undefined` when the reply is not interpretable. Nothing is repaired: a
 * reply this reading cannot vouch for whole is not vouched for in part.
 */
export function interpretLoginItem(text: string): CredentialItemReading | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	const item = record(parsed)
	if (item === undefined) return undefined
	const id = boundedText(item.id)
	const vault = record(item.vault)
	const vaultId = boundedText(vault?.id)
	const vaultName = boundedText(vault?.name)
	const origins = declaredOrigins(item.urls)
	const fields = itemFields(item.fields)
	if (
		id === undefined ||
		vaultId === undefined ||
		vaultName === undefined ||
		origins === undefined ||
		fields === undefined
	) {
		return undefined
	}
	return { id, vaultId, vaultName, declaredOrigins: origins, fields }
}

/**
 * Whether one item declares the current exact origin. Equality is `===` on
 * the whole origin, so scheme, host, and port must all agree: a different
 * scheme, a parent domain, a sub-domain, an explicit non-default port, and a
 * path-only difference are all decided by this one comparison. Nothing is
 * normalised, stripped, or prefix-matched, and hostnames are never compared
 * on their own.
 */
export function declaresExactOrigin(item: CredentialItemReading, origin: string): boolean {
	return item.declaredOrigins.some((declared) => declared === origin)
}
