import { afterEach, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
	acceptedReferenceLifetimeMs,
	ageSnapshotGeneration,
	framedSignInPage,
	pageProbe,
	readReceipt,
	signInPage,
	stopControlledPageFixtures,
	takeSnapshot,
	writeReceipt,
} from "./fixtures/controlled-page-probe"
import {
	configureCredentialVault,
	loginItem,
	vaultActions,
	vaultReading,
	writeCredentialPlan,
} from "./fixtures/login-probe"
import {
	packageRoot,
	removeProductionCliProbes,
	runProductionCliAsync,
} from "./fixtures/production-cli-harness"

/**
 * Negative controls for the Snapshot Reference invalidation rules and the
 * Controlled Page rules.
 *
 * Each control runs one scenario twice: once against the Module as it is, and
 * once against a copy with exactly one guard removed. The first run records the
 * refusal the proof suite asserts, and the second run records what that proof
 * would see with the guard gone. Asserting that the two disagree is what shows
 * the guard is load-bearing: with the mutation in place the owning proof no
 * longer holds, so it would turn red.
 *
 * The mutation is applied to a temporary copy of the package. Nothing here
 * edits the Module, and every run is the real public process.
 */

const mutatedRoots: string[] = []

afterEach(() => {
	stopControlledPageFixtures()
	removeProductionCliProbes()
	for (const root of mutatedRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Mutation {
	readonly file: string
	readonly find: string
	readonly replace: string
}

/**
 * The comment one removed guard leaves behind, so the copy still parses. It is
 * written once and used by every control: the replacement is only there to keep
 * the file valid, and the oracle each control owns is the guard text it names.
 */
const removed = "// negative control: the guard under proof is gone"

/**
 * Copies the package and removes exactly one guard from it. The literal must
 * appear exactly once, so a guard that moved or was reworded fails this control
 * instead of quietly mutating nothing.
 */
function mutatedPackage(mutation: Mutation): string {
	const root = mkdtempSync(join(tmpdir(), "warm-browser-negative-control-"))
	mutatedRoots.push(root)
	cpSync(resolve(packageRoot, "src"), join(root, "src"), { recursive: true })
	cpSync(resolve(packageRoot, "tests/fixtures"), join(root, "tests/fixtures"), { recursive: true })
	const target = join(root, mutation.file)
	const source = readFileSync(target, "utf8")
	expect(source.split(mutation.find).length - 1, mutation.file).toBe(1)
	writeFileSync(target, source.replace(mutation.find, mutation.replace))
	return root
}

interface Reading {
	readonly resultCode: string
	readonly exitCode: number
}

function reading(result: { exitCode: number; stdout: string; stderr: string }): Reading {
	const line = result.stdout === "" ? result.stderr : result.stdout
	return { resultCode: JSON.parse(line).resultCode as string, exitCode: result.exitCode }
}

test("removing the generation binding lets a reference from an earlier generation act", async () => {
	const scenario = async (root: string): Promise<Reading> => {
		const { probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const first = await takeSnapshot(probe, "control-first", root)
		await takeSnapshot(probe, "control-second", root)
		return reading(
			await runProductionCliAsync(
				probe,
				["click", "--ref", first.elements[3]!.ref, "--run-id", "control-click"],
				root,
			),
		)
	}

	expect(await scenario(packageRoot)).toEqual({ resultCode: "SNAPSHOT_REFERENCE_STALE", exitCode: 21 })
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/snapshot.ts",
			find: '\tif (match[2] !== generation.generationId) return { kind: "stale" }',
			replace: removed,
		})),
	).toEqual({ resultCode: "ELEMENT_CLICKED", exitCode: 0 })
})

test("removing the reference lifetime lets an expired reference act", async () => {
	const scenario = async (root: string): Promise<Reading> => {
		const { probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-expiry", root)
		// The age is the one these tests accept, not the one the copy under
		// mutation works to: an input taken from the guard being removed would
		// move with it and could never expire.
		ageSnapshotGeneration(probe, acceptedReferenceLifetimeMs + 1_000)
		return reading(
			await runProductionCliAsync(
				probe,
				["click", "--ref", snapshot.elements[3]!.ref, "--run-id", "control-click"],
				root,
			),
		)
	}

	expect(await scenario(packageRoot)).toEqual({ resultCode: "SNAPSHOT_REFERENCE_STALE", exitCode: 21 })
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/snapshot.ts",
			find: '\tif (age < 0 || age > snapshotReferenceTimeoutMs) return { kind: "stale" }',
			replace: removed,
		})),
	).toEqual({ resultCode: "ELEMENT_CLICKED", exitCode: 0 })
})

