import type { Server, ServerWebSocket } from "bun"
import { Buffer } from "node:buffer"
import { deflateSync } from "node:zlib"

/**
 * The deterministic local Controlled Page fixture: one real loopback endpoint
 * that speaks the exact CDP subset Warm Browser speaks, over a real WebSocket,
 * against a scripted accessibility tree.
 *
 * It is not a substitute for the Controlled Page conversation. It is the other
 * end of it: the production entry opens a real socket to this server, sends the
 * real CDP requests, and interprets the real replies, so the protocol under
 * proof is never replaced by an assertion about it. Nothing here launches or
 * inspects a browser.
 *
 * Every request it serves is witnessed in order, so a test can prove which
 * target Warm Browser addressed and which methods it called.
 */

export interface FixtureElement {
	readonly backendNodeId: number
	readonly role: string
	readonly name: string
	readonly nodeName: string
	readonly attributes?: Readonly<Record<string, string>>
	readonly ignored?: boolean
	readonly focusable?: boolean
	/** The element box as `x, y, width, height`; absent means an unrendered node. */
	readonly box?: readonly [number, number, number, number]
	/** Clicking this element navigates the Controlled Page to this URL. */
	readonly navigatesTo?: string
	/** The attributes the live description carries once the snapshot has been read. */
	readonly becomesAttributes?: Readonly<Record<string, string>>
	/** The accessible name the live element carries once the snapshot has been read. */
	readonly becomesName?: string
	/** The element nests inside this other one, so a hit on it is a descendant hit. */
	readonly childOf?: number
	/** The element lives in a shadow root, which only a piercing read describes. */
	readonly inShadowRoot?: boolean
	/** The document read describes no such node at all. */
	readonly undescribed?: boolean
	/** Scrolling the element into view fails. */
	readonly scrollFails?: boolean
	/** The element has no content quad, as an element outside the layout has none. */
	readonly noQuads?: boolean
	/** Another element covers this one, so a hit at its point resolves to that one. */
	readonly occludedBy?: number
	/** Focusing the element moves focus to this other element instead. */
	readonly focusMovesTo?: number
	/** Focusing the element fails outright. */
	readonly focusFails?: boolean
	/** The value the field already holds. */
	readonly value?: string
}

export interface FixtureTarget {
	readonly id: string
	readonly type: string
	readonly url?: string
}

export interface CdpPageFixtureOptions {
	readonly targetId?: string
	readonly url?: string
	readonly title?: string
	readonly elements?: readonly FixtureElement[]
	readonly extraTargets?: readonly FixtureTarget[]
	/** Methods answered with a CDP error instead of a result. */
	readonly failMethods?: readonly string[]
	/** A navigation to this URL is answered with a browser-side error text. */
	readonly refuseNavigationTo?: string
	/** The page identity moves the moment the accessibility tree is answered. */
	readonly driftDuringSnapshot?: boolean
	/**
	 * Moves the page identity immediately after the named method is answered, on
	 * the given occurrence of it. This is how a navigation that lands part-way
	 * through one conversation is modelled: delayed, or competing with whatever
	 * the caller asked for.
	 */
	readonly navigateAfterMethod?: {
		readonly method: string
		readonly url: string
		readonly occurrence?: number
	}
	/** The socket path the target list declares, when it should name another one. */
	readonly declaredPagePath?: string
	/** The image `Page.captureScreenshot` answers with. */
	readonly screenshot?: {
		readonly width: number
		readonly height: number
		readonly pixel?: readonly [number, number, number]
	}
	/**
	 * Answers the capture with bytes that are not one complete PNG, so the caller
	 * meets a real malformed answer rather than an assertion about one.
	 */
	readonly screenshotBytes?: "not-png" | "truncated"
}

export interface WitnessEntry {
	readonly kind: "http" | "attach" | "cdp"
	readonly detail: string
}

export interface CdpPageFixture {
	readonly port: number
	readonly targetId: string
	witness(): readonly WitnessEntry[]
	cdpMethods(): readonly string[]
	/**
	 * The methods of the most recent conversation alone. Each command opens its
	 * own socket, so this is what one command said to the page, rather than
	 * everything every command before it said.
	 */
	latestConversation(): readonly string[]
	attachedTargets(): readonly string[]
	pageUrl(): string
	loaderId(): string
	insertedText(): readonly string[]
	/** What the field holds now, after whatever was typed into it. */
	fieldValue(backendNodeId: number): string | undefined
	/** Which node holds focus now, which a focus handler may have moved. */
	focusedNode(): number | undefined
	clicks(): readonly { readonly x: number; readonly y: number }[]
	focusedNodes(): readonly number[]
	navigate(url: string): void
	/** Moves where the page is without starting a new document load. */
	moveWithinDocument(url: string): void
	replacePage(targetId: string): void
	setTargets(targets: readonly FixtureTarget[]): void
	setElements(elements: readonly FixtureElement[]): void
	stop(): void
}

