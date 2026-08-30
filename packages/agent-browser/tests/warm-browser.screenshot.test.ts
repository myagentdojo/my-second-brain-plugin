/**
 * A Screenshot is visual evidence the Browser Session owns. This suite reads
 * the artifact off disk rather than trusting what the command said about it.
 */

import { afterEach, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import {
	pageProbe,
	pageProbePlan,
	readReceipt,
	signInPage,
	stopControlledPageFixtures,
	takeSnapshot,
} from "./fixtures/controlled-page-probe"
import {
	expectError,
	expectRefusal,
	productionCliProbe,
	removeProductionCliProbes,
	runProductionCliAsync,
	systemRows,
	verifiedReading,
	writeHostEffectsPlan,
} from "./fixtures/production-cli-harness"

afterEach(() => {
	stopControlledPageFixtures()
	removeProductionCliProbes()
})

/** The test's own reading of a PNG header, sharing no code with the Module's. */
function readPngHeader(bytes: Uint8Array): { signature: number[]; width: number; height: number; trailer: number[] } {
	const readUint32 = (offset: number): number =>
		bytes[offset]! * 0x1000000 +
		bytes[offset + 1]! * 0x10000 +
		bytes[offset + 2]! * 0x100 +
		bytes[offset + 3]!
	return {
		signature: [...bytes.slice(0, 8)],
		width: readUint32(16),
		height: readUint32(20),
		trailer: [...bytes.slice(-12)],
	}
}

test("screenshot captures one private Browser Session-owned PNG of the Controlled Page", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/start",
		screenshot: { width: 7, height: 5 },
	})

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "screenshot-run"])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	const envelope = JSON.parse(result.stdout)
	const path = (envelope.data.screenshot as { path: string }).path
	const bytes = readFileSync(path)
	const sha256 = createHash("sha256").update(bytes).digest("hex")
	// Independent oracle: the whole envelope, restated by hand.
	expect(envelope).toEqual({
		schemaVersion: 1,
		status: "ok",
		command: "screenshot",
		resultCode: "SCREENSHOT_CAPTURED",
		runId: "screenshot-run",
		transactionState: "acted",
		retrySafe: true,
		nextAction:
			"Read the Screenshot at the private path this result names; Warm Browser removes it when the Browser Session stops.",
		data: {
			screenshot: { path, width: 7, height: 5, sha256 },
			controlledPage: { targetId: "page-1", url: "https://fixture.test/start" },
			invalidatedReferences: false,
			postcondition: "running",
		},
	})
	expect(path.startsWith(join(probe.lockPath, "screenshots") + "/")).toBe(true)
	expect(basename(path)).toMatch(/^screenshot-[0-9a-f-]{36}\.png$/)
	const header = readPngHeader(bytes)
	expect(header.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
	expect(header.width).toBe(7)
	expect(header.height).toBe(5)
	expect(header.trailer).toEqual([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(envelope.data.screenshot.sha256)
	expect(statSync(path).mode & 0o7777).toBe(0o600)
	expect(statSync(join(probe.lockPath, "screenshots")).mode & 0o7777).toBe(0o700)
	// A capture asks the page for nothing the snapshot machinery uses.
	expect(fixture.latestConversation()).toEqual([
		"Page.enable",
		"Page.getFrameTree",
		"Page.captureScreenshot",
		"Page.getFrameTree",
	])
})

test("the result carries only the owned path, the dimensions, and the hash", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/start",
		screenshot: { width: 7, height: 5 },
	})

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "screenshot-shape"])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	const data = JSON.parse(result.stdout).data as Record<string, unknown>
	const screenshot = data.screenshot as Record<string, unknown>
	expect(Object.keys(screenshot).toSorted()).toEqual(["height", "path", "sha256", "width"])
	// The issue admits exactly this much and nothing else, so a field added later disagrees here rather than reaching a caller unnoticed.
	expect(Object.keys(data).toSorted()).toEqual([
		"controlledPage",
		"invalidatedReferences",
		"postcondition",
		"screenshot",
	])
})

test("capturing issues no Snapshot Reference and leaves the Snapshot Generation exactly where it was", async () => {
	const { probe } = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })
	const snapshot = await takeSnapshot(probe, "screenshot-snapshot")
	const receiptBefore = readFileSync(probe.sessionPath, "utf8")

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "screenshot-receipt"])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	expect(readFileSync(probe.sessionPath, "utf8")).toBe(receiptBefore)
	expect(result.stdout).not.toContain("ref")
	expect(result.stdout).not.toContain("generationId")
	expect(result.stdout).not.toContain("elements")
	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[3]!.ref,
		"--run-id",
		"screenshot-reference",
	])
	expect(clicked.stderr).toBe("")
	expect(clicked.exitCode).toBe(0)
	expect(JSON.parse(clicked.stdout)).toMatchObject({ resultCode: "ELEMENT_CLICKED" })
})