test("removing the page binding changes which layer refuses a wrong-page reference", async () => {
	const scenario = async (root: string): Promise<Reading> => {
		const { fixture, probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-wrong-page", root)
		const receipt = readReceipt(probe)
		const generation = receipt.snapshot as Record<string, unknown>
		writeReceipt(probe, {
			...receipt,
			snapshot: {
				...generation,
				basis: { ...(generation.basis as Record<string, unknown>), targetId: "page-elsewhere" },
			},
		})
		const result = reading(
			await runProductionCliAsync(
				probe,
				["click", "--ref", snapshot.elements[3]!.ref, "--run-id", "control-click"],
				root,
			),
		)
		// Neither run ever reaches the page, whichever layer refused.
		expect(fixture.clicks(), root).toEqual([])
		return result
	}

	// A wrong-page reference is refused twice over: the reference does not belong
	// to this Controlled Page, and the page it does name is not the one the act
	// would land on. Removing the first refusal moves the answer to the second,
	// so the proof that names the reference-level refusal turns red while the act
	// still never happens.
	expect(await scenario(packageRoot)).toEqual({ resultCode: "SNAPSHOT_REFERENCE_STALE", exitCode: 21 })
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/snapshot.ts",
			find: '\tif (generation.basis.targetId !== input.controlledPageTargetId) return { kind: "stale" }',
			replace: removed,
		})),
	).toEqual({ resultCode: "PAGE_IDENTITY_CHANGED", exitCode: 21 })
})

test("removing the first identity proof describes an element to a page that has moved", async () => {
	const scenario = async (root: string): Promise<Reading & { described: boolean; clicks: number }> => {
		const { fixture, probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-race", root)
		fixture.navigate("https://fixture.test/elsewhere")
		const result = reading(
			await runProductionCliAsync(
				probe,
				["click", "--ref", snapshot.elements[3]!.ref, "--run-id", "control-click"],
				root,
			),
		)
		return {
			...result,
			described: fixture.cdpMethods().includes("DOM.describeNode"),
			clicks: fixture.clicks().length,
		}
	}

	// The page is proved twice, so removing the first proof does not let the click
	// through. What that proof owns is silence: with it gone, the command asks the
	// page it no longer owns about an element belonging to the page that is gone.
	expect(await scenario(packageRoot)).toEqual({
		resultCode: "PAGE_IDENTITY_CHANGED",
		exitCode: 21,
		described: false,
		clicks: 0,
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			find: '\t\t\tif (!sameBasis(before, input.basis)) return { kind: "identity_changed" }',
			replace: removed,
		})),
	).toEqual({
		resultCode: "PAGE_IDENTITY_CHANGED",
		exitCode: 21,
		described: true,
		clicks: 0,
	})
})

test("removing the proof before the dispatch lets a late navigation receive the input", async () => {
	const scenario = async (root: string): Promise<Reading & { clicks: number }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: signInPage,
				// The page moves after the element is described, which is exactly the
				// window the proof before the dispatch exists to close.
				navigateAfterMethod: { method: "DOM.describeNode", url: "https://fixture.test/late" },
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-late", root)
		const result = reading(
			await runProductionCliAsync(
				probe,
				["click", "--ref", snapshot.elements[3]!.ref, "--run-id", "control-click"],
				root,
			),
		)
		return { ...result, clicks: fixture.clicks().length }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "PAGE_IDENTITY_CHANGED",
		exitCode: 21,
		clicks: 0,
	})
	// With the proof gone, a real click lands on a document that arrived after
	// the reference was resolved and that the caller never named.
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			find: '\t\t\tif (!sameBasis(atDispatch, input.basis)) return { kind: "identity_changed" }',
			replace: removed,
		})),
	).toEqual({ resultCode: "ELEMENT_CLICKED", exitCode: 0, clicks: 1 })
})

test("removing the navigation binding reports a document the caller never asked for", async () => {
	const scenario = async (root: string): Promise<Reading & { landed: string }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: signInPage,
				navigateAfterMethod: { method: "Page.navigate", url: "https://fixture.test/competing" },
			},
			root,
		)
		const result = reading(
			await runProductionCliAsync(
				probe,
				["open", "--url", "https://fixture.test/next", "--run-id", "control-open"],
				root,
			),
		)
		return { ...result, landed: fixture.pageUrl() }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "PAGE_IDENTITY_CHANGED",
		exitCode: 21,
		landed: "https://fixture.test/competing",
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			find:
				"\t\t\treturn basis.frameId === frameId && basis.loaderId === loaderId\n\t\t\t\t? { kind: \"navigated\", basis }\n\t\t\t\t: { kind: \"superseded\" }",
			replace: '\t\t\treturn { kind: "navigated", basis }',
		})),
	).toEqual({
		resultCode: "PAGE_OPENED",
		exitCode: 0,
		landed: "https://fixture.test/competing",
	})
})

