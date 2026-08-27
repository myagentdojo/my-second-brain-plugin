import type { Server, ServerWebSocket } from "bun"

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
	attachedTargets(): readonly string[]
	pageUrl(): string
	loaderId(): string
	insertedText(): readonly string[]
	clicks(): readonly { readonly x: number; readonly y: number }[]
	focusedNodes(): readonly number[]
	navigate(url: string): void
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

function boxModel(box: readonly [number, number, number, number]): Record<string, unknown> {
	const [x, y, width, height] = box
	return {
		model: {
			content: [x, y, x + width, y, x + width, y + height, x, y + height],
			padding: [x, y, x + width, y, x + width, y + height, x, y + height],
			border: [x, y, x + width, y, x + width, y + height, x, y + height],
			margin: [x, y, x + width, y, x + width, y + height, x, y + height],
			width,
			height,
		},
	}
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
							childNodeCount: elements.length,
							children: elements.map((element, index) => domNode(element, index + 4)),
						}],
					}],
				},
			}
		}
		if (method === "Accessibility.getFullAXTree") {
			const nodes = elements.map(accessibilityNode)
			if (options.driftDuringSnapshot === true) moveIdentity(url)
			describedAfterSnapshot = true
			return { nodes }
		}
		if (method === "DOM.describeNode") {
			const element = findElement(parameters.backendNodeId)
			if (element === undefined) throw new Error("no such node")
			const attributes = element.becomesAttributes !== undefined && describedAfterSnapshot
				? { ...element.attributes, ...element.becomesAttributes }
				: element.attributes
			return { node: { ...domNode(element, 0), attributes: attributeList(attributes) } }
		}
		if (method === "DOM.getBoxModel") {
			const element = findElement(parameters.backendNodeId)
			if (element?.box === undefined) throw new Error("no box model for node")
			return boxModel(element.box)
		}
		if (method === "DOM.focus") {
			const element = findElement(parameters.backendNodeId)
			if (element === undefined) throw new Error("no such node")
			focusedNodes.push(element.backendNodeId)
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
			insertedText.push(String(parameters.text))
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
				witness.push({ kind: "attach", detail: requested.pathname })
				if (listening.upgrade(request, { data: { targetPath: requested.pathname } })) return undefined
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
		attachedTargets: () =>
			witness.filter((entry) => entry.kind === "attach").map((entry) => entry.detail),
		pageUrl: () => url,
		loaderId,
		insertedText: () => [...insertedText],
		clicks: () => [...clicks],
		focusedNodes: () => [...focusedNodes],
		navigate: (nextUrl) => moveIdentity(nextUrl),
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
		},
		stop: () => {
			server.stop(true)
		},
	}
}
