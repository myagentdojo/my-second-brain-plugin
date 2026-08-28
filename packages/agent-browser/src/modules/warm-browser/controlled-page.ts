import { Buffer } from "node:buffer"

import { screenshotBase64Limit, snapshotElementLimit, snapshotTextLimit } from "./bounds"
import { type CdpChannel, openCdpChannel } from "./cdp-channel"
import type {
	ControlledPageBasis,
	ControlledPageElement,
	PageActionOutcome,
	PageCapture,
	PageNavigation,
	PageSnapshotReading,
	UndeliverableAct,
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

/**
 * What one document reading says: how each node is described, and which node
 * each one sits inside.
 *
 * The read pierces shadow roots, because a password field inside one is a
 * password field and a snapshot that could not see it would publish it as
 * ordinary. Every container the reply nests is followed for the same reason.
 */
interface DocumentReading {
	readonly descriptions: Map<number, DomNodeDescription>
	readonly parents: Map<number, number>
}

function documentReading(reply: unknown): DocumentReading | undefined {
	const root = record(record(reply)?.root)
	if (root === undefined) return undefined
	const descriptions = new Map<number, DomNodeDescription>()
	const parents = new Map<number, number>()
	const queue: { readonly node: Record<string, unknown>; readonly parent: number | undefined }[] = [
		{ node: root, parent: undefined },
	]
	while (queue.length > 0) {
		const { node, parent } = queue.pop()!
		const backendNodeId = node.backendNodeId
		const identified = typeof backendNodeId === "number" ? backendNodeId : undefined
		const description = describedNode(node)
		if (identified !== undefined) {
			if (description !== undefined) descriptions.set(identified, description)
			if (parent !== undefined) parents.set(identified, parent)
		}
		const nested = identified ?? parent
		for (const key of ["children", "shadowRoots", "pseudoElements"] as const) {
			for (const child of Array.isArray(node[key]) ? (node[key] as unknown[]) : []) {
				const childRecord = record(child)
				if (childRecord !== undefined) queue.push({ node: childRecord, parent: nested })
			}
		}
		const contentDocument = record(node.contentDocument)
		if (contentDocument !== undefined) queue.push({ node: contentDocument, parent: nested })
	}
	return { descriptions, parents }
}

async function readDocument(channel: CdpChannel): Promise<DocumentReading | undefined> {
	const document = await channel.call("DOM.getDocument", { depth: -1, pierce: true })
	return document.ok ? documentReading(document.result) : undefined
}

/** Whether one node sits inside another, so a hit on it is a hit on that one. */
function isWithin(parents: Map<number, number>, node: number, ancestor: number): boolean {
	let current: number | undefined = node
	for (let step = 0; step < 128 && current !== undefined; step += 1) {
		if (current === ancestor) return true
		current = parents.get(current)
	}
	return false
}

/** Whether the page reports one boolean accessibility property as true. */
function hasProperty(node: Record<string, unknown>, name: string): boolean {
	const properties = Array.isArray(node.properties) ? node.properties : []
	return properties.some((property) => {
		const entry = record(property)
		return entry?.name === name && record(entry.value)?.value === true
	})
}

/**
 * What the page says about one node in its accessibility tree: the name a
 * reader would hear, whether it already holds text, and whether it holds focus.
 *
 * The text itself is never carried out of this reading. Whether a field is
 * empty is all any decision here needs, and page content that could be a secret
 * has no reason to travel further than the question about it.
 */
interface NodeAccessibility {
	readonly name: string
	readonly holdsValue: boolean
	readonly focused: boolean
}

function nodeAccessibility(reply: unknown, backendNodeId: number): NodeAccessibility | undefined {
	const nodes = record(reply)?.nodes
	if (!Array.isArray(nodes)) return undefined
	for (const entry of nodes) {
		const node = record(entry)
		// The reply may carry ancestors as well, so the node the caller asked about
		// is selected by identity rather than by position.
		if (node === undefined || node.backendDOMNodeId !== backendNodeId) continue
		const value = record(node.value)?.value
		return {
			name: readableText(record(node.name)?.value),
			holdsValue: typeof value === "string" && value !== "",
			focused: hasProperty(node, "focused"),
		}
	}
	return undefined
}

async function readNodeAccessibility(
	channel: CdpChannel,
	backendNodeId: number,
): Promise<NodeAccessibility | undefined> {
	const reply = await channel.call("Accessibility.getPartialAXTree", {
		backendNodeId,
		fetchRelatives: false,
	})
	return reply.ok ? nodeAccessibility(reply.result, backendNodeId) : undefined
}

function accessibilityNodes(reply: unknown): readonly AccessibilityNodeReading[] | undefined {
	const nodes = record(reply)?.nodes
	if (!Array.isArray(nodes)) return undefined
	const readings: AccessibilityNodeReading[] = []
	for (const entry of nodes) {
		const node = record(entry)
		if (node === undefined) return undefined
		// A node identity outside the range a receipt may carry is no identity: it
		// could not be written down, so the element it names cannot be referenced
		// and is left out rather than failing the whole reading.
		const backendNodeId = node.backendDOMNodeId
		if (
			typeof backendNodeId !== "number" || !Number.isSafeInteger(backendNodeId) ||
			backendNodeId < 1
		) continue
		readings.push({
			role: readableText(record(node.role)?.value),
			name: readableText(record(node.name)?.value),
			focusable: hasProperty(node, "focusable"),
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
		const credentialField = isCredentialField(description, node.name)
		const actionable = node.focusable ||
			(actionableRoles as readonly string[]).includes(node.role)
		// An element a caller can act on always enters the snapshot, and one it
		// cannot enters only when the page described it as credential material. An
		// undescribed node is credential by default, so it is never carried in on
		// that default alone.
		if (!actionable && !(description !== undefined && credentialField)) continue
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
			const accepted = record(navigation.result)
			if (nonEmptyText(accepted?.errorText) !== undefined) return { kind: "refused" }
			// The browser names the frame and the document load it started. Success
			// is bound to that identity and to nothing else, so a navigation that
			// another document wins in the meantime is never reported as this one:
			// the page would be somewhere the caller never asked to go.
			const frameId = nonEmptyText(accepted?.frameId)
			const loaderId = nonEmptyText(accepted?.loaderId)
			if (frameId === undefined || loaderId === undefined) return { kind: "unverified" }
			const basis = await readBasis(channel, input.targetId)
			if (basis === undefined) return { kind: "unverified" }
			return basis.frameId === frameId && basis.loaderId === loaderId
				? { kind: "navigated", basis }
				: { kind: "superseded" }
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
			const reading = await readDocument(channel)
			if (reading === undefined) return { kind: "unverified" }
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
			const { elements, truncated } = interpretElements(nodes, reading.descriptions)
			return { kind: "observed", basis: after, elements, truncated }
		},
	)
}

/**
 * The base64 alphabet and nothing else. Buffer's own decoder skips whatever it
 * does not recognise, so the answer is proved to be inside the alphabet before
 * it is decoded: bytes recovered from a string the page half-invented are not
 * an image of anything.
 */
const strictBase64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Captures the Controlled Page as one PNG image of its viewport. Nothing
 * beyond the viewport is asked for and no clip is named: the viewport is the
 * one bounded surface, and a capture allowed past it would be sized by the
 * page rather than by this Module.
 */
export async function captureControlledPage(input: {
	readonly port: number
	readonly targetId: string
}): Promise<PageCapture> {
	return await withControlledPage<PageCapture>(
		input.port,
		input.targetId,
		{ kind: "unverified" },
		async (channel) => {
			if (!(await channel.call("Page.enable", {})).ok) return { kind: "unverified" }
			const before = await readBasis(channel, input.targetId)
			if (before === undefined) return { kind: "unverified" }
			const captured = await channel.call("Page.captureScreenshot", { format: "png" })
			if (!captured.ok) return { kind: "unverified" }
			const data = record(captured.result)?.data
			if (typeof data !== "string" || data === "" || data.length > screenshotBase64Limit) {
				return { kind: "unverified" }
			}
			// The image describes the page as it was a moment ago. The identity is
			// proved again before the bytes are decoded, exactly as the snapshot
			// reading proves the page before it interprets anything: an image of a
			// page that moved describes a page that is gone.
			const after = await readBasis(channel, input.targetId)
			if (after === undefined) return { kind: "unverified" }
			if (!sameBasis(before, after)) return { kind: "identity_changed" }
			if (data.length % 4 !== 0 || !strictBase64.test(data)) return { kind: "unverified" }
			return { kind: "captured", basis: after, png: Buffer.from(data, "base64") }
		},
	)
}

export type ControlledPageAction =
	| { readonly kind: "click" }
	| { readonly kind: "fill"; readonly value: string }

/** What one act on one element did, before the page identity is read again. */
type ActionStep =
	| { readonly kind: "acted" }
	| { readonly kind: "element_absent" }
	| { readonly kind: "undeliverable"; readonly reason: UndeliverableAct }
	| { readonly kind: "unverified" }

function undeliverable(reason: UndeliverableAct): ActionStep {
	return { kind: "undeliverable", reason }
}

/**
 * What a step that stopped inside the act says about the Controlled Page.
 *
 * Nothing is dispatched before the act has asked the page for something: a click
 * brings its element into view first, and a fill asks for focus first. Both
 * change the page, and a call that did not answer is never proof that what it
 * asked for did not happen. So every step that stopped in there reports the page
 * touched, and the one place that decides it is here rather than at each reason.
 */
function touchedByAct(step: Exclude<ActionStep, { readonly kind: "acted" }>): PageActionOutcome {
	if (step.kind === "undeliverable") {
		return { kind: "undeliverable", reason: step.reason, touchedPage: true }
	}
	return step.kind === "element_absent"
		? { kind: "element_absent", touchedPage: true }
		: { kind: "unverified" }
}

/**
 * Whether a navigation this element caused is one the caller asked for.
 *
 * Clicking a link or a submit control navigates the page, and that is the act
 * working. Nothing else on a page navigates it by being clicked, and typing
 * never does, so a page that moved after any other act moved for a reason this
 * command cannot account for. The rule is deliberately narrow: an element whose
 * navigation cannot be explained is refused, and a refusal is recoverable.
 */
function mayNavigate(description: DomNodeDescription): boolean {
	const attributes = description.attributes
	const nodeName = description.nodeName.toUpperCase()
	const type = (attributes.type ?? "").trim().toLowerCase()
	if ((nodeName === "A" || nodeName === "AREA") && nonEmptyText(attributes.href) !== undefined) {
		return true
	}
	if (type === "submit" || type === "image") return true
	// A button with no type is a submit button, which is what HTML says it is.
	return nodeName === "BUTTON" && attributes.type === undefined
}

interface ClickPoint {
	readonly x: number
	readonly y: number
}

/**
 * One point on the element's own content, from the first quad the page reports
 * for it.
 *
 * A content quad is the area the element actually occupies, which a box drawn
 * around it is not: a wrapped link's box spans text belonging to other elements,
 * and its centre can sit outside the link entirely. The point is rounded to
 * whole numbers, because that is how the page is asked what is at it.
 */
function contentPoint(reply: unknown): ClickPoint | undefined {
	const quads = record(reply)?.quads
	const quad = Array.isArray(quads) ? quads[0] : undefined
	if (!Array.isArray(quad) || quad.length < 8) return undefined
	const corners = quad.slice(0, 8)
	if (!corners.every((value) => typeof value === "number" && Number.isFinite(value))) {
		return undefined
	}
	return {
		x: Math.round((corners[0]! + corners[2]! + corners[4]! + corners[6]!) / 4),
		y: Math.round((corners[1]! + corners[3]! + corners[5]! + corners[7]!) / 4),
	}
}

/**
 * Whether a click at this point would reach the element the caller referenced.
 *
 * The page is asked what is at the point, and the answer must be that element or
 * something nested inside it: the label inside a button is the button's own
 * content, and a hit on it is a hit on the button. Anything else is another
 * element covering it, and a click there is not the click that was asked for.
 *
 * This is also what makes the coordinates safe. The point is read in one space
 * and dispatched in another, and the two are only the same once the element is
 * in view; asking the page what is at the point closes that gap by refusing
 * rather than by guessing, because the hit test and the dispatch address the
 * page the same way.
 */
async function hitsReferencedNode(
	channel: CdpChannel,
	point: ClickPoint,
	backendNodeId: number,
): Promise<boolean> {
	const hit = await channel.call("DOM.getNodeForLocation", {
		x: point.x,
		y: point.y,
		includeUserAgentShadowDOM: false,
	})
	if (!hit.ok) return false
	const hitNodeId = record(hit.result)?.backendNodeId
	if (typeof hitNodeId !== "number") return false
	if (hitNodeId === backendNodeId) return true
	const reading = await readDocument(channel)
	return reading !== undefined && isWithin(reading.parents, hitNodeId, backendNodeId)
}

/**
 * Clicks a point proved to reach the referenced element, or says why it could
 * not. The element is brought into view first, because an element outside the
 * viewport cannot be clicked at all and a page that will not scroll to it is a
 * page this click cannot reach.
 */
async function clickNode(channel: CdpChannel, backendNodeId: number): Promise<ActionStep> {
	if (!(await channel.call("DOM.scrollIntoViewIfNeeded", { backendNodeId })).ok) {
		return undeliverable("click_target_unproved")
	}
	const quads = await channel.call("DOM.getContentQuads", { backendNodeId })
	if (!quads.ok) return { kind: "element_absent" }
	const point = contentPoint(quads.result)
	if (point === undefined) return undeliverable("click_target_unproved")
	if (!(await hitsReferencedNode(channel, point, backendNodeId))) {
		return undeliverable("click_target_unproved")
	}
	for (const type of ["mousePressed", "mouseReleased"] as const) {
		const dispatched = await channel.call("Input.dispatchMouseEvent", {
			type,
			x: point.x,
			y: point.y,
			button: "left",
			buttons: type === "mousePressed" ? 1 : 0,
			clickCount: 1,
		})
		if (!dispatched.ok) return { kind: "unverified" }
	}
	return { kind: "acted" }
}

/**
 * Types into the element, having proved the element is the one holding focus.
 *
 * Focus is asked for and then read back, because asking is not the same as
 * getting it: a focus handler or a focus trap can move focus to a field this
 * caller never named, and text goes wherever focus went. A field that did not
 * keep focus is refused before anything is typed.
 */
async function typeIntoNode(
	channel: CdpChannel,
	backendNodeId: number,
	value: string,
): Promise<ActionStep> {
	if (!(await channel.call("DOM.focus", { backendNodeId })).ok) {
		return undeliverable("field_not_focusable")
	}
	const focused = await readNodeAccessibility(channel, backendNodeId)
	if (focused === undefined) return undeliverable("field_unreadable")
	if (!focused.focused) return undeliverable("field_focus_moved")
	return (await channel.call("Input.insertText", { text: value })).ok
		? { kind: "acted" }
		: { kind: "unverified" }
}

/**
 * What the page identity after an act means for the act that just happened.
 *
 * An unchanged page is the ordinary answer. A page that moved is the act working
 * when the act was a click on something that navigates, and in every other case
 * it is another document arriving, which is never reported as this act
 * succeeding.
 */
function outcomeAfterAct(input: {
	readonly action: ControlledPageAction
	readonly description: DomNodeDescription
	readonly atDispatch: ControlledPageBasis
	readonly after: ControlledPageBasis
}): PageActionOutcome {
	if (sameBasis(input.after, input.atDispatch)) return { kind: "acted", basis: input.after }
	return input.action.kind === "click" && mayNavigate(input.description)
		? { kind: "acted", basis: input.after }
		: { kind: "superseded" }
}

/**
 * What a `fill` must prove about the live field before anything is typed, over
 * and above the identity proofs every act makes.
 *
 * The accessible name is part of the classification, so a field labelled
 * `Username` and carrying no attribute saying so is caught here as well as in
 * the snapshot that named it. An outcome is returned only when the fill must
 * stop; `undefined` means the field is one this command may go on to type into.
 */
async function refuseUnfillableField(
	channel: CdpChannel,
	backendNodeId: number,
	description: DomNodeDescription,
): Promise<PageActionOutcome | undefined> {
	if (!(await channel.call("Accessibility.enable", {})).ok) return { kind: "unverified" }
	const field = await readNodeAccessibility(channel, backendNodeId)
	if (field === undefined) {
		return { kind: "undeliverable", reason: "field_unreadable", touchedPage: false }
	}
	if (isCredentialField(description, field.name)) return { kind: "credential_field" }
	// Warm Browser types into an empty field. Text inserted into a field that
	// already holds some is appended to it, so a field with content in it is
	// refused rather than filled with something neither the caller nor the page
	// asked for.
	return field.holdsValue
		? { kind: "undeliverable", reason: "field_not_empty", touchedPage: false }
		: undefined
}

/**
 * Acts on one element of the Controlled Page, having proved twice over that it
 * is acting on what the caller named: the page identity still equals the one
 * the reference was issued against, and the live element is still described the
 * way the refusal rules require. The act itself then proves it reaches that
 * element before it is delivered.
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
			if (!described.ok) return { kind: "element_absent", touchedPage: false }
			const description = describedNode(record(record(described.result)?.node) ?? {})
			if (description === undefined) return { kind: "element_absent", touchedPage: false }
			if (input.action.kind === "fill") {
				const refusal = await refuseUnfillableField(channel, input.backendNodeId, description)
				if (refusal !== undefined) return refusal
			}
			// The page identity is proved once more immediately before the act. The
			// reads above take time, and a navigation that landed during them would
			// otherwise receive input meant for the document that is gone.
			//
			// The act then keeps proving. Its own last reading before it dispatches
			// is about the referenced node itself, and a node identity belongs to one
			// document, so a document that arrived after this proof fails that
			// reading rather than receiving the input.
			const atDispatch = await readBasis(channel, input.targetId)
			if (atDispatch === undefined) return { kind: "unverified" }
			if (!sameBasis(atDispatch, input.basis)) return { kind: "identity_changed" }
			const step = input.action.kind === "click"
				? await clickNode(channel, input.backendNodeId)
				: await typeIntoNode(channel, input.backendNodeId, input.action.value)
			if (step.kind !== "acted") return touchedByAct(step)
			const after = await readBasis(channel, input.targetId)
			if (after === undefined) return { kind: "unverified" }
			return outcomeAfterAct({ action: input.action, description, atDispatch, after })
		},
	)
}
