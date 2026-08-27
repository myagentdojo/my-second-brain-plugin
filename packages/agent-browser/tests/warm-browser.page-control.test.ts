import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"

import {
	acceptedReferenceLifetimeMs,
	ageSnapshotGeneration,
	controlledPageFixture,
	pageProbe,
	pageProbePlan,
	readReceipt,
	signInPage,
	stopControlledPageFixtures,
	takeSnapshot,
	writeReceipt,
} from "./fixtures/controlled-page-probe"
import {
	readBrowserSessionEvidenceIndependently,
	readCdpEndpointIndependently,
} from "./fixtures/independent-cdp-reader"
import {
	expectError,
	expectRefusal,
	hostEffects,
	productionCliProbe,
	removeProductionCliProbes,
	runProductionCliAsync,
	systemRows,
	verifiedReading,
} from "./fixtures/production-cli-harness"
import { snapshotReferenceTimeoutMs } from "../src/modules/warm-browser/bounds"

afterEach(() => {
	stopControlledPageFixtures()
	removeProductionCliProbes()
})

test("open navigates the one Controlled Page and invalidates every earlier reference", async () => {
	const { fixture, probe } = await pageProbe({ url: "https://fixture.test/start" })

	const opened = await runProductionCliAsync(probe, [
		"open",
		"--url",
		"https://fixture.test/next",
		"--run-id",
		"open-run",
	])

	expect(opened.stderr).toBe("")
	expect(opened.exitCode).toBe(0)
	// Independent oracle: the whole envelope, restated by hand.
	expect(JSON.parse(opened.stdout)).toEqual({
		schemaVersion: 1,
		status: "ok",
		command: "open",
		resultCode: "PAGE_OPENED",
		runId: "open-run",
		transactionState: "acted",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		data: {
			controlledPage: { targetId: "page-1", url: "https://fixture.test/next" },
			adoptedPage: false,
			invalidatedReferences: true,
			postcondition: "running",
		},
	})
	// The navigation really happened on the fixture, over the derived socket.
	expect(fixture.pageUrl()).toBe("https://fixture.test/next")
	expect(fixture.attachedTargets()).toEqual(["/devtools/page/page-1"])
	expect(fixture.cdpMethods()).toContain("Page.navigate")
})

test("snapshot issues references bound to the Controlled Page and its generation", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})

	const result = await runProductionCliAsync(probe, ["snapshot", "--run-id", "snapshot-run"])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	// The generation identity is minted by the production Adapter, so it is read
	// back out of the private receipt rather than restated here.
	const generationId = (readReceipt(probe).snapshot as { generationId: string }).generationId
	expect(generationId).toMatch(/^snapshot-[0-9a-f-]{36}$/)
	// Independent oracle: the whole envelope, restated by hand.
	expect(JSON.parse(result.stdout)).toEqual({
		schemaVersion: 1,
		status: "ok",
		command: "snapshot",
		resultCode: "SNAPSHOT_TAKEN",
		runId: "snapshot-run",
		transactionState: "acted",
		retrySafe: true,
		nextAction:
			"Run warm-browser click --ref REFERENCE --run-id ID or warm-browser fill --ref REFERENCE --value TEXT --run-id ID.",
		data: {
			generationId,
			controlledPage: { targetId: "page-1", url: "https://fixture.test/sign-in" },
			elementCount: 5,
			truncated: false,
			elements: [
				{ ref: `e1@${generationId}`, role: "link", name: "Docs", credentialField: false },
				// The login identifier is a credential field, exactly like the
				// password beside it: it is half of the pair login owns.
				{ ref: `e2@${generationId}`, role: "textbox", name: "Email", credentialField: true },
				{ ref: `e3@${generationId}`, role: "textbox", name: "Password", credentialField: true },
				{ ref: `e4@${generationId}`, role: "button", name: "Sign in", credentialField: false },
				{ ref: `e5@${generationId}`, role: "searchbox", name: "Search", credentialField: false },
			],
			postcondition: "running",
		},
	})
	// No selector of any kind reaches the caller.
	expect(result.stdout).not.toContain("backendNodeId")
	expect(result.stdout).not.toContain("href")
	expect(fixture.cdpMethods()).toEqual([
		"Page.enable",
		"DOM.enable",
		"Accessibility.enable",
		"Page.getFrameTree",
		"DOM.getDocument",
		"Accessibility.getFullAXTree",
		"Page.getFrameTree",
	])
	expect(statSync(probe.sessionPath).mode & 0o7777).toBe(0o600)
})

test("click acts on one referenced element of the Controlled Page", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	const snapshot = await takeSnapshot(probe, "click-snapshot")

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[3]!.ref,
		"--run-id",
		"click-run",
	])

	expect(clicked.stderr).toBe("")
	expect(clicked.exitCode).toBe(0)
	expect(JSON.parse(clicked.stdout)).toEqual({
		schemaVersion: 1,
		status: "ok",
		command: "click",
		resultCode: "ELEMENT_CLICKED",
		runId: "click-run",
		transactionState: "acted",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		data: {
			reference: `e4@${snapshot.generationId}`,
			controlledPage: { targetId: "page-1", url: "https://fixture.test/sign-in" },
			invalidatedReferences: false,
			postcondition: "running",
		},
	})
	// Independent oracle: the centre of the button box declared by the fixture.
	expect(fixture.clicks()).toEqual([{ x: 55, y: 156 }])
	// The references survive a click that left the page where it was.
	expect((readReceipt(probe).snapshot as { generationId: string }).generationId).toBe(
		snapshot.generationId,
	)
})

