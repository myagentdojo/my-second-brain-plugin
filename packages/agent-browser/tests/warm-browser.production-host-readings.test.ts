/**
 * These are the host-layer canaries crossing each production reader and its
 * production observer with the real `/usr/sbin/lsof` and `/bin/ps`, so the
 * interpreted grammars can never drift from the bytes the host actually emits;
 * fixture-rendered readings elsewhere are supporting evidence only.
 */
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"

import {
	readLoopbackListener,
	readProcessTable,
} from "../src/modules/warm-browser/host-effects"
import { observeLoopbackListener } from "../src/modules/warm-browser/listener-table"
import { observeProcessTable } from "../src/modules/warm-browser/process-table"
import { installedChrome } from "./fixtures/production-cli-harness"

const dayFirstLocale = "en_AU.UTF-8"

/** Whether this host renders `lstart` day-first under the chosen locale; without that the boundary cannot be proved. */
function rendersDayFirstStart(): boolean {
	const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, LC_ALL: dayFirstLocale },
	})
	return result.status === 0 && /^\s*\S+\s+\d+\s+[A-Za-z]+\s/.test(result.stdout)
}

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

test.skipIf(process.platform !== "darwin" || !existsSync("/bin/ps") || !rendersDayFirstStart())(
	"the production process-table reading is observed as the whole table under a day-first caller locale",
	() => {
		const priorLcAll = process.env.LC_ALL
		process.env.LC_ALL = dayFirstLocale
		try {
			const table = observeProcessTable(readProcessTable(), installedChrome)
			expect(table.kind).toBe("verified")
			if (table.kind !== "verified") return
			expect(table.processes.some((row) => row.pid === process.pid)).toBe(true)
		} finally {
			if (priorLcAll === undefined) delete process.env.LC_ALL
			else process.env.LC_ALL = priorLcAll
		}
	},
)
