/**
 * These are the host-layer canaries crossing each production reader and its
 * production observer with the real `/usr/sbin/lsof` and `/bin/ps`, so the
 * interpreted grammars can never drift from the bytes the host actually emits;
 * fixture-rendered readings elsewhere are supporting evidence only.
 */
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { createServer } from "node:net"

import {
	readLoopbackListener,
	readProcessTable,
} from "../src/modules/warm-browser/host-effects"
import { observeLoopbackListener } from "../src/modules/warm-browser/listener-table"
import { observeProcessTable } from "../src/modules/warm-browser/process-table"
import { installedChrome } from "./fixtures/production-cli-harness"

test.skipIf(
	process.platform !== "darwin" || !existsSync("/usr/sbin/lsof"),
)(
	"the production lsof reading of a loopback listener this process owns is observed as this process",
	async () => {
		const server = createServer()
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject)
				server.listen(0, "127.0.0.1", resolve)
			})
			const address = server.address()
			if (address === null || typeof address === "string") {
				throw new Error("the loopback server did not expose an assigned port")
			}
			const owner = observeLoopbackListener(readLoopbackListener(address.port))
			expect(owner).toBe(process.pid)
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)))
			})
		}
	},
)

test.skipIf(process.platform !== "darwin" || !existsSync("/bin/ps"))(
	"the production process-table reading is observed as the whole table under its pinned C locale",
	() => {
		const table = observeProcessTable(readProcessTable(), installedChrome)
		expect(table.kind).toBe("verified")
		if (table.kind !== "verified") return
		expect(table.processes.some((row) => row.pid === process.pid)).toBe(true)
	},
)