test("removing the post-dispatch binding reports a stolen document as a click that worked", async () => {
	const scenario = async (root: string): Promise<Reading & { landed: string }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: [{
					backendNodeId: 51,
					role: "button",
					name: "Toggle",
					nodeName: "BUTTON",
					attributes: { type: "button" },
					box: [10, 10, 80, 24],
				}],
				navigateAfterMethod: { method: "DOM.getContentQuads", url: "https://fixture.test/stolen" },
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-stolen", root)
		const result = reading(
			await runProductionCliAsync(
				probe,
				["click", "--ref", snapshot.elements[0]!.ref, "--run-id", "control-click"],
				root,
			),
		)
		return { ...result, landed: fixture.pageUrl() }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "PAGE_IDENTITY_CHANGED",
		exitCode: 21,
		landed: "https://fixture.test/stolen",
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			find:
				'\treturn input.action.kind === "click" && mayNavigate(input.description)\n\t\t? { kind: "acted", basis: input.after }\n\t\t: { kind: "superseded" }',
			replace: '\treturn { kind: "acted", basis: input.after }',
		})),
	).toEqual({ resultCode: "ELEMENT_CLICKED", exitCode: 0, landed: "https://fixture.test/stolen" })
})

test("removing the post-read re-proof issues references for a page that moved while read", async () => {
	const scenario = async (root: string): Promise<Reading> => {
		const { probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: signInPage,
				driftDuringSnapshot: true,
			},
			root,
		)
		return reading(
			await runProductionCliAsync(probe, ["snapshot", "--run-id", "control-drift"], root),
		)
	}

	expect(await scenario(packageRoot)).toEqual({ resultCode: "PAGE_IDENTITY_CHANGED", exitCode: 21 })
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			// Paired with the line only the snapshot reader has, because the capture reader proves its page identity the same way.
			find:
				'\t\t\tif (!sameBasis(before, after)) return { kind: "identity_changed" }\n\t\t\tconst { elements, truncated } = interpretElements(nodes, reading.descriptions)',
			replace:
				`${removed}\n\t\t\tconst { elements, truncated } = interpretElements(nodes, reading.descriptions)`,
		})),
	).toEqual({ resultCode: "SNAPSHOT_TAKEN", exitCode: 0 })
})

test("removing the replacement refusal binds a replacement Controlled Page silently", async () => {
	const scenario = async (root: string): Promise<Reading & { boundTargetId: unknown }> => {
		const { fixture, probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		await takeSnapshot(probe, "control-replacement", root)
		fixture.replacePage("page-2")
		const result = await runProductionCliAsync(probe, ["snapshot", "--run-id", "control-after"], root)
		return {
			...reading(result),
			boundTargetId: (readReceipt(probe).endpoint as Record<string, unknown>)
				.controlledPageTargetId,
		}
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "CONTROLLED_PAGE_REPLACED",
		exitCode: 20,
		boundTargetId: "page-1",
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/warm-browser.ts",
			find: '\t\tif (pageReplacement === "refuse") {',
			replace: "\t\tif (false) {",
		})),
	).toEqual({ resultCode: "SNAPSHOT_TAKEN", exitCode: 0, boundTargetId: "page-2" })
})

test("removing the recorded credential refusal opens a conversation about that field", async () => {
	const scenario = async (root: string): Promise<Reading & { attached: number }> => {
		const { fixture, probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-credential", root)
		const attachedBefore = fixture.attachedTargets().length
		const result = await runProductionCliAsync(
			probe,
			[
				"fill",
				"--ref",
				snapshot.elements[2]!.ref,
				"--value",
				"not-a-real-secret",
				"--run-id",
				"control-fill",
			],
			root,
		)
		return {
			...reading(result),
			attached: fixture.attachedTargets().length - attachedBefore,
		}
	}

	// The refusal survives either way, because the live check still holds. What
	// the removed guard costs is the promise that nothing is said to the page
	// about a field the snapshot already named a credential.
	expect(await scenario(packageRoot)).toEqual({
		resultCode: "CREDENTIAL_FIELD_REFUSED",
		exitCode: 21,
		attached: 0,
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/warm-browser.ts",
			find: '\tif (command === "fill" && resolution.element.credentialField) {',
			replace: "\tif (false) {",
		})),
	).toEqual({ resultCode: "CREDENTIAL_FIELD_REFUSED", exitCode: 21, attached: 1 })
})

test("removing the live credential refusal types into a field that became one", async () => {
	const scenario = async (root: string): Promise<Reading & { typed: readonly string[] }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: [{
					backendNodeId: 21,
					role: "textbox",
					name: "Code",
					nodeName: "INPUT",
					attributes: { type: "text", name: "code" },
					box: [10, 10, 100, 20],
					becomesAttributes: { type: "password" },
				}],
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-flip", root)
		const result = await runProductionCliAsync(
			probe,
			["fill", "--ref", snapshot.elements[0]!.ref, "--value", "123456", "--run-id", "control-fill"],
			root,
		)
		return { ...reading(result), typed: fixture.insertedText() }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "CREDENTIAL_FIELD_REFUSED",
		exitCode: 21,
		typed: [],
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			find: '\tif (isCredentialField(description, field.name)) return { kind: "credential_field" }',
			replace: removed,
		})),
	).toEqual({ resultCode: "FIELD_FILLED", exitCode: 0, typed: ["123456"] })
})