test("fill types one non-secret value that never leaves the Controlled Page", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	const snapshot = await takeSnapshot(probe, "fill-snapshot")

	const filled = await runProductionCliAsync(probe, [
		"fill",
		"--ref",
		snapshot.elements[4]!.ref,
		"--value",
		"warm browser",
		"--run-id",
		"fill-run",
	])

	expect(filled.stderr).toBe("")
	expect(filled.exitCode).toBe(0)
	expect(JSON.parse(filled.stdout)).toEqual({
		schemaVersion: 1,
		status: "ok",
		command: "fill",
		resultCode: "FIELD_FILLED",
		runId: "fill-run",
		transactionState: "acted",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		data: {
			reference: `e5@${snapshot.generationId}`,
			valueLength: 12,
			controlledPage: { targetId: "page-1", url: "https://fixture.test/sign-in" },
			invalidatedReferences: false,
			postcondition: "running",
		},
	})
	// The value reached exactly the selected field, and only that field.
	expect(fixture.focusedNodes()).toEqual([16])
	expect(fixture.insertedText()).toEqual(["warm browser"])
	// It is nowhere a caller or a later reader could find it.
	expect(filled.stdout).not.toContain("warm browser")
	expect(readFileSync(probe.sessionPath, "utf8")).not.toContain("warm browser")
})

test("an independent CDP target reader proves the process and Controlled Page selected", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	await takeSnapshot(probe, "independent-snapshot")

	// Read the endpoint again, with a reader that shares no code with the Module.
	const independent = await readCdpEndpointIndependently(fixture.port)
	const status = await runProductionCliAsync(probe, ["status", "--run-id", "independent-status"])
	const data = JSON.parse(status.stdout).data as {
		processId: number
		endpoint: { host: string; port: number }
		controlledPage: { targetId: string }
	}

	// Independent oracle: the endpoint exposes exactly one page, and this is it.
	expect(independent.pageTargets.map(({ id }) => id)).toEqual(["page-1"])
	expect(independent.browser).toBe("Chrome/151.0.7922.174")
	expect(independent.browserWebSocketHost).toBe("127.0.0.1")
	expect(independent.browserWebSocketPort).toBe(fixture.port)
	// What Warm Browser reported is what the endpoint independently shows.
	expect(data.controlledPage.targetId).toBe(independent.pageTargets[0]!.id)
	expect(data.endpoint).toEqual({ host: "127.0.0.1", port: fixture.port })
	// The launched process identity this session owns, and the listener that
	// answered for it, are the ones the harness recorded for the launch.
	expect(data.processId).toBe(4242)
	const listenerPorts = hostEffects(probe)
		.filter(({ action }) => action === "listener")
		.map(({ port }) => port)
	expect(listenerPorts.length).toBeGreaterThan(0)
	expect([...new Set(listenerPorts)]).toEqual([fixture.port])
	// Warm Browser reached exactly that page and no other target.
	expect(fixture.attachedTargets()).toEqual(["/devtools/page/page-1"])
	expect(readReceipt(probe)).toMatchObject({
		endpoint: {
			port: fixture.port,
			browserVersion: independent.browser,
			controlledPageTargetId: independent.pageTargets[0]!.id,
		},
	})
})

test("the Controlled Page socket is the one Warm Browser derives, not the one declared", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		declaredPagePath: "/devtools/page/DECOY",
	})

	await takeSnapshot(probe, "derived-socket-snapshot")

	// The endpoint advertises another socket; the reader below shows exactly what
	// it advertised, and Warm Browser dialled its own address regardless.
	const independent = await readCdpEndpointIndependently(fixture.port)
	expect(independent.pageTargets[0]!.webSocketDebuggerUrl).toBe(
		`ws://127.0.0.1:${fixture.port}/devtools/page/DECOY`,
	)
	expect(fixture.attachedTargets()).toEqual(["/devtools/page/page-1"])
})

test("a fresh Snapshot Generation invalidates every earlier reference", async () => {
	const { probe } = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })
	const first = await takeSnapshot(probe, "stale-first")
	const second = await takeSnapshot(probe, "stale-second")
	expect(second.generationId).not.toBe(first.generationId)

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		first.elements[3]!.ref,
		"--run-id",
		"stale-click",
	])

	expectError(clicked, 21, {
		schemaVersion: 1,
		status: "error",
		command: "click",
		resultCode: "SNAPSHOT_REFERENCE_STALE",
		runId: "stale-click",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message:
			"The Snapshot Reference belongs to another Snapshot Generation, another Controlled Page, or a generation that has expired.",
	})
})

test("open invalidates every earlier reference before it navigates", async () => {
	const { probe } = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })
	const snapshot = await takeSnapshot(probe, "open-invalidates-snapshot")

	const opened = await runProductionCliAsync(probe, [
		"open",
		"--url",
		"https://fixture.test/next",
		"--run-id",
		"open-invalidates",
	])
	expect(opened.exitCode).toBe(0)
	expect(JSON.parse(opened.stdout).data).toMatchObject({ invalidatedReferences: true })
	expect(readReceipt(probe).snapshot).toBeUndefined()

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[3]!.ref,
		"--run-id",
		"open-invalidated-click",
	])
	expectRefusal(clicked, 21, {
		command: "click",
		resultCode: "SNAPSHOT_ABSENT",
		message: "This Browser Session holds no Snapshot Generation.",
		nextAction: "Run warm-browser snapshot --run-id ID before acting on the Controlled Page.",
	})
})

