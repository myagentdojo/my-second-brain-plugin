import { expect } from "bun:test"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"

import {
	type CdpPageFixture,
	type CdpPageFixtureOptions,
	type FixtureElement,
	startCdpPageFixture,
} from "./cdp-page-fixture"
import {
	packageRoot,
	type ProductionCliProbe,
	productionCliProbe,
	runProductionCliAsync,
	systemRows,
	verifiedReading,
} from "./production-cli-harness"

/**
 * The one owner of a Browser Session whose verified CDP endpoint is the
 * deterministic local Controlled Page fixture, so the public-process proofs and
 * the negative controls drive exactly the same scenario. Only the package root
 * differs: a negative control runs it against a mutated copy of the Module.
 */

/**
 * One sign-in page carrying a link, a login identifier field, a password field,
 * a submit button, one node that is neither focusable nor actionable, and one
 * field that carries no login signal at all. It is fixture input, not an
 * expected value: every expectation about it is restated by its test.
 */
export const signInPage: readonly FixtureElement[] = [
	{
		backendNodeId: 11,
		role: "link",
		name: "Docs",
		nodeName: "A",
		attributes: { href: "/docs" },
		box: [10, 20, 100, 30],
	},
	{
		backendNodeId: 12,
		role: "textbox",
		name: "Email",
		nodeName: "INPUT",
		attributes: { type: "email", name: "email" },
		box: [10, 60, 200, 24],
	},
	{
		backendNodeId: 13,
		role: "textbox",
		name: "Password",
		nodeName: "INPUT",
		attributes: { type: "password", name: "password" },
		box: [10, 100, 200, 24],
	},
	{
		backendNodeId: 14,
		role: "button",
		name: "Sign in",
		nodeName: "BUTTON",
		box: [10, 140, 90, 32],
	},
	{
		backendNodeId: 15,
		role: "paragraph",
		name: "Legal notice",
		nodeName: "P",
		focusable: false,
	},
	{
		backendNodeId: 16,
		role: "searchbox",
		name: "Search",
		nodeName: "INPUT",
		attributes: { type: "search", name: "q" },
		box: [10, 200, 200, 24],
	},
]

/**
 * The accepted Snapshot Reference lifetime, one minute, restated by hand and
 * owned by the tests.
 *
 * Every expiry input is built from this value and never from the bound
 * production works to. A production lifetime that moved would then disagree
 * with these proofs instead of moving them along with it, which is the whole
 * point of writing the accepted number down here.
 */
export const acceptedReferenceLifetimeMs = 60_000

export interface PageProbe {
	readonly fixture: CdpPageFixture
	readonly probe: ProductionCliProbe
	readonly root: string
}

const runningFixtures: CdpPageFixture[] = []

export function stopControlledPageFixtures(): void {
	for (const fixture of runningFixtures.splice(0)) fixture.stop()
}

/** One Controlled Page fixture, registered so the suite always stops it. */
export function controlledPageFixture(options: CdpPageFixtureOptions = {}): CdpPageFixture {
	const fixture = startCdpPageFixture(options)
	runningFixtures.push(fixture)
	return fixture
}

/**
 * The harness plan that binds a Browser Session to one fixture endpoint. The
 * process table, the launch, the loopback listener and the port probe are the
 * harness's private substitutes, because no browser is launched; every loopback
 * document and every CDP message is real.
 */
export function pageProbePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		processTable: verifiedReading(systemRows),
		spawnOutcome: "leader",
		spawnedPid: 4242,
		listenerOwner: "spawned",
		loopbackJsonPassthrough: true,
		...overrides,
	}
}

/** One started Browser Session bound to the fixture endpoint. */
export async function pageProbe(
	options: CdpPageFixtureOptions = {},
	root: string = packageRoot,
): Promise<PageProbe> {
	const fixture = controlledPageFixture(options)
	const probe = productionCliProbe(pageProbePlan())
	const started = await runProductionCliAsync(
		probe,
		["start", "--port", String(fixture.port), "--run-id", "page-start"],
		root,
	)
	expect(started.stderr).toBe("")
	expect(started.exitCode).toBe(0)
	return { fixture, probe, root }
}

export function readReceipt(probe: ProductionCliProbe): Record<string, unknown> {
	return JSON.parse(readFileSync(probe.sessionPath, "utf8"))
}

/** Rewrites the private receipt, restoring the exact private mode it requires. */
export function writeReceipt(probe: ProductionCliProbe, receipt: Record<string, unknown>): void {
	writeFileSync(probe.sessionPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
	chmodSync(probe.sessionPath, 0o600)
}

/**
 * Rewrites the private receipt so its Snapshot Generation was taken `ageMs`
 * ago. The age is always supplied by the caller from the test-owned lifetime,
 * so no expiry input is ever computed from the production bound.
 */
export function ageSnapshotGeneration(probe: ProductionCliProbe, ageMs: number): void {
	const receipt = readReceipt(probe)
	writeReceipt(probe, {
		...receipt,
		snapshot: {
			...(receipt.snapshot as Record<string, unknown>),
			takenAtEpochMs: Date.now() - ageMs,
		},
	})
}

export interface SnapshotResult {
	readonly generationId: string
	readonly elements: readonly { readonly ref: string }[]
	readonly data: Record<string, unknown>
}

export async function takeSnapshot(
	probe: ProductionCliProbe,
	runId: string,
	root: string = packageRoot,
): Promise<SnapshotResult> {
	const result = await runProductionCliAsync(probe, ["snapshot", "--run-id", runId], root)
	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	const data = JSON.parse(result.stdout).data as Record<string, unknown>
	return {
		generationId: data.generationId as string,
		elements: data.elements as readonly { readonly ref: string }[],
		data,
	}
}