test("removing the open invalidation keeps references the navigation left behind", async () => {
	const scenario = async (root: string): Promise<Reading & { retained: boolean }> => {
		const { probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-open", root)
		await runProductionCliAsync(
			probe,
			["open", "--url", "https://fixture.test/next", "--run-id", "control-open-run"],
			root,
		)
		const retained = readReceipt(probe).snapshot !== undefined
		const result = await runProductionCliAsync(
			probe,
			["click", "--ref", snapshot.elements[3]!.ref, "--run-id", "control-click"],
			root,
		)
		return { ...reading(result), retained }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "SNAPSHOT_ABSENT",
		exitCode: 21,
		retained: false,
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/warm-browser.ts",
			find: '\tconst state = invalidateReferences("open", parsed.runId, paths, session.state, "acted")',
			replace: "\tconst state = session.state",
		})),
	).toEqual({ resultCode: "PAGE_IDENTITY_CHANGED", exitCode: 21, retained: true })
})

test("removing the post-action invalidation keeps references a navigation destroyed", async () => {
	const scenario = async (root: string): Promise<Reading & { retained: boolean }> => {
		const { probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: [...signInPage, {
					backendNodeId: 17,
					role: "link",
					name: "Leave",
					nodeName: "A",
					attributes: { href: "/left" },
					box: [10, 240, 60, 20],
					navigatesTo: "https://fixture.test/left",
				}],
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-navigating", root)
		const result = await runProductionCliAsync(
			probe,
			["click", "--ref", snapshot.elements[5]!.ref, "--run-id", "control-click"],
			root,
		)
		return { ...reading(result), retained: readReceipt(probe).snapshot !== undefined }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "ELEMENT_CLICKED",
		exitCode: 0,
		retained: false,
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/warm-browser.ts",
			find:
				'\tif (invalidatedReferences) invalidateReferences(command, parsed.runId, paths, state, "acted")',
			replace: removed,
		})),
	).toEqual({ resultCode: "ELEMENT_CLICKED", exitCode: 0, retained: true })
})

test("removing the login identifier signals lets a public fill of a username field proceed", async () => {
	const scenario = async (root: string): Promise<Reading & { typed: readonly string[] }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: [{
					backendNodeId: 41,
					role: "textbox",
					name: "Who are you",
					nodeName: "INPUT",
					attributes: { type: "text", name: "user_name" },
					box: [10, 10, 100, 20],
				}],
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-username", root)
		const result = await runProductionCliAsync(
			probe,
			[
				"fill",
				"--ref",
				snapshot.elements[0]!.ref,
				"--value",
				"someone",
				"--run-id",
				"control-fill",
			],
			root,
		)
		return { ...reading(result), typed: fixture.insertedText() }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "CREDENTIAL_FIELD_REFUSED",
		exitCode: 21,
		typed: [],
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/credential-fields.ts",
			find: '\t"username",\n\t"userid",\n\t"login",\n\t"email",\n] as const',
			replace: "] as const",
		})),
	).toEqual({ resultCode: "FIELD_FILLED", exitCode: 0, typed: ["someone"] })
})

test("removing the hit-target proof clicks whatever is covering the referenced element", async () => {
	const scenario = async (root: string): Promise<Reading & { clicks: number }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: [
					{
						backendNodeId: 99,
						role: "generic",
						name: "Overlay",
						nodeName: "DIV",
						box: [0, 0, 400, 400],
						focusable: false,
					},
					{
						backendNodeId: 71,
						role: "button",
						name: "Buried",
						nodeName: "BUTTON",
						box: [10, 10, 80, 24],
					},
				],
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-hit", root)
		const result = await runProductionCliAsync(
			probe,
			["click", "--ref", snapshot.elements[0]!.ref, "--run-id", "control-click"],
			root,
		)
		return { ...reading(result), clicks: fixture.clicks().length }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "ELEMENT_NOT_ACTIONABLE",
		exitCode: 21,
		clicks: 0,
	})
	// With the proof gone, a real click is dispatched at a point that belongs to
	// the overlay, and the caller is told the referenced element was clicked.
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			find:
				'\tif (!(await hitsReferencedNode(channel, point, backendNodeId))) {\n\t\treturn undeliverable("click_target_unproved")\n\t}',
			replace: removed,
		})),
	).toEqual({ resultCode: "ELEMENT_CLICKED", exitCode: 0, clicks: 1 })
})

