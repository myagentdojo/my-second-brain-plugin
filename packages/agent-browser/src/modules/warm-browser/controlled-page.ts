import { snapshotElementLimit, snapshotTextLimit } from "./bounds"
import { type CdpChannel, openCdpChannel } from "./cdp-channel"
import type {
	ControlledPageBasis,
	ControlledPageElement,
	PageActionOutcome,
	PageNavigation,
	PageSnapshotReading,
} from "./contract"
import { type DomNodeDescription, isCredentialField } from "./credential-fields"

/**
 * Everything Warm Browser says to its one Controlled Page, and every reading it
 * takes from the replies.
 *
 * The Module reaches the page by an address it computes itself, never by one
 * the endpoint hands it, and it proves the page identity before and after every
 * act. A reply it cannot interpret, a page whose identity moved, and an element
 * that is no longer there are three different answers, and none of them is
 * "done".
 */

/**
 * The addresses a Controlled Page target may have. A target identity is put
 * into a URL, so anything that could steer that URL somewhere else is not an
 * identity this Module will address.
 */
const addressableTargetId = /^[A-Za-z0-9_-]{1,128}$/

export function isAddressableTargetId(value: unknown): value is string {
	return typeof value === "string" && addressableTargetId.test(value)
}

/**
 * The roles a snapshot always carries. A node outside this list still enters
 * the snapshot when the page reports it focusable or when it is a credential
 * field, so nothing a caller could act on is silently missing.
 */
const actionableRoles = [
	"button",
	"checkbox",
	"combobox",
	"link",
	"listbox",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"radio",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textarea",
	"textbox",
] as const