test("production works to the Snapshot Reference lifetime these proofs accept", () => {
	// The lifetime is pinned here, on its own, against the value restated by
	// hand in the test fixtures. Every other proof states an age rather than a
	// bound, so this is the single place a changed production lifetime is
	// reported, and it is reported as a decision to review rather than absorbed.
	expect(snapshotReferenceTimeoutMs).toBe(acceptedReferenceLifetimeMs)
})

test.each([
	["half the accepted lifetime", acceptedReferenceLifetimeMs / 2, 0, "ELEMENT_CLICKED"],
	["one second past it", acceptedReferenceLifetimeMs + 1_000, 21, "SNAPSHOT_REFERENCE_STALE"],
] as const)(
	"a reference aged %s is answered from the accepted lifetime alone",
	async (_name, ageMs, exitCode, resultCode) => {
		const { probe } = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })
		const snapshot = await takeSnapshot(probe, "lifetime-snapshot")
		// The age comes from the lifetime these tests accept, never from the bound
		// production works to, so a production lifetime shorter than half a minute
		// or longer than a minute fails one of these two rows.
		ageSnapshotGeneration(probe, ageMs)

		const clicked = await runProductionCliAsync(probe, [
			"click",
			"--ref",
			snapshot.elements[3]!.ref,
			"--run-id",
			"lifetime-click",
		])

		if (exitCode === 0) {
			expect(clicked.stderr).toBe("")
			expect(clicked.exitCode).toBe(0)
			expect(JSON.parse(clicked.stdout).resultCode).toBe(resultCode)
			return
		}
		expectRefusal(clicked, exitCode, { command: "click", resultCode })
	},
)

test("a reference issued against another Controlled Page is refused", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	const snapshot = await takeSnapshot(probe, "wrong-page-snapshot")
	const receipt = readReceipt(probe)
	const generation = receipt.snapshot as Record<string, unknown>
	const basis = generation.basis as Record<string, unknown>
	writeReceipt(probe, {
		...receipt,
		snapshot: { ...generation, basis: { ...basis, targetId: "page-elsewhere" } },
	})
	const attachedBefore = fixture.attachedTargets().length

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[3]!.ref,
		"--run-id",
		"wrong-page-click",
	])

	expectRefusal(clicked, 21, { command: "click", resultCode: "SNAPSHOT_REFERENCE_STALE" })
	// Nothing was said to the Controlled Page on that reference's behalf.
	expect(fixture.attachedTargets().length).toBe(attachedBefore)
	expect(fixture.clicks()).toEqual([])
})

test("a page that moves between the snapshot and the act refuses the act", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	const snapshot = await takeSnapshot(probe, "race-snapshot")
	fixture.navigate("https://fixture.test/elsewhere")

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[3]!.ref,
		"--run-id",
		"race-click",
	])

	expectError(clicked, 21, {
		schemaVersion: 1,
		status: "error",
		command: "click",
		resultCode: "PAGE_IDENTITY_CHANGED",
		runId: "race-click",
		transactionState: "invalidated",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message: "The Controlled Page is no longer the page this Snapshot Reference was issued against.",
	})
	expect(fixture.clicks()).toEqual([])
	// The references described a page that has gone, so they are gone with it,
	// and reloaded durable state says so rather than offering them again.
	expect(readReceipt(probe).snapshot).toBeUndefined()
	expectRefusal(
		await runProductionCliAsync(probe, [
			"click",
			"--ref",
			snapshot.elements[3]!.ref,
			"--run-id",
			"race-click-again",
		]),
		21,
		{ resultCode: "SNAPSHOT_ABSENT" },
	)
})

test("a page that moves while it is read discards the generation it had issued", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		// The page moves the second time it is read, so the first snapshot
		// succeeds and the second one races.
		navigateAfterMethod: {
			method: "Accessibility.getFullAXTree",
			url: "https://fixture.test/moved",
			occurrence: 2,
		},
	})
	const first = await takeSnapshot(probe, "race-generation-first")
	expect(readReceipt(probe).snapshot).toMatchObject({ generationId: first.generationId })

	const raced = await runProductionCliAsync(probe, ["snapshot", "--run-id", "race-generation"])

	expectRefusal(raced, 21, {
		command: "snapshot",
		resultCode: "PAGE_IDENTITY_CHANGED",
		transactionState: "invalidated",
	})
	// The earlier generation described the page before it moved, so it does not
	// survive the race that proved the page moved.
	expect(readReceipt(probe).snapshot).toBeUndefined()
	expectRefusal(
		await runProductionCliAsync(probe, [
			"click",
			"--ref",
			first.elements[3]!.ref,
			"--run-id",
			"race-generation-click",
		]),
		21,
		{ resultCode: "SNAPSHOT_ABSENT" },
	)
})

test("a page that moves while it is being read issues no reference at all", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		driftDuringSnapshot: true,
	})

	const result = await runProductionCliAsync(probe, ["snapshot", "--run-id", "drift-snapshot"])

	expectRefusal(result, 21, {
		command: "snapshot",
		resultCode: "PAGE_IDENTITY_CHANGED",
		message: "The Controlled Page moved while it was being read, so no Snapshot Reference was issued.",
	})
	expect(readReceipt(probe).snapshot).toBeUndefined()
})

test("a click that navigates the Controlled Page invalidates the references it used", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: [
			...signInPage,
			{
				backendNodeId: 17,
				role: "link",
				name: "Leave",
				nodeName: "A",
				attributes: { href: "/left" },
				box: [10, 240, 60, 20],
				navigatesTo: "https://fixture.test/left",
			},
		],
	})
	const snapshot = await takeSnapshot(probe, "navigating-click-snapshot")

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[5]!.ref,
		"--run-id",
		"navigating-click",
	])

	expect(clicked.exitCode).toBe(0)
	expect(JSON.parse(clicked.stdout).data).toEqual({
		reference: `e6@${snapshot.generationId}`,
		controlledPage: { targetId: "page-1", url: "https://fixture.test/left" },
		invalidatedReferences: true,
		postcondition: "running",
	})
	expect(readReceipt(probe).snapshot).toBeUndefined()
})