test("removing the focus proof types the caller's value into the field focus moved to", async () => {
	const scenario = async (root: string): Promise<Reading & { password: string | undefined }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: [
					{
						backendNodeId: 13,
						role: "textbox",
						name: "Password",
						nodeName: "INPUT",
						attributes: { type: "password" },
						box: [10, 100, 200, 24],
					},
					{
						backendNodeId: 91,
						role: "searchbox",
						name: "Search",
						nodeName: "INPUT",
						attributes: { type: "search", name: "q" },
						box: [10, 10, 200, 24],
						focusMovesTo: 13,
					},
				],
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-focus", root)
		const result = await runProductionCliAsync(
			probe,
			[
				"fill",
				"--ref",
				snapshot.elements[1]!.ref,
				"--value",
				"warm browser",
				"--run-id",
				"control-fill",
			],
			root,
		)
		return { ...reading(result), password: fixture.fieldValue(13) }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "ELEMENT_NOT_ACTIONABLE",
		exitCode: 21,
		password: "",
	})
	// With the proof gone, the value the caller typed into an ordinary search box
	// ends up in the password field the page moved focus to.
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			find: '\tif (!focused.focused) return undeliverable("field_focus_moved")',
			replace: removed,
		})),
	).toEqual({ resultCode: "FIELD_FILLED", exitCode: 0, password: "warm browser" })
})

test("removing the accessible name lets a public fill of a label-only username field proceed", async () => {
	const scenario = async (root: string): Promise<Reading & { typed: readonly string[] }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				// Nothing but the label says what this field is for.
				elements: [{
					backendNodeId: 42,
					role: "textbox",
					name: "Username",
					nodeName: "INPUT",
					box: [10, 10, 100, 20],
				}],
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-label", root)
		const result = await runProductionCliAsync(
			probe,
			[
				"fill",
				"--ref",
				snapshot.elements[0]!.ref,
				"--value",
				"someone",
				"--run-id",
				"control-fill",
			],
			root,
		)
		return { ...reading(result), typed: fixture.insertedText() }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "CREDENTIAL_FIELD_REFUSED",
		exitCode: 21,
		typed: [],
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/credential-fields.ts",
			find: "\t\theard,\n",
			replace: "",
		})),
	).toEqual({ resultCode: "FIELD_FILLED", exitCode: 0, typed: ["someone"] })
})

test("classifying an undescribed field as ordinary lets a public fill of it proceed", async () => {
	const scenario = async (root: string): Promise<Reading & { typed: readonly string[] }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				// The document reading describes no such node, so nothing about it can
				// be ruled out.
				elements: [{
					backendNodeId: 95,
					role: "textbox",
					name: "Mystery",
					nodeName: "INPUT",
					box: [10, 10, 100, 20],
					undescribed: true,
				}],
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-undescribed", root)
		const result = await runProductionCliAsync(
			probe,
			[
				"fill",
				"--ref",
				snapshot.elements[0]!.ref,
				"--value",
				"someone",
				"--run-id",
				"control-fill",
			],
			root,
		)
		return { ...reading(result), typed: fixture.insertedText() }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "CREDENTIAL_FIELD_REFUSED",
		exitCode: 21,
		typed: [],
	})
	// This control turns the default the other way instead of deleting it, because
	// a classifier with no answer for an undescribed field cannot run at all.
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/credential-fields.ts",
			find: "\tif (description === undefined) return true",
			replace: "\tif (description === undefined) return false",
		})),
	).toEqual({ resultCode: "FIELD_FILLED", exitCode: 0, typed: ["someone"] })
})

test("reading the document without piercing refuses an ordinary field it cannot see", async () => {
	const scenario = async (root: string): Promise<Reading & { typed: readonly string[] }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: [{
					backendNodeId: 96,
					role: "searchbox",
					name: "Search",
					nodeName: "INPUT",
					attributes: { type: "search", name: "q" },
					box: [10, 10, 200, 24],
					inShadowRoot: true,
				}],
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-pierce", root)
		const result = await runProductionCliAsync(
			probe,
			[
				"fill",
				"--ref",
				snapshot.elements[0]!.ref,
				"--value",
				"warm browser",
				"--run-id",
				"control-fill",
			],
			root,
		)
		return { ...reading(result), typed: fixture.insertedText() }
	}

	// The piercing read is what makes the classification truthful in both
	// directions: with it, a shadow field is described and judged on what the page
	// says; without it, the same field is undescribed, and the fail-closed default
	// refuses an ordinary search box as though it were credential material.
	expect(await scenario(packageRoot)).toEqual({
		resultCode: "FIELD_FILLED",
		exitCode: 0,
		typed: ["warm browser"],
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			find: '\tconst document = await channel.call("DOM.getDocument", { depth: -1, pierce: true })',
			replace: '\tconst document = await channel.call("DOM.getDocument", { depth: -1, pierce: false })',
		})),
	).toEqual({ resultCode: "CREDENTIAL_FIELD_REFUSED", exitCode: 21, typed: [] })
})

/** What one refusal answered, and whether the session still holds a generation. */
interface RefusalWithState extends Reading {
	readonly retained: boolean
}