interface AccessibilityNodeReading {
	readonly role: string
	readonly name: string
	readonly focusable: boolean
	readonly ignored: boolean
	readonly backendNodeId: number
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function nonEmptyText(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined
}

/** Collapses page-authored text into one bounded single-line value. */
function readableText(value: unknown): string {
	if (typeof value !== "string") return ""
	return value.replaceAll(/\s+/gu, " ").trim().slice(0, snapshotTextLimit)
}

function readBasisReply(targetId: string, reply: unknown): ControlledPageBasis | undefined {
	const frame = record(record(record(reply)?.frameTree)?.frame)
	const frameId = nonEmptyText(frame?.id)
	const loaderId = nonEmptyText(frame?.loaderId)
	const url = nonEmptyText(frame?.url)
	return frameId === undefined || loaderId === undefined || url === undefined
		? undefined
		: { targetId, frameId, loaderId, url }
}

export function sameBasis(left: ControlledPageBasis, right: ControlledPageBasis): boolean {
	return (
		left.targetId === right.targetId &&
		left.frameId === right.frameId &&
		left.loaderId === right.loaderId &&
		left.url === right.url
	)
}

async function readBasis(
	channel: CdpChannel,
	targetId: string,
): Promise<ControlledPageBasis | undefined> {
	const reply = await channel.call("Page.getFrameTree", {})
	return reply.ok ? readBasisReply(targetId, reply.result) : undefined
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

function describedNode(node: Record<string, unknown>): DomNodeDescription | undefined {
	const nodeName = nonEmptyText(node.nodeName)
	return nodeName === undefined
		? undefined
		: { nodeName, attributes: attributeMap(node.attributes) }
}

/** Flattens one document reply into every node it describes, keyed by identity. */
function documentDescriptions(reply: unknown): Map<number, DomNodeDescription> | undefined {
	const root = record(record(reply)?.root)
	if (root === undefined) return undefined
	const descriptions = new Map<number, DomNodeDescription>()
	const queue: Record<string, unknown>[] = [root]
	while (queue.length > 0) {
		const node = queue.pop()!
		const backendNodeId = node.backendNodeId
		const description = describedNode(node)
		if (typeof backendNodeId === "number" && description !== undefined) {
			descriptions.set(backendNodeId, description)
		}
		for (const key of ["children", "shadowRoots", "pseudoElements"] as const) {
			const children = node[key]
			if (!Array.isArray(children)) continue
			for (const child of children) {
				const childRecord = record(child)
				if (childRecord !== undefined) queue.push(childRecord)
			}
		}
		const contentDocument = record(node.contentDocument)
		if (contentDocument !== undefined) queue.push(contentDocument)
	}
	return descriptions
}

function accessibilityNodes(reply: unknown): readonly AccessibilityNodeReading[] | undefined {
	const nodes = record(reply)?.nodes
	if (!Array.isArray(nodes)) return undefined
	const readings: AccessibilityNodeReading[] = []
	for (const entry of nodes) {
		const node = record(entry)
		if (node === undefined) return undefined
		const backendNodeId = node.backendDOMNodeId
		if (typeof backendNodeId !== "number" || !Number.isSafeInteger(backendNodeId)) continue
		const properties = Array.isArray(node.properties) ? node.properties : []
		const focusable = properties.some((property) => {
			const entryRecord = record(property)
			return entryRecord?.name === "focusable" && record(entryRecord.value)?.value === true
		})
		readings.push({
			role: readableText(record(node.role)?.value),
			name: readableText(record(node.name)?.value),
			focusable,
			ignored: node.ignored === true,
			backendNodeId,
		})
	}
	return readings
}

/**
 * Interprets one accessibility reading and one document reading as the elements
 * a caller may act on. A credential field is always carried, whatever the page
 * says about its role, so `fill` can refuse it by name rather than by absence.
 */
function interpretElements(
	nodes: readonly AccessibilityNodeReading[],
	descriptions: Map<number, DomNodeDescription>,
): { readonly elements: readonly ControlledPageElement[]; readonly truncated: boolean } {
	const elements: ControlledPageElement[] = []
	let truncated = false
	for (const node of nodes) {
		if (node.ignored) continue
		const description = descriptions.get(node.backendNodeId)
		const credentialField = description !== undefined && isCredentialField(description)
		const actionable = node.focusable ||
			(actionableRoles as readonly string[]).includes(node.role)
		if (!actionable && !credentialField) continue
		if (elements.length === snapshotElementLimit) {
			truncated = true
			break
		}
		elements.push({
			backendNodeId: node.backendNodeId,
			role: node.role,
			name: node.name,
			credentialField,
		})
	}
	return { elements, truncated }
}

/**
 * Opens one conversation with the Controlled Page at an address this Module
 * computes. The endpoint's own advertised socket is never dialled, so an
 * endpoint that names somewhere else cannot send Warm Browser there.
 */
async function withControlledPage<T>(
	port: number,
	targetId: string,
	unverified: T,
	work: (channel: CdpChannel) => Promise<T>,
): Promise<T> {
	if (!isAddressableTargetId(targetId)) return unverified
	const connection = await openCdpChannel(`ws://127.0.0.1:${port}/devtools/page/${targetId}`)
	if (connection.kind === "unavailable") return unverified
	try {
		return await work(connection.channel)
	} catch {
		return unverified
	} finally {
		connection.channel.close()
	}
}

export async function openControlledPage(input: {
	readonly port: number
	readonly targetId: string
	readonly url: string
}): Promise<PageNavigation> {
	return await withControlledPage<PageNavigation>(
		input.port,
		input.targetId,
		{ kind: "unverified" },
		async (channel) => {
			if (!(await channel.call("Page.enable", {})).ok) return { kind: "unverified" }
			const navigation = await channel.call("Page.navigate", { url: input.url })
			if (!navigation.ok) return { kind: "unverified" }
			if (nonEmptyText(record(navigation.result)?.errorText) !== undefined) {
				return { kind: "refused" }
			}
			const basis = await readBasis(channel, input.targetId)
			return basis === undefined ? { kind: "unverified" } : { kind: "navigated", basis }
		},
	)
}

export async function readControlledPageSnapshot(input: {
	readonly port: number
	readonly targetId: string
}): Promise<PageSnapshotReading> {
	return await withControlledPage<PageSnapshotReading>(
		input.port,
		input.targetId,
		{ kind: "unverified" },
		async (channel) => {
			for (const method of ["Page.enable", "DOM.enable", "Accessibility.enable"]) {
				if (!(await channel.call(method, {})).ok) return { kind: "unverified" }
			}
			const before = await readBasis(channel, input.targetId)
			if (before === undefined) return { kind: "unverified" }
			const document = await channel.call("DOM.getDocument", { depth: -1, pierce: false })
			if (!document.ok) return { kind: "unverified" }
			const descriptions = documentDescriptions(document.result)
			if (descriptions === undefined) return { kind: "unverified" }
			const tree = await channel.call("Accessibility.getFullAXTree", {})
			if (!tree.ok) return { kind: "unverified" }
			const nodes = accessibilityNodes(tree.result)
			if (nodes === undefined) return { kind: "unverified" }
			// The readings describe the page as it was a moment ago. If it moved
			// while they were taken, they describe a page that no longer exists and
			// no reference may be minted against them.
			const after = await readBasis(channel, input.targetId)
			if (after === undefined) return { kind: "unverified" }
			if (!sameBasis(before, after)) return { kind: "identity_changed" }
			const { elements, truncated } = interpretElements(nodes, descriptions)
			return { kind: "observed", basis: after, elements, truncated }
		},
	)
}

export type ControlledPageAction =
	| { readonly kind: "click" }
	| { readonly kind: "fill"; readonly value: string }

/**
 * Acts on one element of the Controlled Page, having proved twice over that it
 * is acting on what the caller named: the page identity still equals the one
 * the reference was issued against, and the live element is still described the
 * way the refusal rules require.
 */
export async function actOnControlledPage(input: {
	readonly port: number
	readonly targetId: string
	readonly basis: ControlledPageBasis
	readonly backendNodeId: number
	readonly action: ControlledPageAction
}): Promise<PageActionOutcome> {
	return await withControlledPage<PageActionOutcome>(
		input.port,
		input.targetId,
		{ kind: "unverified" },
		async (channel) => {
			for (const method of ["Page.enable", "DOM.enable"]) {
				if (!(await channel.call(method, {})).ok) return { kind: "unverified" }
			}
			const before = await readBasis(channel, input.targetId)
			if (before === undefined) return { kind: "unverified" }
			if (!sameBasis(before, input.basis)) return { kind: "identity_changed" }
			const described = await channel.call("DOM.describeNode", {
				backendNodeId: input.backendNodeId,
			})
			if (!described.ok) return { kind: "element_absent" }
			const description = describedNode(record(record(described.result)?.node) ?? {})
			if (description === undefined) return { kind: "element_absent" }
			if (input.action.kind === "fill" && isCredentialField(description)) {
				return { kind: "credential_field" }
			}
			if (input.action.kind === "click") {
				const box = await channel.call("DOM.getBoxModel", { backendNodeId: input.backendNodeId })
				if (!box.ok) return { kind: "element_absent" }
				const content = record(record(box.result)?.model)?.content
				if (!Array.isArray(content) || content.length < 8) return { kind: "element_absent" }
				const points = content.slice(0, 8)
				if (!points.every((value) => typeof value === "number" && Number.isFinite(value))) {
					return { kind: "element_absent" }
				}
				const x = (points[0]! + points[2]! + points[4]! + points[6]!) / 4
				const y = (points[1]! + points[3]! + points[5]! + points[7]!) / 4
				for (const type of ["mousePressed", "mouseReleased"] as const) {
					const dispatched = await channel.call("Input.dispatchMouseEvent", {
						type,
						x,
						y,
						button: "left",
						buttons: type === "mousePressed" ? 1 : 0,
						clickCount: 1,
					})
					if (!dispatched.ok) return { kind: "unverified" }
				}
			} else {
				if (!(await channel.call("DOM.focus", { backendNodeId: input.backendNodeId })).ok) {
					return { kind: "element_absent" }
				}
				if (!(await channel.call("Input.insertText", { text: input.action.value })).ok) {
					return { kind: "unverified" }
				}
			}
			const after = await readBasis(channel, input.targetId)
			return after === undefined ? { kind: "unverified" } : { kind: "acted", basis: after }
		},
	)
}
