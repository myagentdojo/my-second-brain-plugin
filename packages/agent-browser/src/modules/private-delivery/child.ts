import { fillValueLimit } from "../warm-browser/bounds"
import { type CdpChannel, openCdpChannel } from "../warm-browser/cdp-channel"
import { isAddressableTargetId } from "../warm-browser/controlled-page"
import type { DomNodeDescription } from "../warm-browser/credential-fields"
import type { PrivateDeliveryChildOutcome } from "./contract"
import { type CredentialFieldKind, credentialFieldKind } from "./field-kind"

/**
 * The disposable Private Delivery child.
 *
 * This is a private re-entry of the one shipped entry, selected in `main.ts`
 * by an argument the public parser never sees, so one bundle still ships and
 * the Command Vocabulary stays closed; `help` never names it. It is a
 * confinement boundary rather than an authorisation one: the argument list
 * carries no secret, and a local caller who can run this executable can
 * already reach the CDP port. What the boundary buys is a process that holds
 * the secret for one fill and then stops existing, with nothing else in it
 * for the secret to reach.
 *
 * The child re-reads the page with its own minimal readers rather than
 * importing Warm Browser's, because the revalidation immediately before the
 * fill is its own duty: it is the last thing between the secret and the page,
 * and it takes nothing about that page on trust from its parent. Only the
 * transport is shared, because `cdp-channel.ts` carries no policy and the
 * socket contract is the same one.
 *
 * The child writes no file, opens no other socket, and creates no other
 * process. It answers with exactly one JSON line on stdout, from the closed
 * reply set, carrying no value, no length, and no page text beyond the
 * outcome; it writes nothing on stderr; and it exits 0 for delivered, 2 for a
 * rejected argument list, and 1 otherwise.
 */

export const privateDeliveryChildArgument = "--deliver-one-credential-field"

const controlCharacter = /\p{Cc}/u

/** Prints the one reply line and answers with the child's exit code. */
function say(outcome: Exclude<PrivateDeliveryChildOutcome, "delivered">): number {
	process.stdout.write(`${JSON.stringify({ outcome })}\n`)
	return outcome === "usage" ? 2 : 1
}

/**
 * Delivery is reported with what the read-back proved, and with nothing else:
 * whether the field now holds a value is the whole shape of the fill.
 */
function sayDelivered(fieldNowHoldsValue: boolean): number {
	process.stdout.write(`${JSON.stringify({ outcome: "delivered", fieldNowHoldsValue })}\n`)
	return 0
}

interface ChildArguments {
	readonly port: number
	readonly targetId: string
	readonly backendNodeId: number
	readonly frameId: string
	readonly loaderId: string
	readonly url: string
	readonly origin: string
	readonly field: CredentialFieldKind
}

/** Every flag the child accepts; each one names a value and appears once. */
const childOptionFlags = [
	"--port",
	"--target",
	"--node",
	"--frame",
	"--loader",
	"--url",
	"--origin",
	"--field",
] as const

/** A frame or loader identity or an origin the child will compare against. */
function identityArgument(value: string): string | undefined {
	return value === "" || value.length > 2_048 || controlCharacter.test(value) ||
			/\s/u.test(value)
		? undefined
		: value
}

/**
 * The child's own strict parser. Any unknown, repeated, missing, or
 * out-of-domain argument is one usage answer, because the caller of this
 * process is this Module's own parent: a list it would not have composed is a
 * defect, not a negotiation.
 */
function parseChildArguments(argumentList: readonly string[]): ChildArguments | undefined {
	const seen = new Map<string, string>()
	for (let index = 0; index < argumentList.length; index += 2) {
		const flag = argumentList[index]
		const value = argumentList[index + 1]
		if (flag === undefined || value === undefined) return undefined
		if (!(childOptionFlags as readonly string[]).includes(flag)) return undefined
		if (seen.has(flag)) return undefined
		seen.set(flag, value)
	}
	if (seen.size !== childOptionFlags.length) return undefined
	const portText = seen.get("--port")!
	if (!/^[0-9]{1,5}$/.test(portText)) return undefined
	const port = Number(portText)
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined
	const targetId = seen.get("--target")!
	if (!isAddressableTargetId(targetId)) return undefined
	const nodeText = seen.get("--node")!
	if (!/^[0-9]{1,15}$/.test(nodeText)) return undefined
	const backendNodeId = Number(nodeText)
	if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 1) return undefined
	const frameId = identityArgument(seen.get("--frame")!)
	const loaderId = identityArgument(seen.get("--loader")!)
	const origin = identityArgument(seen.get("--origin")!)
	if (frameId === undefined || loaderId === undefined || origin === undefined) return undefined
	const url = seen.get("--url")!
	if (url === "" || url.length > 2_048 || controlCharacter.test(url)) return undefined
	const field = seen.get("--field")!
	if (field !== "username" && field !== "password") return undefined
	return { port, targetId, backendNodeId, frameId, loaderId, url, origin, field }
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function nonEmptyText(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined
}