interface SocketData {
	readonly targetPath: string
}

const documentBackendNodeId = 1
const htmlBackendNodeId = 2
const bodyBackendNodeId = 3

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let crc = index
	for (let bit = 0; bit < 8; bit += 1) {
		crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xEDB88320
	}
	return crc >>> 0
})

function attributeList(attributes: Readonly<Record<string, string>> | undefined): string[] {
	return Object.entries(attributes ?? {}).flatMap(([name, value]) => [name, value])
}

function domNode(element: FixtureElement, nodeId: number): Record<string, unknown> {
	return {
		nodeId,
		backendNodeId: element.backendNodeId,
		nodeType: 1,
		nodeName: element.nodeName,
		localName: element.nodeName.toLowerCase(),
		nodeValue: "",
		childNodeCount: 0,
		attributes: attributeList(element.attributes),
	}
}

function accessibilityNode(element: FixtureElement, index: number): Record<string, unknown> {
	const properties = element.focusable === false ? [] : [
		{ name: "focusable", value: { type: "booleanOrUndefined", value: true } },
	]
	return {
		nodeId: String(index + 100),
		ignored: element.ignored === true,
		role: { type: "role", value: element.role },
		name: { type: "computedString", value: element.name },
		properties,
		backendDOMNodeId: element.backendNodeId,
	}
}

/** The PNG chunk checksum, computed the way the format defines it. */
function crc32(bytes: Uint8Array): number {
	let crc = 0xFFFFFFFF
	for (const byte of bytes) {
		crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xFF]!
	}
	return (crc ^ 0xFFFFFFFF) >>> 0
}

/** One PNG chunk: its length, its type, its data, and its checksum. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const chunk = new Uint8Array(4 + 4 + data.length + 4)
	chunk[0] = (data.length >>> 24) & 0xFF
	chunk[1] = (data.length >>> 16) & 0xFF
	chunk[2] = (data.length >>> 8) & 0xFF
	chunk[3] = data.length & 0xFF
	for (let index = 0; index < 4; index += 1) {
		chunk[4 + index] = type.charCodeAt(index)
	}
	chunk.set(data, 8)
	const checksum = crc32(chunk.subarray(4, 8 + data.length))
	const checksumOffset = 8 + data.length
	chunk[checksumOffset] = (checksum >>> 24) & 0xFF
	chunk[checksumOffset + 1] = (checksum >>> 16) & 0xFF
	chunk[checksumOffset + 2] = (checksum >>> 8) & 0xFF
	chunk[checksumOffset + 3] = checksum & 0xFF
	return chunk
}

/**
 * One real PNG image of a single flat colour. The fixture encodes it rather
 * than serving a canned string, so the production reader decodes an image that
 * genuinely carries the dimensions this test asked for.
 */
function encodePng(
	width: number,
	height: number,
	pixel: readonly [number, number, number],
): Uint8Array {
	const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
	const ihdr = new Uint8Array(13)
	ihdr[0] = (width >>> 24) & 0xFF
	ihdr[1] = (width >>> 16) & 0xFF
	ihdr[2] = (width >>> 8) & 0xFF
	ihdr[3] = width & 0xFF
	ihdr[4] = (height >>> 24) & 0xFF
	ihdr[5] = (height >>> 16) & 0xFF
	ihdr[6] = (height >>> 8) & 0xFF
	ihdr[7] = height & 0xFF
	ihdr[8] = 8
	ihdr[9] = 2
	ihdr[10] = 0
	ihdr[11] = 0
	ihdr[12] = 0

	const raw = new Uint8Array(height * (1 + width * 3))
	for (let row = 0; row < height; row += 1) {
		const rowOffset = row * (1 + width * 3)
		raw[rowOffset] = 0
		for (let column = 0; column < width; column += 1) {
			const pixelOffset = rowOffset + 1 + column * 3
			raw[pixelOffset] = pixel[0]
			raw[pixelOffset + 1] = pixel[1]
			raw[pixelOffset + 2] = pixel[2]
		}
	}

	const chunks = [
		signature,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", new Uint8Array()),
	]
	const png = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
	let offset = 0
	for (const chunk of chunks) {
		png.set(chunk, offset)
		offset += chunk.length
	}
	return png
}