test("a replaced Controlled Page is refused until an open explicitly adopts it", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	const snapshot = await takeSnapshot(probe, "replacement-snapshot")
	fixture.replacePage("page-2")

	const refused = await runProductionCliAsync(probe, ["snapshot", "--run-id", "replaced-snapshot"])
	expectError(refused, 20, {
		schemaVersion: 1,
		status: "error",
		command: "snapshot",
		resultCode: "CONTROLLED_PAGE_REPLACED",
		runId: "replaced-snapshot",
		transactionState: "invalidated",
		retrySafe: false,
		nextAction:
			"Run warm-browser open --url URL --adopt-page --run-id ID to bind the replacement Controlled Page.",
		message: "The Browser Session's Controlled Page was replaced by another page.",
	})
	// The receipt still names the page it was bound to, so nothing was adopted.
	// The references it issued are gone, because the page they described is.
	expect(readReceipt(probe)).toMatchObject({ endpoint: { controlledPageTargetId: "page-1" } })
	expect(readReceipt(probe).snapshot).toBeUndefined()
	// Reloading that durable state answers the old reference the same way.
	expectRefusal(
		await runProductionCliAsync(probe, [
			"click",
			"--ref",
			snapshot.elements[3]!.ref,
			"--run-id",
			"replaced-click",
		]),
		20,
		{ resultCode: "CONTROLLED_PAGE_REPLACED" },
	)

	const adopted = await runProductionCliAsync(probe, [
		"open",
		"--url",
		"https://fixture.test/after-replacement",
		"--adopt-page",
		"--run-id",
		"adopt-run",
	])
	expect(adopted.stderr).toBe("")
	expect(JSON.parse(adopted.stdout).data).toEqual({
		controlledPage: { targetId: "page-2", url: "https://fixture.test/after-replacement" },
		adoptedPage: true,
		invalidatedReferences: true,
		postcondition: "running",
	})
	expect(readReceipt(probe)).toMatchObject({ endpoint: { controlledPageTargetId: "page-2" } })
	expect(readReceipt(probe).snapshot).toBeUndefined()

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[3]!.ref,
		"--run-id",
		"adopted-click",
	])
	expectRefusal(clicked, 21, { command: "click", resultCode: "SNAPSHOT_ABSENT" })
})

test("more than one page is never one Controlled Page", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	fixture.setTargets([
		{ id: "page-1", type: "page" },
		{ id: "page-2", type: "page" },
	])

	const result = await runProductionCliAsync(probe, ["snapshot", "--run-id", "ambiguous-page"])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "snapshot",
		resultCode: "CONTROLLED_PAGE_AMBIGUOUS",
		runId: "ambiguous-page",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the Browser Session with its owned process still preserved.",
		message: "The verified CDP endpoint exposes more than one page.",
	})
	expect(fixture.attachedTargets()).toEqual([])
})

test("no page at all is never one Controlled Page", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	fixture.setTargets([{ id: "worker-1", type: "service_worker" }])

	const result = await runProductionCliAsync(probe, ["snapshot", "--run-id", "absent-page"])

	expectRefusal(result, 20, {
		command: "snapshot",
		resultCode: "CONTROLLED_PAGE_UNAVAILABLE",
		message: "The verified CDP endpoint exposes no Controlled Page.",
	})
	expect(fixture.attachedTargets()).toEqual([])
}, 30_000)

test("fill refuses a credential field before it says anything to the page", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	const snapshot = await takeSnapshot(probe, "credential-snapshot")
	const attachedBefore = fixture.attachedTargets().length

	const filled = await runProductionCliAsync(probe, [
		"fill",
		"--ref",
		snapshot.elements[2]!.ref,
		"--value",
		"not-a-real-secret",
		"--run-id",
		"credential-fill",
	])

	expectError(filled, 21, {
		schemaVersion: 1,
		status: "error",
		command: "fill",
		resultCode: "CREDENTIAL_FIELD_REFUSED",
		runId: "credential-fill",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction:
			"Use the Warm Browser login command for a credential field; it is not callable in this slice.",
		message: "Warm Browser does not type credentials into the Controlled Page.",
	})
	// Nothing was typed, nothing was focused, and no conversation was opened.
	expect(fixture.insertedText()).toEqual([])
	expect(fixture.focusedNodes()).toEqual([])
	expect(fixture.attachedTargets().length).toBe(attachedBefore)
	expect(filled.stderr).not.toContain("not-a-real-secret")
})

test.each([
	["a password field", { type: "password" }],
	["a login identifier field", { autocomplete: "username" }],
] as const)(
	"fill refuses a field that became %s after the snapshot",
	async (_name, becomesAttributes) => {
		const { fixture, probe } = await pageProbe({
			url: "https://fixture.test/sign-in",
			elements: [
				{
					backendNodeId: 21,
					role: "textbox",
					name: "Code",
					nodeName: "INPUT",
					attributes: { type: "text", name: "code" },
					box: [10, 10, 100, 20],
					becomesAttributes,
				},
			],
		})
		const snapshot = await takeSnapshot(probe, "flip-snapshot")
		expect(snapshot.data).toMatchObject({
			elements: [{ ref: `e1@${snapshot.generationId}`, credentialField: false }],
		})

		const filled = await runProductionCliAsync(probe, [
			"fill",
			"--ref",
			snapshot.elements[0]!.ref,
			"--value",
			"123456",
			"--run-id",
			"flip-fill",
		])

		expectRefusal(filled, 21, { command: "fill", resultCode: "CREDENTIAL_FIELD_REFUSED" })
		expect(fixture.insertedText()).toEqual([])
	},
)

