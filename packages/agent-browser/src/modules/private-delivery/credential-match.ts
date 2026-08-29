import { credentialWrapperOutputLimit } from "./contract"

/**
 * Exact-origin unique matching over already-read metadata.
 *
 * Pure interpretation, no effects: the bytes were read elsewhere, and this
 * file only decides what they say. The full Login listing and `op item get`
 * reply reach this interpreter only inside their disposable sanitizers. Only
 * bounded identity, vault, origins, field purposes, and field ids leave those
 * processes.
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

/**
 * One whole `op item get` reply as the small record the delivery needs: the
 * same metadata the listing carried, so the two readings can be compared
 * rather than merged, plus the fields, which only a detail reply carries. The
 * values sitting beside those fields in the reply are never read.
 */
export interface CredentialItemReading extends CredentialItemCandidateReading {
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
 * The non-secret Login metadata every reply must carry about one item: who it
 * is, which vault holds it, and which origins it declares. The listing decides
 * the unique exact-origin match from these alone; only the matched item's id
 * reaches the later detail command.
 */
export interface CredentialItemCandidateReading {
	readonly id: string
	readonly vaultId: string
	readonly vaultName: string
	readonly declaredOrigins: readonly string[]
}

/**
 * That shared metadata read off one reply record, or `undefined` when the
 * record does not carry all of it. It is read the same way from a listing
 * entry and from a detail reply, because a candidate that reads one way in the
 * listing and another in the detail would be two different items wearing one
 * id.
 */
function interpretCandidate(entry: unknown): CredentialItemCandidateReading | undefined {
	const item = record(entry)
	const id = boundedText(item?.id)
	const vault = record(item?.vault)
	const vaultId = boundedText(vault?.id)
	const vaultName = boundedText(vault?.name)
	const origins = declaredOrigins(item?.urls)
	return id === undefined || vaultId === undefined || vaultName === undefined ||
			origins === undefined
		? undefined
		: { id, vaultId, vaultName, declaredOrigins: origins }
}

/**
 * The candidates one listing reply names, in listed order, or `undefined` when
 * the reply is not a bounded array of records each carrying that whole
 * metadata. A repeated id refuses the whole listing with them: a healthy
 * listing names each item once, and a doubled id would let one item read as
 * two matches.
 */
export function interpretLoginItemList(
	text: string,
): readonly CredentialItemCandidateReading[] | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	if (!Array.isArray(parsed) || parsed.length > candidateListLimit) return undefined
	const candidates: CredentialItemCandidateReading[] = []
	for (const entry of parsed) {
		const candidate = interpretCandidate(entry)
		if (candidate === undefined) return undefined
		if (candidates.some((seen) => seen.id === candidate.id)) return undefined
		candidates.push(candidate)
	}
	return candidates
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
 * One item of an `op item get` reply as the small record the matching needs,
 * or `undefined` when it is not interpretable. Nothing is repaired: an item
 * this reading cannot vouch for whole is not vouched for in part.
 */
function interpretLoginItem(parsed: unknown): CredentialItemReading | undefined {
	const candidate = interpretCandidate(parsed)
	const fields = itemFields(record(parsed)?.fields)
	return candidate === undefined || fields === undefined ? undefined : { ...candidate, fields }
}

/** One full item detail reply, or `undefined` when it is not one whole item. */
export function interpretLoginItemDetail(text: string): CredentialItemReading | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	return interpretLoginItem(parsed)
}

interface SanitizedCredentialDetailReply {
	readonly schemaVersion: 1
	readonly status: "sanitized"
	readonly detail: {
		readonly id: string
		readonly vault: { readonly id: string; readonly name: string }
		readonly urls: readonly { readonly href: string }[]
		readonly fields: readonly { readonly id: string; readonly purpose: string }[]
	}
}

interface SanitizedCredentialListReply {
	readonly schemaVersion: 1
	readonly status: "sanitized"
	readonly candidates: readonly {
		readonly id: string
		readonly vault: { readonly id: string; readonly name: string }
		readonly urls: readonly { readonly href: string }[]
	}[]
}

/** The one closed non-secret reply a healthy Login-list sanitizer prints. */
export function sanitizedCredentialListReply(
	candidates: readonly CredentialItemCandidateReading[],
): string {
	const reply: SanitizedCredentialListReply = {
		schemaVersion: 1,
		status: "sanitized",
		candidates: candidates.map((candidate) => ({
			id: candidate.id,
			vault: { id: candidate.vaultId, name: candidate.vaultName },
			urls: candidate.declaredOrigins.map((href) => ({ href })),
		})),
	}
	return `${JSON.stringify(reply)}\n`
}