interface FrameBasis {
	readonly frameId: string
	readonly loaderId: string
	readonly url: string
}

async function readFrame(channel: CdpChannel): Promise<FrameBasis | undefined> {
	const reply = await channel.call("Page.getFrameTree", {})
	if (!reply.ok) return undefined
	const frame = record(record(record(reply.result)?.frameTree)?.frame)
	const frameId = nonEmptyText(frame?.id)
	const loaderId = nonEmptyText(frame?.loaderId)
	const url = nonEmptyText(frame?.url)
	return frameId === undefined || loaderId === undefined || url === undefined
		? undefined
		: { frameId, loaderId, url }
}

/**
 * Whether one frame reading is the exact document the child was given: the
 * same frame, the same document load, the same address. The origin is outside
 * this question, because the two checks that share it need it differently:
 * `checkFrame` asks the origin first, and the post-fill check never asks it
 * at all.
 */
function isExactDocument(frame: FrameBasis, arguments_: ChildArguments): boolean {
	return frame.frameId === arguments_.frameId &&
		frame.loaderId === arguments_.loaderId &&
		frame.url === arguments_.url
}

/**
 * What one frame reading says about the identity the child was given.
 *
 * The origin is asked first, because a page that moved across origins and one
 * that moved within its own are different events and the caller needs them
 * apart. The exact origin is the whole basis of the Credential Match, so a
 * document served from somewhere else is the fact that matters most about the
 * page, and asking the whole address first would bury it: every cross-origin
 * move changes the address too, so the address would always answer first and
 * the origin never would. An address this reading cannot parse has no origin
 * to be the matched one, which is the same answer.
 */
function checkFrame(
	frame: FrameBasis,
	arguments_: ChildArguments,
): "same" | "identity_changed" | "origin_changed" {
	let origin: string
	try {
		origin = new URL(frame.url).origin
	} catch {
		return "origin_changed"
	}
	if (origin !== arguments_.origin) return "origin_changed"
	return isExactDocument(frame, arguments_) ? "same" : "identity_changed"
}

function attributeMap(attributes: unknown): Record<string, string> {
	const flat = Array.isArray(attributes) ? attributes : []
	const map: Record<string, string> = {}
	for (let index = 0; index + 1 < flat.length; index += 2) {
		const name = flat[index]
		const value = flat[index + 1]
		if (typeof name === "string" && typeof value === "string") map[name] = value
	}
	return map
}

async function describeNode(
	channel: CdpChannel,
	backendNodeId: number,
): Promise<DomNodeDescription | undefined> {
	const reply = await channel.call("DOM.describeNode", { backendNodeId })
	if (!reply.ok) return undefined
	const node = record(record(reply.result)?.node)
	const nodeName = nonEmptyText(node?.nodeName)
	return node === undefined || nodeName === undefined
		? undefined
		: { nodeName, attributes: attributeMap(node.attributes) }
}

/**
 * What the page says about the field: the name a reader would hear, whether
 * it already holds text, and whether it holds focus. The text itself never
 * leaves the reading; whether the field is empty is all any decision needs.
 */
interface FieldAccessibility {
	readonly name: string
	readonly focused: boolean
}

async function readField(
	channel: CdpChannel,
	backendNodeId: number,
): Promise<FieldAccessibility | undefined> {
	const reply = await channel.call("Accessibility.getPartialAXTree", {
		backendNodeId,
		fetchRelatives: false,
	})
	if (!reply.ok) return undefined
	const nodes = record(reply.result)?.nodes
	if (!Array.isArray(nodes)) return undefined
	for (const entry of nodes) {
		const node = record(entry)
		// The reply may carry ancestors as well, so the field is selected by
		// identity rather than by position.
		if (node === undefined || node.backendDOMNodeId !== backendNodeId) continue
		const name = record(node.name)?.value
		const properties = Array.isArray(node.properties) ? node.properties : []
		const focused = properties.some((property) => {
			const reading = record(property)
			return reading?.name === "focused" && record(reading.value)?.value === true
		})
		return {
			name: typeof name === "string" ? name : "",
			focused,
		}
	}
	return undefined
}

/**
 * Whether the live node holds text, without bringing that text across CDP.
 *
 * Accessibility is still the source for the field name and focus, but a
 * partial AX tree is a reading of the control rather than of the property the
 * fill wrote, and a Login control that does not publish its value there would
 * read as an unfilled field. Whether any given control does that is not proved
 * here. Resolving the exact backend node and asking the page for one boolean
 * keeps the proof bound to that field and to the property `insertText`
 * mutated, while leaving the credential value in the page. The object is owned
 * by this socket and disappears when the child closes it, so it is never
 * retained beyond this one question.
 */