// Independent oracle: the login-identifier signals a public fill must refuse,
// each written out as the attributes a page would actually carry.
const loginIdentifierFields: readonly (readonly [string, Record<string, string>])[] = [
	["the standard login identifier token", { type: "text", autocomplete: "username" }],
	["a username identifier", { type: "text", name: "user_name" }],
	["a login identifier", { type: "text", id: "login" }],
	["an address the account is named by", { type: "email", name: "contact_email" }],
]

test.each(loginIdentifierFields)(
	"fill refuses a field carrying %s and routes it to login",
	async (_name, attributes) => {
		const { fixture, probe } = await pageProbe({
			url: "https://fixture.test/sign-in",
			elements: [{
				backendNodeId: 31,
				role: "textbox",
				name: "Who are you",
				nodeName: "INPUT",
				attributes,
				box: [10, 10, 100, 20],
			}],
		})
		const snapshot = await takeSnapshot(probe, "username-snapshot")
		// The snapshot already names it, so the refusal costs no conversation.
		expect(snapshot.data).toMatchObject({
			elements: [{ ref: `e1@${snapshot.generationId}`, credentialField: true }],
		})
		const attachedBefore = fixture.attachedTargets().length

		const filled = await runProductionCliAsync(probe, [
			"fill",
			"--ref",
			snapshot.elements[0]!.ref,
			"--value",
			"someone",
			"--run-id",
			"username-fill",
		])

		expectRefusal(filled, 21, {
			command: "fill",
			resultCode: "CREDENTIAL_FIELD_REFUSED",
			nextAction:
				"Use the Warm Browser login command for a credential field; it is not callable in this slice.",
		})
		expect(fixture.insertedText()).toEqual([])
		expect(fixture.attachedTargets().length).toBe(attachedBefore)
	},
)

test.each(["--selector", "--css", "--xpath", "--text"] as const)(
	"the %s public selector is refused by name on every command",
	async (flag) => {
		const { probe } = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })

		const result = await runProductionCliAsync(probe, [
			"click",
			flag,
			"#sign-in",
			"--run-id",
			"selector-run",
		])

		expectError(result, 21, {
			schemaVersion: 1,
			status: "error",
			command: "click",
			resultCode: "SELECTOR_UNSUPPORTED",
			runId: "selector-run",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Run warm-browser snapshot --run-id ID and act through the references it issues.",
			message: `Warm Browser acts through Snapshot References, not the ${flag} selector.`,
		})
	},
)

test("a selector given as a reference is not a Snapshot Reference", async () => {
	const { probe } = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })
	await takeSnapshot(probe, "selector-ref-snapshot")

	const result = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		"#sign-in",
		"--run-id",
		"selector-ref",
	])

	expectRefusal(result, 21, {
		command: "click",
		resultCode: "SNAPSHOT_REFERENCE_INVALID",
		message: "Warm Browser acts through a Snapshot Reference, and this is not one.",
	})
})

test("a reference naming no element of the current generation is refused", async () => {
	const { probe } = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })
	const snapshot = await takeSnapshot(probe, "unknown-ref-snapshot")

	const result = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		`e9@${snapshot.generationId}`,
		"--run-id",
		"unknown-ref",
	])

	expectRefusal(result, 21, {
		command: "click",
		resultCode: "SNAPSHOT_REFERENCE_INVALID",
		message: "The Snapshot Reference names no element of the current Snapshot Generation.",
	})
})

test("an element that has left the Controlled Page is refused as a stale reference", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: [
			{
				backendNodeId: 31,
				role: "button",
				name: "Ghost",
				nodeName: "BUTTON",
			},
		],
	})
	const snapshot = await takeSnapshot(probe, "ghost-snapshot")

	const result = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[0]!.ref,
		"--run-id",
		"ghost-click",
	])

	expectRefusal(result, 21, {
		command: "click",
		resultCode: "SNAPSHOT_REFERENCE_STALE",
		message: "The referenced element is no longer part of the Controlled Page.",
	})
	expect(fixture.clicks()).toEqual([])
})

test("a navigation the browser refuses is reported as a navigation that did not happen", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		refuseNavigationTo: "https://fixture.test/missing",
	})

	const result = await runProductionCliAsync(probe, [
		"open",
		"--url",
		"https://fixture.test/missing",
		"--run-id",
		"refused-navigation",
	])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "open",
		resultCode: "NAVIGATION_FAILED",
		runId: "refused-navigation",
		transactionState: "acted",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to read where the Controlled Page actually is.",
		message: "The Controlled Page did not complete the requested navigation.",
	})
})

test("a CDP conversation that cannot be completed never reads as a snapshot", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		failMethods: ["Accessibility.getFullAXTree"],
	})

	const result = await runProductionCliAsync(probe, ["snapshot", "--run-id", "unverified-snapshot"])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "snapshot",
		resultCode: "PAGE_CONTROL_UNVERIFIED",
		runId: "unverified-snapshot",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the Browser Session and its CDP endpoint before retrying.",
		message: "Warm Browser could not read the Controlled Page.",
	})
	expect(readReceipt(probe).snapshot).toBeUndefined()
})