test.each([
	[
		"a detected page replacement",
		"src/modules/warm-browser/warm-browser.ts",
		'\t\t\tinvalidateReferences(command, runId, paths, state, "invalidated")',
		"CONTROLLED_PAGE_REPLACED",
		20,
	],
	[
		"a page that moved while it was read",
		"src/modules/warm-browser/warm-browser.ts",
		'\t\tinvalidateReferences("snapshot", parsed.runId, paths, state, "invalidated")',
		"PAGE_IDENTITY_CHANGED",
		21,
	],
	[
		"a page that moved before the act",
		"src/modules/warm-browser/warm-browser.ts",
		'\t\tinvalidateReferences(command, parsed.runId, paths, state, "invalidated")',
		"PAGE_IDENTITY_CHANGED",
		21,
	],
] as const)(
	"removing the invalidation for %s keeps references the page no longer has",
	async (name, file, find, resultCode, exitCode) => {
		const scenario = async (root: string): Promise<RefusalWithState> => {
			const { fixture, probe } = await pageProbe(
				{
					url: "https://fixture.test/sign-in",
					elements: signInPage,
					// The page moves the second time it is read, so the first snapshot
					// succeeds and whatever follows it races.
					...(name === "a page that moved while it was read"
						? {
							navigateAfterMethod: {
								method: "Accessibility.getFullAXTree",
								url: "https://fixture.test/moved",
								occurrence: 2,
							},
						}
						: {}),
				},
				root,
			)
			const snapshot = await takeSnapshot(probe, "control-invalidation", root)
			if (name === "a detected page replacement") fixture.replacePage("page-2")
			if (name === "a page that moved before the act") {
				fixture.navigate("https://fixture.test/elsewhere")
			}
			const argv = name === "a page that moved while it was read"
				? ["snapshot"]
				: ["click", "--ref", snapshot.elements[3]!.ref]
			const result = await runProductionCliAsync(
				probe,
				[...argv, "--run-id", "control-invalidation-run"],
				root,
			)
			return { ...reading(result), retained: readReceipt(probe).snapshot !== undefined }
		}

		// The refusal is the same either way. What the guard owns is the state it
		// leaves behind, so that is what these two rows disagree about.
		expect(await scenario(packageRoot)).toEqual({ resultCode, exitCode, retained: false })
		expect(await scenario(mutatedPackage({ file, find, replace: removed })))
			.toEqual({ resultCode, exitCode, retained: true })
	},
)

/** The post-capture identity guard keeps a moved page from becoming a Screenshot. */
test("removing the post-capture identity proof lets an image of a page that moved be kept", async () => {
	const scenario = async (root: string): Promise<Reading> => {
		const { probe } = await pageProbe(
			{
				url: "https://fixture.test/start",
				navigateAfterMethod: {
					method: "Page.captureScreenshot",
					url: "https://fixture.test/elsewhere",
				},
			},
			root,
		)
		return reading(
			await runProductionCliAsync(probe, ["screenshot", "--run-id", "control-capture"], root),
		)
	}

	expect(await scenario(packageRoot)).toEqual({ resultCode: "PAGE_IDENTITY_CHANGED", exitCode: 21 })
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/controlled-page.ts",
			find: "\t\t\tif (!sameBasis(before, after)) return { kind: \"identity_changed\" }\n\t\t\tif (data.length % 4 !== 0 || !strictBase64.test(data)) return { kind: \"unverified\" }",
			replace:
				removed + "\n\t\t\tif (data.length % 4 !== 0 || !strictBase64.test(data)) return { kind: \"unverified\" }",
		})),
	).toEqual({ resultCode: "SCREENSHOT_CAPTURED", exitCode: 0 })
})

/** The PNG completeness guard keeps a truncated stream from becoming a Screenshot. */
test("removing the completeness proof lets a truncated stream be kept as a Screenshot", async () => {
	const scenario = async (root: string): Promise<Reading> => {
		const { probe } = await pageProbe({ screenshotBytes: "truncated" }, root)
		return reading(
			await runProductionCliAsync(probe, ["screenshot", "--run-id", "control-capture"], root),
		)
	}

	expect(await scenario(packageRoot)).toEqual({ resultCode: "PAGE_CONTROL_UNVERIFIED", exitCode: 20 })
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/screenshot.ts",
			find: "\tif (!pngTrailer.every((expected, index) => bytes[trailerAt + index] === expected)) {\n\t\treturn undefined\n\t}",
			replace: removed,
		})),
	).toEqual({ resultCode: "SCREENSHOT_CAPTURED", exitCode: 0 })
})

/**
 * The secret the login controls deliver. It is owned by this file alone, so a
 * control that finds it on the page is reading its own delivery and never
 * another test's.
 */
const controlSentinel = "control-sentinel-1b9be2d4-never-in-any-public-surface"