test("an output destination is refused by name and nothing is written", async () => {
	const { probe } = await pageProbe()

	for (const flag of ["--out", "--path", "--output"] as const) {
		const result = await runProductionCliAsync(probe, [
			"screenshot",
			flag,
			"/tmp/warm-browser-escape.png",
			"--run-id",
			"destination-run",
		])

		expectError(result, 21, {
			schemaVersion: 1,
			status: "error",
			command: "screenshot",
			resultCode: "SCREENSHOT_PATH_UNSUPPORTED",
			runId: "destination-run",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Run warm-browser screenshot --run-id ID and read the owned path it returns.",
			message: `Warm Browser writes a Screenshot where its Browser Session owns it, not to the ${flag} destination.`,
		})
		expect(existsSync(join(probe.lockPath, "screenshots"))).toBe(false)
		expect(existsSync("/tmp/warm-browser-escape.png")).toBe(false)
	}
})

test("a traversal path offered as a bare argument is refused without being echoed", async () => {
	const { probe } = await pageProbe()

	const result = await runProductionCliAsync(probe, [
		"screenshot",
		"../../../../etc/warm-browser-escape.png",
		"--run-id",
		"traversal-run",
	])

	expectError(result, 2, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "USAGE_ERROR",
		runId: "traversal-run",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser help --run-id ID and correct the command arguments.",
		message: "Warm Browser accepts options here, and this argument is not one.",
	})
	// A rejected value is described rather than echoed into a result a caller may log.
	expect(result.stderr).not.toContain("etc")
})

test("an unsafe artifact root is refused and nothing is captured", async () => {
	const { probe } = await pageProbe()
	// A symbolic link planted where the artifact directory belongs is not a
	// directory this Module wrote, so nothing behind it may be touched.
	symlinkSync(tmpdir(), join(probe.lockPath, "screenshots"))

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "unsafe-root"])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "STATE_UNSAFE",
		runId: "unsafe-root",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Repair the private Warm Browser Screenshot state before capturing again.",
		message: "Warm Browser could not remove the Screenshot its Browser Session already owned.",
	})
	// The link is still there and is still a link, so the module neither followed
	// it nor deleted through it.
	expect(lstatSync(join(probe.lockPath, "screenshots")).isSymbolicLink()).toBe(true)
})

test("stop removes every Screenshot the Browser Session owned", async () => {
	const { probe } = await pageProbe()
	const captured = await runProductionCliAsync(probe, ["screenshot", "--run-id", "screenshot-stop-capture"])
	const path = (JSON.parse(captured.stdout).data.screenshot as { path: string }).path
	expect(existsSync(path)).toBe(true)

	const stopped = await runProductionCliAsync(probe, ["stop", "--run-id", "screenshot-stop"])

	expect(stopped.stderr).toBe("")
	expect(stopped.exitCode).toBe(0)
	expect(JSON.parse(stopped.stdout)).toMatchObject({
		command: "stop",
		resultCode: "SESSION_STOPPED",
		transactionState: "stopped",
	})
	expect(existsSync(path)).toBe(false)
	expect(existsSync(join(probe.lockPath, "screenshots"))).toBe(false)
	expect(existsSync(probe.sessionPath)).toBe(false)
	expect(existsSync(probe.lockPath)).toBe(false)
})

test("bounded stale-session recovery removes the Screenshots the dead session owned", async () => {
	const { probe } = await pageProbe()
	const captured = await runProductionCliAsync(probe, ["screenshot", "--run-id", "screenshot-stale-capture"])
	const path = (JSON.parse(captured.stdout).data.screenshot as { path: string }).path
	expect(existsSync(path)).toBe(true)
	writeHostEffectsPlan(probe, {
		...pageProbePlan(),
		processTableAfterSpawn: verifiedReading(systemRows),
	})

	const recovered = await runProductionCliAsync(probe, ["status", "--run-id", "screenshot-stale"])

	expect(recovered.stderr).toBe("")
	expect(recovered.exitCode).toBe(0)
	expect(JSON.parse(recovered.stdout)).toMatchObject({
		resultCode: "STALE_SESSION_RECOVERED",
		transactionState: "recovered",
	})
	expect(existsSync(path)).toBe(false)
	expect(existsSync(join(probe.lockPath, "screenshots"))).toBe(false)
	expect(existsSync(probe.lockPath)).toBe(false)
})