test.each(["open", "snapshot", "click", "fill"] as const)(
	"%s refuses when no Browser Session owns a Controlled Page",
	async (command) => {
		const probe = productionCliProbe({ processTable: verifiedReading(systemRows) })
		const options: Record<string, readonly string[]> = {
			open: ["--url", "https://fixture.test/next"],
			snapshot: [],
			click: ["--ref", "e1@snapshot-absent"],
			fill: ["--ref", "e1@snapshot-absent", "--value", "text"],
		}

		const result = await runProductionCliAsync(probe, [
			command,
			...options[command]!,
			"--run-id",
			`absent-${command}`,
		])

		expectError(result, 21, {
			schemaVersion: 1,
			status: "error",
			command,
			resultCode: "SESSION_ABSENT",
			runId: `absent-${command}`,
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Run warm-browser start --run-id ID to create a Browser Session.",
			message: "No verified Browser Session owns a Controlled Page.",
		})
	},
)

test("a page address outside http and https is refused before any effect", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	const attachedBefore = fixture.attachedTargets().length

	const result = await runProductionCliAsync(probe, [
		"open",
		"--url",
		"javascript:void(0)",
		"--run-id",
		"scheme-run",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "open",
		resultCode: "NAVIGATION_TARGET_REFUSED",
		runId: "scheme-run",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser open --url URL --run-id ID with an http or https address.",
		message: "Warm Browser opens http and https pages only.",
	})
	expect(fixture.attachedTargets().length).toBe(attachedBefore)
	expect(fixture.pageUrl()).toBe("https://fixture.test/sign-in")
})

test.each([
	["open", ["open"], "The --url option is required by open."],
	["click", ["click"], "The --ref option is required by click."],
	["fill", ["fill", "--ref", "e1@snapshot-x"], "The --value option is required by fill."],
	["snapshot", ["snapshot", "--port", "9333"], "Warm Browser received an unsupported argument."],
] as const)("%s states the argument contract it was given wrong", async (_name, argv, message) => {
	const probe = productionCliProbe({ processTable: verifiedReading(systemRows) })

	const result = await runProductionCliAsync(probe, [...argv, "--run-id", "argument-run"])

	expectError(result, 2, {
		schemaVersion: 1,
		status: "error",
		command: argv[0],
		resultCode: "USAGE_ERROR",
		runId: "argument-run",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser help --run-id ID and correct the command arguments.",
		message,
	})
})

test("a page with more elements than one generation may carry says so", async () => {
	// Independent oracle: one element past the bound the Module publishes.
	const beyondTheBound = 501
	const { probe } = await pageProbe({
		url: "https://fixture.test/long",
		elements: Array.from({ length: beyondTheBound }, (_, index) => ({
			backendNodeId: 100 + index,
			role: "button",
			name: `Item ${index + 1}`,
			nodeName: "BUTTON",
			box: [0, index, 10, 10] as const,
		})),
	})

	const snapshot = await takeSnapshot(probe, "truncated-snapshot")

	expect(snapshot.data).toMatchObject({ elementCount: 500, truncated: true })
	expect(snapshot.elements.length).toBe(500)
	expect(snapshot.elements.at(-1)!.ref).toBe(`e500@${snapshot.generationId}`)
	// The element beyond the bound has no reference, and asking for one says so
	// rather than acting on whatever element 501 would have been.
	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		`e501@${snapshot.generationId}`,
		"--run-id",
		"truncated-click",
	])
	expectRefusal(clicked, 21, {
		command: "click",
		resultCode: "SNAPSHOT_REFERENCE_INVALID",
		message: "The Snapshot Reference names no element of the current Snapshot Generation.",
	})
})

test("a click whose outcome cannot be verified is never reported unchanged", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		failMethods: ["Input.dispatchMouseEvent"],
	})
	const snapshot = await takeSnapshot(probe, "unverified-click-snapshot")

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[3]!.ref,
		"--run-id",
		"unverified-click",
	])

	expectError(clicked, 20, {
		schemaVersion: 1,
		status: "error",
		command: "click",
		resultCode: "PAGE_CONTROL_UNVERIFIED",
		runId: "unverified-click",
		transactionState: "acted",
		retrySafe: false,
		nextAction: "Inspect the Browser Session and its CDP endpoint before retrying.",
		message: "Warm Browser could not verify what its Controlled Page did with the action.",
	})
	// What reached the page is unknown, so the references that described it before
	// are not kept either.
	expect(readReceipt(probe).snapshot).toBeUndefined()
})

test("a navigation whose outcome cannot be verified is never reported unchanged", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		failMethods: ["Page.navigate"],
	})

	const opened = await runProductionCliAsync(probe, [
		"open",
		"--url",
		"https://fixture.test/next",
		"--run-id",
		"unverified-open",
	])

	expectRefusal(opened, 20, {
		command: "open",
		resultCode: "PAGE_CONTROL_UNVERIFIED",
		transactionState: "acted",
		message: "Warm Browser could not verify what its Controlled Page did with the navigation.",
	})
})