/**
 * One planned Credential Vault whose single Login item declares the given
 * websites. Fixture input for the login controls, never an expected value.
 */
function controlVaultPlan(websites: readonly string[]): Record<string, unknown> {
	return {
		vaultList: vaultReading([{ id: "item-1" }]),
		vaultGet: {
			"item-1": vaultReading(loginItem({
				id: "item-1",
				vault: { id: "vlt-1", name: "Agent Vault" },
				websites,
				fields: [
					{ id: "username-field", purpose: "USERNAME" },
					{ id: "password-field", purpose: "PASSWORD" },
				],
			})),
		},
		sentinel: controlSentinel,
	}
}

test("removing the approval gate reaches the Credential Vault without a human", async () => {
	const scenario = async (root: string): Promise<Reading & { vaultReads: number }> => {
		const { probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-approval", root)
		configureCredentialVault(probe, "Agent Vault")
		writeCredentialPlan(probe, controlVaultPlan(["https://fixture.test"]))
		const result = reading(
			await runProductionCliAsync(
				probe,
				[
					"login",
					"--ref",
					snapshot.elements[2]!.ref,
					"--field",
					"password",
					"--run-id",
					"control-login",
				],
				root,
			),
		)
		return { ...result, vaultReads: vaultActions(probe).length }
	}

	// The gate owns the ordering, not just the refusal: with it, no approval
	// means zero vault readings; without it, the same unapproved login lists
	// the vault, reads the item, and delivers.
	expect(await scenario(packageRoot)).toEqual({
		resultCode: "APPROVAL_REQUIRED",
		exitCode: 21,
		vaultReads: 0,
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/private-delivery/private-delivery.ts",
			find: '\tif (!input.humanApproved) return { kind: "approval_required" }',
			replace: removed,
		})),
	).toEqual({ resultCode: "LOGIN_FIELD_DELIVERED", exitCode: 0, vaultReads: 2 })
})

test("removing the child's pre-fill revalidation lands the secret on a late document", async () => {
	const scenario = async (root: string): Promise<Reading & { typed: readonly string[] }> => {
		const { fixture, probe } = await pageProbe(
			{
				url: "https://fixture.test/sign-in",
				elements: signInPage,
				// The second node description of the scenario is the disposable
				// child's own, so the page moves after the child has read the field
				// and before it types: exactly the window the pre-fill revalidation
				// exists to close.
				navigateAfterMethod: {
					method: "DOM.describeNode",
					url: "https://fixture.test/late",
					occurrence: 2,
				},
			},
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-prefill", root)
		configureCredentialVault(probe, "Agent Vault")
		writeCredentialPlan(probe, controlVaultPlan(["https://fixture.test"]))
		const result = reading(
			await runProductionCliAsync(
				probe,
				[
					"login",
					"--ref",
					snapshot.elements[2]!.ref,
					"--field",
					"password",
					"--human-approved",
					"--run-id",
					"control-login",
				],
				root,
			),
		)
		return { ...result, typed: fixture.insertedText() }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "PAGE_IDENTITY_CHANGED",
		exitCode: 21,
		typed: [],
	})
	// With the revalidation gone, the secret really enters the document that
	// arrived after the match; the read-back after typing still refuses to call
	// it a delivery, but the page already holds the value.
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/private-delivery/child.ts",
			find: '\tif (secondAnswer !== "same") return say(secondAnswer)',
			replace: removed,
		})),
	).toEqual({
		resultCode: "PRIVATE_DELIVERY_UNVERIFIED",
		exitCode: 20,
		typed: [controlSentinel],
	})
})

test("a prefix origin comparison lets a near-miss origin match", async () => {
	const scenario = async (root: string): Promise<Reading & { typed: readonly string[] }> => {
		const { fixture, probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-origin", root)
		configureCredentialVault(probe, "Agent Vault")
		// The declared website is a superstring of the page's exact origin, which
		// is precisely what a prefix comparison cannot tell apart.
		writeCredentialPlan(probe, controlVaultPlan(["https://fixture.test.evil.example"]))
		const result = reading(
			await runProductionCliAsync(
				probe,
				[
					"login",
					"--ref",
					snapshot.elements[2]!.ref,
					"--field",
					"password",
					"--human-approved",
					"--run-id",
					"control-login",
				],
				root,
			),
		)
		return { ...result, typed: fixture.insertedText() }
	}

	expect(await scenario(packageRoot)).toEqual({
		resultCode: "CREDENTIAL_MATCH_ABSENT",
		exitCode: 21,
		typed: [],
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/private-delivery/credential-match.ts",
			find: "\treturn item.declaredOrigins.some((declared) => declared === origin)",
			replace: "\treturn item.declaredOrigins.some((declared) => declared.startsWith(origin))",
		})),
	).toEqual({ resultCode: "LOGIN_FIELD_DELIVERED", exitCode: 0, typed: [controlSentinel] })
})