test("a cleanup that cannot be completed fails closed and leaves the state repairable", async () => {
	const { probe } = await pageProbe()
	await runProductionCliAsync(probe, ["screenshot", "--run-id", "screenshot-blocked-capture"])
	mkdirSync(join(probe.lockPath, "screenshots", "held"), { mode: 0o700 })

	const stopped = await runProductionCliAsync(probe, ["stop", "--run-id", "screenshot-blocked-stop"])

	// The owned process really was stopped, so the refusal never denies it.
	expectRefusal(stopped, 20, {
		schemaVersion: 1,
		status: "error",
		command: "stop",
		resultCode: "STATE_UNSAFE",
		runId: "screenshot-blocked-stop",
		transactionState: "stopped",
		retrySafe: false,
		nextAction: "Repair the retained private Warm Browser session state; the owned browser process group is already stopped.",
		message: "Warm Browser stopped the owned browser process group but could not remove its private session state.",
	})
	expect(readdirSync(probe.sessionRoot).some((entry) => entry.startsWith(".cleanup-"))).toBe(true)

	const afterBlocked = await runProductionCliAsync(probe, ["status", "--run-id", "screenshot-after-blocked"])

	expectRefusal(afterBlocked, 20, { resultCode: "STATE_UNSAFE" })
})

test("a refused cleanup deletes no Screenshot the session already owned", async () => {
	const { probe } = await pageProbe()
	const captured = await runProductionCliAsync(probe, ["screenshot", "--run-id", "refused-cleanup-capture"])
	const path = (JSON.parse(captured.stdout).data.screenshot as { path: string }).path
	expect(existsSync(path)).toBe(true)
	mkdirSync(join(probe.lockPath, "screenshots", "held"), { mode: 0o700 })

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "refused-cleanup"])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "STATE_UNSAFE",
		runId: "refused-cleanup",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Repair the private Warm Browser Screenshot state before capturing again.",
		message: "Warm Browser could not remove the Screenshot its Browser Session already owned.",
	})
	// The removal proved every entry before deleting any, so a refusal left the
	// Screenshot the session already owned exactly where it was.
	expect(existsSync(path)).toBe(true)
})

test("a page that moves while it is captured keeps no Screenshot", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		navigateAfterMethod: {
			method: "Page.captureScreenshot",
			url: "https://fixture.test/elsewhere",
		},
	})
	await takeSnapshot(probe, "moved-snapshot")

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "moved-screenshot"])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "PAGE_IDENTITY_CHANGED",
		runId: "moved-screenshot",
		transactionState: "invalidated",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message: "The Controlled Page moved while it was being captured, so no Screenshot was kept.",
	})
	expect(readReceipt(probe).snapshot).toBeUndefined()
	expect(existsSync(join(probe.lockPath, "screenshots"))).toBe(false)
})

test("a page that moved keeps the Screenshot the session already owned", async () => {
	const { probe } = await pageProbe({
		navigateAfterMethod: {
			method: "Page.captureScreenshot",
			url: "https://fixture.test/elsewhere",
			occurrence: 2,
		},
	})
	const captured = await runProductionCliAsync(probe, ["screenshot", "--run-id", "moved-keeps-capture"])
	const path = (JSON.parse(captured.stdout).data.screenshot as { path: string }).path
	expect(existsSync(path)).toBe(true)

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "moved-keeps"])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "PAGE_IDENTITY_CHANGED",
		runId: "moved-keeps",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message: "The Controlled Page moved while it was being captured, so no Screenshot was kept.",
	})
	// A refusal that never reached the artifact must not remove one.
	expect(existsSync(path)).toBe(true)
})

test("a capture the page could not answer keeps no Screenshot", async () => {
	const { probe } = await pageProbe({ failMethods: ["Page.captureScreenshot"] })

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "unverified-screenshot"])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "PAGE_CONTROL_UNVERIFIED",
		runId: "unverified-screenshot",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the Browser Session and its CDP endpoint before retrying.",
		message: "Warm Browser could not capture the Controlled Page.",
	})
	expect(existsSync(join(probe.lockPath, "screenshots"))).toBe(false)
})

test("a capture the page could not answer leaves the Snapshot Generation exactly where it was", async () => {
	// Only the success path proved this before: a refused capture must leave the
	// generation, and every reference it issued, alive.
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		failMethods: ["Page.captureScreenshot"],
	})
	await takeSnapshot(probe, "refused-capture-snapshot")
	const receiptBefore = readFileSync(probe.sessionPath, "utf8")

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "refused-capture-generation"])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "PAGE_CONTROL_UNVERIFIED",
		runId: "refused-capture-generation",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the Browser Session and its CDP endpoint before retrying.",
		message: "Warm Browser could not capture the Controlled Page.",
	})
	expect(readFileSync(probe.sessionPath, "utf8")).toBe(receiptBefore)
})