test.each([
	[
		"a Snapshot Generation on a receipt with no verified page",
		(receipt: Record<string, unknown>) => {
			const endpoint = receipt.endpoint as Record<string, unknown>
			return {
				...receipt,
				phase: "starting",
				endpoint: { host: endpoint.host, port: endpoint.port },
			}
		},
	],
	[
		"an element identity that is not a node identity",
		(receipt: Record<string, unknown>) => {
			const generation = receipt.snapshot as Record<string, unknown>
			const elements = generation.elements as Record<string, unknown>[]
			return {
				...receipt,
				snapshot: {
					...generation,
					elements: [{ ...elements[0]!, backendNodeId: 0 }, ...elements.slice(1)],
				},
			}
		},
	],
	[
		"an element name longer than one snapshot may carry",
		(receipt: Record<string, unknown>) => {
			const generation = receipt.snapshot as Record<string, unknown>
			const elements = generation.elements as Record<string, unknown>[]
			return {
				...receipt,
				snapshot: {
					...generation,
					elements: [{ ...elements[0]!, name: "n".repeat(257) }, ...elements.slice(1)],
				},
			}
		},
	],
	[
		"an identity basis with no document load",
		(receipt: Record<string, unknown>) => {
			const generation = receipt.snapshot as Record<string, unknown>
			const basis = generation.basis as Record<string, unknown>
			return {
				...receipt,
				snapshot: { ...generation, basis: { ...basis, loaderId: "" } },
			}
		},
	],
] as const)("a durable receipt carrying %s is refused as unsafe state", async (_name, rebreak) => {
	const { probe } = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })
	const snapshot = await takeSnapshot(probe, "unsafe-state-snapshot")
	writeReceipt(probe, rebreak(readReceipt(probe)))
	const stateBefore = readFileSync(probe.sessionPath, "utf8")

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[3]!.ref,
		"--run-id",
		"unsafe-state-click",
	])

	expectRefusal(clicked, 20, {
		command: "click",
		resultCode: "STATE_UNSAFE",
		message: "Warm Browser private state is unsafe or unreadable.",
		nextAction: "Repair the private XDG state ownership and permissions before retrying.",
	})
	// The receipt is preserved exactly as it was found, for inspection.
	expect(readFileSync(probe.sessionPath, "utf8")).toBe(stateBefore)
})

test("an element whose node identity a receipt could not carry is left out", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: [
			{ backendNodeId: 0, role: "button", name: "Unwritable", nodeName: "BUTTON", box: [0, 0, 8, 8] },
			{ backendNodeId: 7, role: "button", name: "Writable", nodeName: "BUTTON", box: [0, 20, 8, 8] },
		],
	})

	const snapshot = await takeSnapshot(probe, "unwritable-node-snapshot")

	// The whole reading still succeeds; only the element that could never be
	// referenced is missing, and the reference numbering names what remains.
	expect(snapshot.data).toMatchObject({
		elementCount: 1,
		elements: [{ ref: `e1@${snapshot.generationId}`, name: "Writable" }],
	})
	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		`e1@${snapshot.generationId}`,
		"--run-id",
		"unwritable-node-click",
	])
	expect(clicked.stderr).toBe("")
	expect(clicked.exitCode).toBe(0)
})

test("a selector where a command belongs names no command it did not run", async () => {
	const probe = productionCliProbe({ processTable: verifiedReading(systemRows) })

	const result = await runProductionCliAsync(probe, ["--selector", "#sign-in", "--run-id", "no-command"])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "unknown",
		resultCode: "SELECTOR_UNSUPPORTED",
		runId: "no-command",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID and act through the references it issues.",
		message: "Warm Browser acts through Snapshot References, not the --selector selector.",
	})
})

test("a navigation that another document wins is never reported as the page opened", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		// Another navigation lands the moment this one is accepted.
		navigateAfterMethod: { method: "Page.navigate", url: "https://fixture.test/competing" },
	})

	const opened = await runProductionCliAsync(probe, [
		"open",
		"--url",
		"https://fixture.test/next",
		"--run-id",
		"competing-open",
	])

	expectError(opened, 21, {
		schemaVersion: 1,
		status: "error",
		command: "open",
		resultCode: "PAGE_IDENTITY_CHANGED",
		runId: "competing-open",
		transactionState: "acted",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message: "The Controlled Page is showing a document this navigation did not request.",
	})
	// The page really is somewhere else, which is why no success was claimed.
	expect(fixture.pageUrl()).toBe("https://fixture.test/competing")
})

test("a navigation that lands before the dispatch never receives the input", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		// The page moves after the element is described and before it is acted on.
		navigateAfterMethod: { method: "DOM.describeNode", url: "https://fixture.test/late" },
	})
	const snapshot = await takeSnapshot(probe, "late-navigation-snapshot")

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[3]!.ref,
		"--run-id",
		"late-navigation-click",
	])

	expectRefusal(clicked, 21, {
		command: "click",
		resultCode: "PAGE_IDENTITY_CHANGED",
		transactionState: "invalidated",
	})
	// Nothing was dispatched into the document that arrived late.
	expect(fixture.clicks()).toEqual([])
	expect(readReceipt(probe).snapshot).toBeUndefined()
})

test("a navigation that wins after the dispatch is never reported as a click that worked", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: [{
			backendNodeId: 51,
			role: "button",
			name: "Toggle",
			nodeName: "BUTTON",
			// An explicit button type cannot navigate the page by itself, so a
			// navigation after clicking it is another document's, not this act's.
			attributes: { type: "button" },
			box: [10, 10, 80, 24],
		}],
		navigateAfterMethod: { method: "DOM.getBoxModel", url: "https://fixture.test/stolen" },
	})
	const snapshot = await takeSnapshot(probe, "stolen-click-snapshot")

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[0]!.ref,
		"--run-id",
		"stolen-click",
	])

	expectError(clicked, 21, {
		schemaVersion: 1,
		status: "error",
		command: "click",
		resultCode: "PAGE_IDENTITY_CHANGED",
		runId: "stolen-click",
		transactionState: "acted",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message: "The Controlled Page moved to a document this action did not ask for.",
	})
	expect(fixture.pageUrl()).toBe("https://fixture.test/stolen")
	expect(readReceipt(probe).snapshot).toBeUndefined()
})

