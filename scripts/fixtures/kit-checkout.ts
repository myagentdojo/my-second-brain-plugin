import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { ensureKitCheckout, parseKitPin } from "../package-adapter"

const repositoryRoot = resolve(import.meta.dir, "../..")

/**
 * One clean physical Kit checkout at the working manifest's pin, provisioned when this module
 * loads so cloning and frozen installation never run inside a timed test body. Test fixtures
 * link `node_modules/agent-plugin-kit` to this path.
 */
export const sharedKitCheckout: string = (() => {
	const pin = parseKitPin(JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")))
	if (pin === undefined) throw new Error("package.json does not pin agent-plugin-kit")
	return ensureKitCheckout({ consumerRoot: repositoryRoot, pin, environment: process.env })
})()