async function fieldHoldsValue(
	channel: CdpChannel,
	backendNodeId: number,
): Promise<boolean | undefined> {
	const resolved = await channel.call("DOM.resolveNode", { backendNodeId })
	const objectId = nonEmptyText(record(record(resolved.result)?.object)?.objectId)
	if (!resolved.ok || objectId === undefined) return undefined
	const reply = await channel.call("Runtime.callFunctionOn", {
		objectId,
		functionDeclaration: `function () {
			const value = "value" in this ? this.value : this.textContent
			return typeof value === "string" && value.length > 0
		}`,
		returnByValue: true,
	})
	const result = record(record(reply.result)?.result)
	return reply.ok && result?.type === "boolean" && typeof result.value === "boolean"
		? result.value
		: undefined
}

/**
 * Runs one private delivery and answers with the process exit code.
 *
 * The delivered value is read once from standard input, held in exactly one
 * binding, passed straight to the page, and never logged, never returned,
 * never concatenated into a message, and never compared against anything but
 * its own bounds.
 */
export async function runPrivateDeliveryChild(argumentList: readonly string[]): Promise<number> {
	const arguments_ = parseChildArguments(argumentList)
	if (arguments_ === undefined) return say("usage")
	const deliveredValue = await Bun.stdin.text()
	// Refused before anything is said to the page: a value outside the bounds a
	// fill works within is not a value the referenced field could take.
	if (
		deliveredValue === "" ||
		deliveredValue.length > fillValueLimit ||
		controlCharacter.test(deliveredValue)
	) {
		return say("field_mismatch")
	}
	// The address is computed here, exactly as the Controlled Page conversation
	// computes it, never taken from anything the endpoint advertises.
	const connection = await openCdpChannel(
		`ws://127.0.0.1:${arguments_.port}/devtools/page/${arguments_.targetId}`,
	)
	if (connection.kind === "unavailable") return say("unverified")
	try {
		return await deliverIntoPage(connection.channel, arguments_, deliveredValue)
	} catch {
		return say("unverified")
	} finally {
		connection.channel.close()
	}
}

async function deliverIntoPage(
	channel: CdpChannel,
	arguments_: ChildArguments,
	deliveredValue: string,
): Promise<number> {
	for (const method of ["Page.enable", "DOM.enable", "Accessibility.enable"]) {
		if (!(await channel.call(method, {})).ok) return say("unverified")
	}
	// The revalidation immediately before the fill: the page must still be the
	// exact document and origin the parent proved, or the secret goes nowhere.
	const first = await readFrame(channel)
	if (first === undefined) return say("unverified")
	const firstAnswer = checkFrame(first, arguments_)
	if (firstAnswer !== "same") return say(firstAnswer)
	const description = await describeNode(channel, arguments_.backendNodeId)
	if (description === undefined) return say("element_absent")
	const field = await readField(channel, arguments_.backendNodeId)
	if (field === undefined) return say("unverified")
	// The kind is re-derived from the live page, not taken from the parent's
	// reading: a field the page renamed between the two processes is refused.
	if (credentialFieldKind(description, field.name) !== arguments_.field) {
		return say("field_mismatch")
	}
	const initiallyHoldsValue = await fieldHoldsValue(channel, arguments_.backendNodeId)
	if (initiallyHoldsValue === undefined) return say("unverified")
	if (initiallyHoldsValue) return say("field_not_empty")
	// The identity is proved once more after the reads above, so a navigation
	// that landed during them never receives the value.
	const second = await readFrame(channel)
	if (second === undefined) return say("unverified")
	const secondAnswer = checkFrame(second, arguments_)
	if (secondAnswer !== "same") return say(secondAnswer)
	if (!(await channel.call("DOM.focus", { backendNodeId: arguments_.backendNodeId })).ok) {
		return say("unverified")
	}
	// Focus is asked for and then read back, because asking is not the same as
	// getting it, and the value goes wherever focus went.
	const focused = await readField(channel, arguments_.backendNodeId)
	if (focused === undefined || !focused.focused) return say("unverified")
	if (!(await channel.call("Input.insertText", { text: deliveredValue })).ok) {
		return say("unverified")
	}
	// A page that moved after the value entered it is never reported as
	// delivery: the document the caller referenced is gone, and it is the
	// wrong one whatever its origin, so the origin is not asked here.
	const after = await readFrame(channel)
	if (after === undefined) return say("unverified")
	if (!isExactDocument(after, arguments_)) return say("superseded")
	const holdsValue = await fieldHoldsValue(channel, arguments_.backendNodeId)
	if (holdsValue === undefined) return say("unverified")
	return sayDelivered(holdsValue)
}