test("a navigation after typing is never reported as a fill that worked", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		navigateAfterMethod: { method: "Input.insertText", url: "https://fixture.test/stolen" },
	})
	const snapshot = await takeSnapshot(probe, "stolen-fill-snapshot")

	const filled = await runProductionCliAsync(probe, [
		"fill",
		"--ref",
		snapshot.elements[4]!.ref,
		"--value",
		"warm browser",
		"--run-id",
		"stolen-fill",
	])

	// Typing never navigates a page, so a page that moved is another document's.
	expectRefusal(filled, 21, {
		command: "fill",
		resultCode: "PAGE_IDENTITY_CHANGED",
		transactionState: "acted",
		message: "The Controlled Page moved to a document this action did not ask for.",
	})
	expect(readReceipt(probe).snapshot).toBeUndefined()
})

test("a submit control that navigates the page is still a click that worked", async () => {
	const { probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: [{
			backendNodeId: 61,
			role: "button",
			name: "Continue",
			nodeName: "BUTTON",
			attributes: { type: "submit" },
			box: [10, 10, 80, 24],
			navigatesTo: "https://fixture.test/submitted",
		}],
	})
	const snapshot = await takeSnapshot(probe, "submit-snapshot")

	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		snapshot.elements[0]!.ref,
		"--run-id",
		"submit-click",
	])

	expect(clicked.stderr).toBe("")
	expect(clicked.exitCode).toBe(0)
	expect(JSON.parse(clicked.stdout).data).toEqual({
		reference: `e1@${snapshot.generationId}`,
		controlledPage: { targetId: "page-1", url: "https://fixture.test/submitted" },
		invalidatedReferences: true,
		postcondition: "running",
	})
	expect(readReceipt(probe).snapshot).toBeUndefined()
})

test("independent evidence links the endpoint and its listener to the launched process", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	await takeSnapshot(probe, "chain-snapshot")

	// The whole chain, read without asking Warm Browser anything: the leader from
	// the raw launch record, the listener readings and loopback documents from the
	// raw effect log, and the targets from the endpoint itself.
	const evidence = await readBrowserSessionEvidenceIndependently(probe.fakeRoot, fixture.port)
	const status = await runProductionCliAsync(probe, ["status", "--run-id", "chain-status"])
	const data = JSON.parse(status.stdout).data as {
		processId: number
		endpoint: { host: string; port: number }
		controlledPage: { targetId: string }
	}

	// Independent oracle: the launch this harness performed, restated by hand.
	const { launchedProcessId } = evidence
	if (launchedProcessId === undefined) throw new Error("the harness recorded no launched leader")
	expect(launchedProcessId).toBe(4242)
	expect(evidence.launchedCommandLine).toContain(`--remote-debugging-port=${fixture.port}`)
	expect([...new Set(evidence.listenerPorts)]).toEqual([fixture.port])
	expect([...new Set(evidence.documentPaths)].toSorted()).toEqual(["/json/list", "/json/version"])
	expect(evidence.endpoint.pageTargets.map(({ id }) => id)).toEqual(["page-1"])
	expect(fixture.attachedTargets()).toEqual(["/devtools/page/page-1"])

	// Every link Warm Browser reported is the one the evidence shows.
	expect(data.processId).toBe(launchedProcessId)
	expect(evidence.listenerPorts[0]).toBe(fixture.port)
	expect(data.endpoint).toEqual({ host: "127.0.0.1", port: fixture.port })
	expect(data.controlledPage.targetId).toBe(evidence.endpoint.pageTargets[0]!.id)
})

test("independent evidence falsifies a listener owned by another process", async () => {
	const fixture = controlledPageFixture({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	// Independent oracle: a listener owner that is not the launched leader.
	const probe = productionCliProbe(pageProbePlan({ listenerOwner: 9_999 }))

	const started = await runProductionCliAsync(probe, [
		"start",
		"--port",
		String(fixture.port),
		"--run-id",
		"wrong-listener",
	])

	expectRefusal(started, 20, { command: "start", resultCode: "CDP_IDENTITY_UNVERIFIED" })
	const evidence = await readBrowserSessionEvidenceIndependently(probe.fakeRoot, fixture.port)
	// The endpoint is real and answers, and the launch really created 4242. What
	// does not hold is the link between them, and no Browser Session survives it.
	expect(evidence.endpoint.pageTargets.map(({ id }) => id)).toEqual(["page-1"])
	expect(evidence.launchedProcessId).toBe(4242)
	expect(existsSync(probe.sessionPath)).toBe(false)
	expect(existsSync(probe.lockPath)).toBe(false)
	expect(fixture.attachedTargets()).toEqual([])
})

test("independent evidence falsifies a Controlled Page the Browser Session never bound", async () => {
	const { fixture, probe } = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
	})
	fixture.replacePage("page-2")

	const evidence = await readBrowserSessionEvidenceIndependently(probe.fakeRoot, fixture.port)

	// The endpoint now exposes a page this session never bound, and the receipt
	// still names the one it did.
	expect(evidence.endpoint.pageTargets.map(({ id }) => id)).toEqual(["page-2"])
	expect(readReceipt(probe)).toMatchObject({ endpoint: { controlledPageTargetId: "page-1" } })
	const refused = await runProductionCliAsync(probe, ["snapshot", "--run-id", "falsified-page"])
	expectRefusal(refused, 20, { command: "snapshot", resultCode: "CONTROLLED_PAGE_REPLACED" })
	expect(fixture.attachedTargets()).toEqual([])
})