test("bytes that are not one complete PNG are never kept as a Screenshot", async () => {
	// A truncated stream is not the page, it is however much of the page happened to arrive.
	for (const screenshotBytes of ["not-png", "truncated"] as const) {
		const { probe } = await pageProbe({ screenshotBytes })
		const runId = screenshotBytes === "not-png" ? "not-png-screenshot" : "truncated-screenshot"

		const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", runId])

		expectError(result, 20, {
			schemaVersion: 1,
			status: "error",
			command: "screenshot",
			resultCode: "PAGE_CONTROL_UNVERIFIED",
			runId: runId,
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Inspect the Browser Session and its CDP endpoint before retrying.",
			message: "The Controlled Page answered with something that is not one complete PNG image.",
		})
		expect(existsSync(join(probe.lockPath, "screenshots"))).toBe(false)
	}
})

test("bytes that are not one complete PNG leave the Snapshot Generation exactly where it was", async () => {
	// The same proof for the other refused capture: a stream cut off part-way
	// invalidates nothing the Browser Session still holds.
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		screenshotBytes: "truncated",
	})
	await takeSnapshot(probe, "truncated-capture-snapshot")
	const receiptBefore = readFileSync(probe.sessionPath, "utf8")

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "truncated-capture-generation"])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "PAGE_CONTROL_UNVERIFIED",
		runId: "truncated-capture-generation",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the Browser Session and its CDP endpoint before retrying.",
		message: "The Controlled Page answered with something that is not one complete PNG image.",
	})
	expect(readFileSync(probe.sessionPath, "utf8")).toBe(receiptBefore)
})

test("screenshot refuses a replaced Controlled Page", async () => {
	const { fixture, probe } = await pageProbe({ url: "https://fixture.test/start" })
	fixture.replacePage("page-2")

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "replaced-screenshot"])

	expectRefusal(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "CONTROLLED_PAGE_REPLACED",
		runId: "replaced-screenshot",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser open --url URL --adopt-page --run-id ID to bind the replacement Controlled Page.",
		message: "The Browser Session's Controlled Page was replaced by another page.",
	})
	expect(existsSync(join(probe.lockPath, "screenshots"))).toBe(false)
})

test("screenshot without a Browser Session refuses and writes nothing", async () => {
	const probe = productionCliProbe(pageProbePlan())

	const result = await runProductionCliAsync(probe, ["screenshot", "--run-id", "no-session"])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "screenshot",
		resultCode: "SESSION_ABSENT",
		runId: "no-session",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser start --run-id ID to create a Browser Session.",
		message: "No verified Browser Session owns a Controlled Page.",
	})
	expect(existsSync(probe.lockPath)).toBe(false)
})

test("capturing again replaces the Screenshot the Browser Session owned", async () => {
	const { probe } = await pageProbe()
	const first = await runProductionCliAsync(probe, ["screenshot", "--run-id", "screenshot-first"])
	const firstPath = (JSON.parse(first.stdout).data.screenshot as { path: string }).path
	const second = await runProductionCliAsync(probe, ["screenshot", "--run-id", "screenshot-second"])
	const secondPath = (JSON.parse(second.stdout).data.screenshot as { path: string }).path

	expect(firstPath).not.toBe(secondPath)
	expect(existsSync(firstPath)).toBe(false)
	expect(existsSync(secondPath)).toBe(true)
	expect(readdirSync(join(probe.lockPath, "screenshots"))).toEqual([basename(secondPath)])
})

test("a Screenshot carries no value the caller typed and no diagnostics", async () => {
	const { probe } = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })
	const snapshot = await takeSnapshot(probe, "screenshot-redaction-snapshot")
	const sentinel = "warm-browser-sentinel-value"
	const filled = await runProductionCliAsync(probe, [
		"fill",
		"--ref",
		snapshot.elements[4]!.ref,
		"--value",
		sentinel,
		"--run-id",
		"screenshot-redaction-fill",
	])
	expect(filled.stderr).toBe("")
	expect(filled.exitCode).toBe(0)

	const screenshot = await runProductionCliAsync(probe, ["screenshot", "--run-id", "screenshot-redaction"])
	const path = (JSON.parse(screenshot.stdout).data.screenshot as { path: string }).path

	expect(screenshot.stdout).not.toContain(sentinel)
	expect(readFileSync(path).includes(Buffer.from(sentinel))).toBe(false)
	// This is the bounded proof this seam reaches, and credential material itself is owned by the login ticket.
	expect(readFileSync(probe.sessionPath, "utf8")).not.toContain(sentinel)
})
