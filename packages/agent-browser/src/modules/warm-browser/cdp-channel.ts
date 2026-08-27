import { pageCallTimeoutMs, pageConnectTimeoutMs } from "./bounds"

/**
 * One raw CDP conversation over one WebSocket, carrying no policy: no method
 * name, no parameter shape, no interpretation of any reply, and no retry.
 *
 * This is the transport half of the Controlled Page seam. Unlike the process
 * table and the loopback listener, it is not substituted in tests, because the
 * deterministic Controlled Page fixture is a real local endpoint: replacing the
 * transport would delete the protocol conversation that is under proof and
 * leave an assertion about it in its place.
 *
 * Every call is bounded. A reply that never arrives, a socket that closes, and
 * a browser-side error are the same to the caller: an answer that did not come,
 * which is never proof of anything about the page.
 */

export interface CdpReply {
	readonly ok: boolean
	readonly result: unknown
}

export interface CdpChannel {
	call(method: string, parameters: Record<string, unknown>): Promise<CdpReply>
	close(): void
}

export type CdpConnection =
	| { readonly kind: "open"; readonly channel: CdpChannel }
	| { readonly kind: "unavailable" }

const failedReply: CdpReply = { ok: false, result: undefined }

interface PendingCall {
	readonly settle: (reply: CdpReply) => void
	readonly timer: ReturnType<typeof setTimeout>
}

export async function openCdpChannel(webSocketUrl: string): Promise<CdpConnection> {
	let socket: WebSocket
	try {
		socket = new WebSocket(webSocketUrl)
	} catch {
		return { kind: "unavailable" }
	}
	const pending = new Map<number, PendingCall>()
	let closed = false

	function releaseAll(): void {
		closed = true
		for (const [id, call] of pending) {
			clearTimeout(call.timer)
			pending.delete(id)
			call.settle(failedReply)
		}
	}

	socket.addEventListener("message", (event) => {
		let message: { id?: unknown; result?: unknown; error?: unknown }
		try {
			message = JSON.parse(String((event as MessageEvent).data))
		} catch {
			return
		}
		if (typeof message.id !== "number") return
		const call = pending.get(message.id)
		if (call === undefined) return
		clearTimeout(call.timer)
		pending.delete(message.id)
		call.settle(
			message.error === undefined && message.result !== undefined
				? { ok: true, result: message.result }
				: failedReply,
		)
	})
	socket.addEventListener("close", releaseAll)
	socket.addEventListener("error", releaseAll)

	const opened = await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), pageConnectTimeoutMs)
		socket.addEventListener("open", () => {
			clearTimeout(timer)
			resolve(true)
		})
		socket.addEventListener("error", () => {
			clearTimeout(timer)
			resolve(false)
		})
		socket.addEventListener("close", () => {
			clearTimeout(timer)
			resolve(false)
		})
	})
	if (!opened) {
		try {
			socket.close()
		} catch {
			// The connection never opened; there is nothing left to release.
		}
		return { kind: "unavailable" }
	}

	let nextCallId = 0
	const channel: CdpChannel = {
		call: async (method, parameters) => {
			if (closed) return failedReply
			nextCallId += 1
			const id = nextCallId
			return await new Promise<CdpReply>((resolve) => {
				const timer = setTimeout(() => {
					pending.delete(id)
					resolve(failedReply)
				}, pageCallTimeoutMs)
				pending.set(id, { settle: resolve, timer })
				try {
					socket.send(JSON.stringify({ id, method, params: parameters }))
				} catch {
					clearTimeout(timer)
					pending.delete(id)
					resolve(failedReply)
				}
			})
		},
		close: () => {
			releaseAll()
			try {
				socket.close()
			} catch {
				// A socket that cannot be closed is already gone.
			}
		},
	}
	return { kind: "open", channel }
}