test("removing the unique-match rule delivers when two items declare the origin", async () => {
	const scenario = async (root: string): Promise<Reading & { typed: readonly string[] }> => {
		const { fixture, probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-unique", root)
		configureCredentialVault(probe, "Agent Vault")
		writeCredentialPlan(probe, {
			vaultList: vaultReading([{ id: "item-1" }, { id: "item-2" }]),
			vaultGet: {
				"item-1": vaultReading(loginItem({
					id: "item-1",
					vault: { id: "vlt-1", name: "Agent Vault" },
					websites: ["https://fixture.test"],
					fields: [{ id: "password-field", purpose: "PASSWORD" }],
				})),
				"item-2": vaultReading(loginItem({
					id: "item-2",
					vault: { id: "vlt-1", name: "Agent Vault" },
					websites: ["https://fixture.test"],
					fields: [{ id: "password-field", purpose: "PASSWORD" }],
				})),
			},
			sentinel: controlSentinel,
		})
		const result = reading(
			await runProductionCliAsync(
				probe,
				[
					"login",
					"--ref",
					snapshot.elements[2]!.ref,
					"--field",
					"password",
					"--human-approved",
					"--run-id",
					"control-login",
				],
				root,
			),
		)
		return { ...result, typed: fixture.insertedText() }
	}

	// Two claimants is a question for the vault's owner. With the rule gone,
	// the Module silently picks a winner and delivers its secret.
	expect(await scenario(packageRoot)).toEqual({
		resultCode: "CREDENTIAL_MATCH_AMBIGUOUS",
		exitCode: 21,
		typed: [],
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/private-delivery/private-delivery.ts",
			find: '\tif (matches.length > 1) return { kind: "match_ambiguous" }',
			replace: removed,
		})),
	).toEqual({ resultCode: "LOGIN_FIELD_DELIVERED", exitCode: 0, typed: [controlSentinel] })
})

test("removing the frame guard delivers into a framed field", async () => {
	const scenario = async (root: string): Promise<Reading & { framedField: string | undefined }> => {
		const { fixture, probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: framedSignInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-frame", root)
		configureCredentialVault(probe, "Agent Vault")
		writeCredentialPlan(probe, controlVaultPlan(["https://fixture.test"]))
		const result = reading(
			await runProductionCliAsync(
				probe,
				[
					"login",
					"--ref",
					snapshot.elements[5]!.ref,
					"--field",
					"password",
					"--human-approved",
					"--run-id",
					"control-login",
				],
				root,
			),
		)
		return { ...result, framedField: fixture.fieldValue(18) }
	}

	// The child revalidates the top document only, so with the guard gone the
	// secret lands inside a document nobody proved anything about.
	expect(await scenario(packageRoot)).toEqual({
		resultCode: "LOGIN_FRAME_UNSUPPORTED",
		exitCode: 21,
		framedField: "",
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/warm-browser.ts",
			find: "\tif (reading.framed) {",
			replace: "\tif (false) {",
		})),
	).toEqual({ resultCode: "LOGIN_FIELD_DELIVERED", exitCode: 0, framedField: controlSentinel })
})

test("removing the post-delivery invalidation leaves the used reference alive", async () => {
	const scenario = async (root: string): Promise<Reading & { retained: boolean }> => {
		const { probe } = await pageProbe(
			{ url: "https://fixture.test/sign-in", elements: signInPage },
			root,
		)
		const snapshot = await takeSnapshot(probe, "control-invalidate", root)
		configureCredentialVault(probe, "Agent Vault")
		writeCredentialPlan(probe, controlVaultPlan(["https://fixture.test"]))
		const delivered = await runProductionCliAsync(
			probe,
			[
				"login",
				"--ref",
				snapshot.elements[2]!.ref,
				"--field",
				"password",
				"--human-approved",
				"--run-id",
				"control-login",
			],
			root,
		)
		expect(delivered.exitCode, root).toBe(0)
		const retained = readReceipt(probe).snapshot !== undefined
		const result = reading(
			await runProductionCliAsync(
				probe,
				["click", "--ref", snapshot.elements[2]!.ref, "--run-id", "control-after-click"],
				root,
			),
		)
		return { ...result, retained }
	}

	// The delivery makes the page a page nobody has re-read. With the durable
	// invalidation gone, the reference that just carried a secret survives it
	// and a following act goes straight through.
	expect(await scenario(packageRoot)).toEqual({
		resultCode: "SNAPSHOT_ABSENT",
		exitCode: 21,
		retained: false,
	})
	expect(
		await scenario(mutatedPackage({
			file: "src/modules/warm-browser/warm-browser.ts",
			find: '\tinvalidateReferences("login", parsed.runId, paths, state, "acted")',
			replace: removed,
		})),
	).toEqual({ resultCode: "ELEMENT_CLICKED", exitCode: 0, retained: true })
})