export function startCdpPageFixture(options: CdpPageFixtureOptions = {}): CdpPageFixture {
	let targetId = options.targetId ?? "page-1"
	let url = options.url ?? "https://fixture.test/start"
	const title = options.title ?? "Fixture"
	let elements: readonly FixtureElement[] = options.elements ?? []
	let targets: readonly FixtureTarget[] | undefined = options.extraTargets === undefined
		? undefined
		: [{ id: targetId, type: "page", url }, ...options.extraTargets]
	const failMethods = new Set(options.failMethods ?? [])
	let loaderCount = 1
	const witness: WitnessEntry[] = []
	const insertedText: string[] = []
	const clicks: { x: number; y: number }[] = []
	const focusedNodes: number[] = []
	const fieldValues = new Map<number, string>()
	let focusedNode: number | undefined
	let describedAfterSnapshot = false
	const methodCounts = new Map<string, number>()

	function boundPort(): number {
		return server.port ?? 0
	}

	function loaderId(): string {
		return `loader-${loaderCount}`
	}

	function moveIdentity(nextUrl: string): void {
		url = nextUrl
		loaderCount += 1
	}

	function targetList(): readonly FixtureTarget[] {
		return targets ?? [{ id: targetId, type: "page", url }]
	}

	function findElement(backendNodeId: unknown): FixtureElement | undefined {
		return elements.find((element) => element.backendNodeId === backendNodeId)
	}

	/** The value the field holds right now, which typing into it changes. */
	function fieldValue(element: FixtureElement): string {
		return fieldValues.get(element.backendNodeId) ?? element.value ?? ""
	}

	/** The element a point lands on, honouring whatever covers it. */
	function elementAtPoint(x: number, y: number): FixtureElement | undefined {
		const hit = elements.find((element) =>
			element.box !== undefined && element.noQuads !== true &&
			x >= element.box[0] && x <= element.box[0] + element.box[2] &&
			y >= element.box[1] && y <= element.box[1] + element.box[3]
		)
		if (hit?.occludedBy === undefined) return hit
		return findElement(hit.occludedBy) ?? hit
	}

	/** One document subtree: this element and whatever nests inside it. */
	function domSubtree(element: FixtureElement, nodeId: number): Record<string, unknown> {
		const children = elements.filter((child) => child.childOf === element.backendNodeId)
		return {
			...domNode(element, nodeId),
			childNodeCount: children.length,
			children: children.map((child, index) => domSubtree(child, nodeId * 100 + index + 1)),
		}
	}

	/** Everything the document read describes, with or without piercing. */
	function documentChildren(pierce: boolean): {
		readonly children: Record<string, unknown>[]
		readonly shadowRoots: Record<string, unknown>[]
	} {
		const described = elements.filter((element) => element.undescribed !== true)
		const light = described.filter((element) =>
			element.childOf === undefined && element.inShadowRoot !== true
		)
		const shadow = described.filter((element) =>
			element.childOf === undefined && element.inShadowRoot === true
		)
		return {
			children: light.map((element, index) => domSubtree(element, index + 4)),
			shadowRoots: pierce && shadow.length > 0
				? [{
					nodeId: 3_000,
					backendNodeId: 3_000,
					nodeType: 11,
					nodeName: "#document-fragment",
					nodeValue: "",
					shadowRootType: "open",
					childNodeCount: shadow.length,
					children: shadow.map((element, index) => domSubtree(element, 3_001 + index)),
				}]
				: [],
		}
	}

	function reply(method: string, parameters: Record<string, unknown>): Record<string, unknown> {
		if (method === "Page.enable" || method === "DOM.enable" || method === "Accessibility.enable") {
			return {}
		}
		if (method === "Page.getFrameTree") {
			return {
				frameTree: {
					frame: { id: "frame-main", loaderId: loaderId(), url, securityOrigin: new URL(url).origin },
				},
			}
		}
		if (method === "Page.navigate") {
			const requested = String(parameters.url)
			if (options.refuseNavigationTo === requested) {
				return { frameId: "frame-main", loaderId: loaderId(), errorText: "net::ERR_NAME_NOT_RESOLVED" }
			}
			moveIdentity(requested)
			return { frameId: "frame-main", loaderId: loaderId() }
		}
		if (method === "DOM.getDocument") {
			const body = documentChildren(parameters.pierce === true)
			return {
				root: {
					nodeId: 1,
					backendNodeId: documentBackendNodeId,
					nodeType: 9,
					nodeName: "#document",
					nodeValue: "",
					childNodeCount: 1,
					children: [{
						nodeId: 2,
						backendNodeId: htmlBackendNodeId,
						nodeType: 1,
						nodeName: "HTML",
						nodeValue: "",
						attributes: [],
						childNodeCount: 1,
						children: [{
							nodeId: 3,
							backendNodeId: bodyBackendNodeId,
							nodeType: 1,
							nodeName: "BODY",
							nodeValue: "",
							attributes: [],
							childNodeCount: body.children.length,
							children: body.children,
							shadowRoots: body.shadowRoots,
						}],
					}],
				},
			}
		}
		if (method === "Accessibility.getPartialAXTree") {
			const element = findElement(parameters.backendNodeId)
			if (element === undefined) throw new Error("no such node")
			const live = element.becomesName !== undefined && describedAfterSnapshot
				? { ...element, name: element.becomesName }
				: element
			return {
				nodes: [{
					...accessibilityNode(live, 0),
					value: { type: "string", value: fieldValue(element) },
					properties: [
						{ name: "focusable", value: { type: "booleanOrUndefined", value: true } },
						{
							name: "focused",
							value: {
								type: "booleanOrUndefined",
								value: focusedNode === element.backendNodeId,
							},
						},
					],
				}],
			}
		}
		if (method === "DOM.scrollIntoViewIfNeeded") {
			const element = findElement(parameters.backendNodeId)
			if (element === undefined || element.scrollFails === true) {
				throw new Error("the node could not be scrolled into view")
			}
			return {}
		}
		if (method === "DOM.getContentQuads") {
			const element = findElement(parameters.backendNodeId)
			if (element === undefined) throw new Error("no such node")
			if (element.box === undefined || element.noQuads === true) return { quads: [] }
			const [x, y, width, height] = element.box
			return { quads: [[x, y, x + width, y, x + width, y + height, x, y + height]] }
		}
		if (method === "DOM.getNodeForLocation") {
			const hit = elementAtPoint(Number(parameters.x), Number(parameters.y))
			if (hit === undefined) throw new Error("no node at that location")
			return { backendNodeId: hit.backendNodeId, frameId: "frame-main" }
		}
		if (method === "Accessibility.getFullAXTree") {
			const nodes = elements.map(accessibilityNode)
			if (options.driftDuringSnapshot === true) moveIdentity(url)
			describedAfterSnapshot = true
			return { nodes }
		}
		if (method === "Page.captureScreenshot") {
			const { width, height } = options.screenshot ?? { width: 4, height: 3 }
			const pixel: readonly [number, number, number] = options.screenshot?.pixel ?? [18, 52, 86]
			const png = encodePng(width, height, pixel)
			const bytes = options.screenshotBytes === "not-png"
				? new TextEncoder().encode("this is not a portable network graphic")
				: options.screenshotBytes === "truncated"
					? png.slice(0, png.length - 12)
					: png
			return { data: Buffer.from(bytes).toString("base64") }
		}
		if (method === "DOM.describeNode") {
			const element = findElement(parameters.backendNodeId)
			if (element === undefined) throw new Error("no such node")
			const attributes = element.becomesAttributes !== undefined && describedAfterSnapshot
				? { ...element.attributes, ...element.becomesAttributes }
				: element.attributes
			return { node: { ...domNode(element, 0), attributes: attributeList(attributes) } }
		}
		if (method === "DOM.focus") {
			const element = findElement(parameters.backendNodeId)
			if (element === undefined || element.focusFails === true) {
				throw new Error("the node could not take focus")
			}
			focusedNodes.push(element.backendNodeId)
			// A focus handler may move focus somewhere this caller never named.
			focusedNode = element.focusMovesTo ?? element.backendNodeId
			return {}
		}
		if (method === "Input.dispatchMouseEvent") {
			if (parameters.type === "mousePressed") {
				const x = Number(parameters.x)
				const y = Number(parameters.y)
				clicks.push({ x, y })
				const target = elements.find((element) =>
					element.navigatesTo !== undefined && element.box !== undefined &&
					x >= element.box[0] && x <= element.box[0] + element.box[2] &&
					y >= element.box[1] && y <= element.box[1] + element.box[3]
				)
				if (target?.navigatesTo !== undefined) moveIdentity(target.navigatesTo)
			}
			return {}
		}
		if (method === "Input.insertText") {
			const typed = String(parameters.text)
			insertedText.push(typed)
			// Text is inserted into whatever holds focus, which is the whole point
			// of proving which node that is before typing.
			if (focusedNode !== undefined) {
				const target = findElement(focusedNode)
				if (target !== undefined) fieldValues.set(focusedNode, fieldValue(target) + typed)
			}
			return {}
		}
		throw new Error(`unsupported fixture method: ${method}`)
	}

	const server: Server<SocketData> = Bun.serve<SocketData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, listening) {
			const requested = new URL(request.url)
			if (requested.pathname.startsWith("/devtools/")) {
				// A socket exists only for a target that exists now. A stale or
				// invented path is answered the way a browser answers one, so a
				// caller that dialled the wrong page never gets a conversation, and
				// no conversation is witnessed for one that was never opened.
				const known = requested.pathname === "/devtools/browser/fixture" ||
					targetList().some((target) => requested.pathname === `/devtools/page/${target.id}`)
				if (!known) return new Response("no such target", { status: 404 })
				if (listening.upgrade(request, { data: { targetPath: requested.pathname } })) {
					witness.push({ kind: "attach", detail: requested.pathname })
					return undefined
				}
				return new Response("upgrade refused", { status: 400 })
			}
			witness.push({ kind: "http", detail: requested.pathname })
			if (requested.pathname === "/json/version") {
				return Response.json({
					Browser: "Chrome/151.0.7922.174",
					"Protocol-Version": "1.3",
					webSocketDebuggerUrl: `ws://127.0.0.1:${boundPort()}/devtools/browser/fixture`,
				})
			}
			if (requested.pathname === "/json/list") {
				return Response.json(targetList().map((target) => ({
					id: target.id,
					type: target.type,
					url: target.url ?? url,
					title,
					webSocketDebuggerUrl: `ws://127.0.0.1:${boundPort()}${
						options.declaredPagePath ?? `/devtools/page/${target.id}`
					}`,
				})))
			}
			return new Response("not found", { status: 404 })
		},
		websocket: {
			message(socket: ServerWebSocket<SocketData>, raw) {
				const request = JSON.parse(String(raw)) as {
					id?: number
					method?: string
					params?: Record<string, unknown>
				}
				const method = String(request.method)
				witness.push({ kind: "cdp", detail: `${socket.data.targetPath} ${method}` })
				if (failMethods.has(method)) {
					socket.send(JSON.stringify({
						id: request.id,
						error: { code: -32000, message: "fixture refused the method" },
					}))
					return
				}
				try {
					const result = reply(method, request.params ?? {})
					// The reply describes the page as it was when the method was
					// answered. A scripted navigation lands after that, so the next
					// reading in the same conversation sees a different page.
					const scripted = options.navigateAfterMethod
					if (scripted !== undefined && scripted.method === method) {
						const seen = (methodCounts.get(method) ?? 0) + 1
						methodCounts.set(method, seen)
						if (seen === (scripted.occurrence ?? 1)) moveIdentity(scripted.url)
					}
					socket.send(JSON.stringify({ id: request.id, result }))
				} catch (error) {
					socket.send(JSON.stringify({
						id: request.id,
						error: { code: -32601, message: (error as Error).message },
					}))
				}
			},
		},
	})

	const port = server.port
	if (port === undefined) throw new Error("the Controlled Page fixture bound no loopback port")

	return {
		port,
		targetId,
		witness: () => [...witness],
		cdpMethods: () =>
			witness.filter((entry) => entry.kind === "cdp").map((entry) => entry.detail.split(" ")[1]!),
		latestConversation: () =>
			witness
				.slice(witness.findLastIndex((entry) => entry.kind === "attach"))
				.filter((entry) => entry.kind === "cdp")
				.map((entry) => entry.detail.split(" ")[1]!),
		attachedTargets: () =>
			witness.filter((entry) => entry.kind === "attach").map((entry) => entry.detail),
		pageUrl: () => url,
		loaderId,
		insertedText: () => [...insertedText],
		fieldValue: (backendNodeId) => {
			const element = findElement(backendNodeId)
			return element === undefined ? undefined : fieldValue(element)
		},
		focusedNode: () => focusedNode,
		clicks: () => [...clicks],
		focusedNodes: () => [...focusedNodes],
		navigate: (nextUrl) => moveIdentity(nextUrl),
		moveWithinDocument: (nextUrl) => {
			url = nextUrl
		},
		replacePage: (nextTargetId) => {
			targetId = nextTargetId
			if (targets !== undefined) targets = [{ id: nextTargetId, type: "page", url }]
		},
		setTargets: (nextTargets) => {
			targets = nextTargets
		},
		setElements: (nextElements) => {
			elements = nextElements
			describedAfterSnapshot = false
			fieldValues.clear()
			focusedNode = undefined
		},
		stop: () => {
			server.stop(true)
		},
	}
}