/** The one closed non-secret reply a healthy sanitizer prints. */
export function sanitizedCredentialDetailReply(detail: CredentialItemReading): string {
	const reply: SanitizedCredentialDetailReply = {
		schemaVersion: 1,
		status: "sanitized",
		detail: {
			id: detail.id,
			vault: { id: detail.vaultId, name: detail.vaultName },
			urls: detail.declaredOrigins.map((href) => ({ href })),
			fields: detail.fields
				.filter(({ purpose }) => purpose === "USERNAME" || purpose === "PASSWORD")
				.map(({ id, purpose }) => ({ id, purpose })),
		},
	}
	return `${JSON.stringify(reply)}\n`
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort()
	const expected = [...keys].sort()
	return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** Reads one exact top-level sanitizer envelope and returns its named payload. */
function sanitizedPayload(raw: string, payloadName: "candidates" | "detail"): unknown {
	if (raw.length > credentialWrapperOutputLimit) return undefined
	const text = raw.trim()
	if (text === "" || text.includes("\n")) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	const reply = record(parsed)
	if (
		reply === undefined ||
		!hasExactKeys(reply, ["schemaVersion", "status", payloadName]) ||
		reply.schemaVersion !== 1 ||
		reply.status !== "sanitized"
	) {
		return undefined
	}
	return reply[payloadName]
}

/**
 * Interprets the Login-list sanitizer's closed reply in its parent. An item
 * title, subtitle, additional-information value, or unknown property cannot
 * cross this seam because every record is checked for exact keys first.
 */
export function interpretSanitizedCredentialList(
	raw: string,
): readonly CredentialItemCandidateReading[] | undefined {
	const candidates = sanitizedPayload(raw, "candidates")
	if (!Array.isArray(candidates)) return undefined
	for (const candidate of candidates) {
		const item = record(candidate)
		const vault = record(item?.vault)
		if (
			item === undefined ||
			!hasExactKeys(item, ["id", "vault", "urls"]) ||
			vault === undefined ||
			!hasExactKeys(vault, ["id", "name"]) ||
			!Array.isArray(item.urls)
		) {
			return undefined
		}
		for (const url of item.urls) {
			const entry = record(url)
			if (entry === undefined || !hasExactKeys(entry, ["href"])) return undefined
		}
	}
	return interpretLoginItemList(JSON.stringify(candidates))
}

/**
 * Interprets the sanitizer's closed reply in its parent. Exact keys are part
 * of the interface: an extra title, value, note, or future field is rejected
 * rather than allowed to carry detail bytes across the process seam.
 */
export function interpretSanitizedCredentialDetail(
	raw: string,
): CredentialItemReading | undefined {
	const detail = record(sanitizedPayload(raw, "detail"))
	const vault = record(detail?.vault)
	if (
		detail === undefined ||
		!hasExactKeys(detail, ["id", "vault", "urls", "fields"]) ||
		vault === undefined ||
		!hasExactKeys(vault, ["id", "name"]) ||
		!Array.isArray(detail.urls) ||
		!Array.isArray(detail.fields)
	) {
		return undefined
	}
	for (const url of detail.urls) {
		const entry = record(url)
		if (entry === undefined || !hasExactKeys(entry, ["href"])) return undefined
	}
	for (const field of detail.fields) {
		const entry = record(field)
		if (
			entry === undefined ||
			!hasExactKeys(entry, ["id", "purpose"]) ||
			(entry.purpose !== "USERNAME" && entry.purpose !== "PASSWORD")
		) {
			return undefined
		}
	}
	return interpretLoginItemDetail(JSON.stringify(detail))
}

/**
 * Whether one item declares the current exact origin. Equality is `===` on
 * the whole origin, so scheme, host, and port must all agree: a different
 * scheme, a parent domain, a sub-domain, an explicit non-default port, and a
 * path-only difference are all decided by this one comparison. Nothing is
 * normalised, stripped, or prefix-matched, and hostnames are never compared
 * on their own.
 */
export function declaresExactOrigin(
	item: Pick<CredentialItemReading, "declaredOrigins">,
	origin: string,
): boolean {
	return item.declaredOrigins.some((declared) => declared === origin)
}
