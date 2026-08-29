import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
	runSanitizedCredentialDetail,
	runSanitizedCredentialList,
} from "../src/modules/private-delivery/credential-effects"
import { privateDeliveryDetailSanitizerArgument } from "../src/modules/private-delivery/contract"
import {
	interpretSanitizedCredentialDetail,
	interpretSanitizedCredentialList,
} from "../src/modules/private-delivery/credential-match"

const roots: string[] = []
const entry = resolve(import.meta.dir, "../src/main.ts")
const sentinel = "sanitizer-sentinel-5f089f26-never-cross-parent-boundary"
const environmentCanary = "PRIVATE_DELIVERY_SANITIZER_TEST_CANARY"

async function withEnvironmentCanary<T>(effect: () => Promise<T>): Promise<T> {
	const prior = process.env[environmentCanary]
	process.env[environmentCanary] = sentinel
	try {
		return await effect()
	} finally {
		if (prior === undefined) delete process.env[environmentCanary]
		else process.env[environmentCanary] = prior
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface WrapperObservation {
	readonly argumentList: readonly string[]
	readonly canaryPresent: boolean
}

interface WrapperFixture {
	readonly path: string
	readonly observation: () => WrapperObservation
}

/** One executable wrapper that records its non-secret call and returns test-owned JSON. */
function detailWrapper(detail: unknown): WrapperFixture {
	const root = mkdtempSync(join(tmpdir(), "private-delivery-sanitizer-"))
	roots.push(root)
	const reply = join(root, "detail.json")
	writeFileSync(reply, JSON.stringify(detail), { mode: 0o600 })
	const observation = join(root, "observation.json")
	const wrapper = join(root, "credential-wrapper")
	writeFileSync(
		wrapper,
		`#!${process.execPath}\nimport { readFileSync, writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(observation)}, JSON.stringify({ argumentList: process.argv.slice(2), canaryPresent: Object.hasOwn(process.env, ${JSON.stringify(environmentCanary)}) }), { mode: 0o600 })\nprocess.stdout.write(readFileSync(${JSON.stringify(reply)}))\n`,
		{ mode: 0o700 },
	)
	chmodSync(wrapper, 0o700)
	return {
		path: wrapper,
		observation: () => JSON.parse(readFileSync(observation, "utf8")) as WrapperObservation,
	}
}

test("the disposable detail sanitizer emits only bounded non-secret metadata", async () => {
	const wrapper = detailWrapper({
		id: "item-2",
		title: "Synthetic Login",
		vault: { id: "vlt-1", name: "Agent Vault" },
		urls: [{ href: "https://fixture.test/sign-in" }],
		fields: [
			{ id: "username-field", purpose: "USERNAME", value: sentinel },
			{ id: "password-field", purpose: "PASSWORD", value: sentinel },
		],
		notesPlain: sentinel,
	})
	const input = {
		wrapper: wrapper.path,
		entry,
		itemId: "item-2",
		vault: "Agent Vault",
	}

	const result = await withEnvironmentCanary(() => runSanitizedCredentialDetail(input))

	expect(result.status).toBe(0)
	expect(result.signal).toBeNull()
	expect(result.failed).toBe(false)
	expect(JSON.parse(result.stdout!)).toEqual({
		schemaVersion: 1,
		status: "sanitized",
		detail: {
			id: "item-2",
			vault: { id: "vlt-1", name: "Agent Vault" },
			urls: [{ href: "https://fixture.test" }],
			fields: [
				{ id: "username-field", purpose: "USERNAME" },
				{ id: "password-field", purpose: "PASSWORD" },
			],
		},
	})
	expect(result.stdout).not.toContain(sentinel)
	expect(JSON.stringify(input)).not.toContain(sentinel)
	expect(wrapper.observation()).toEqual({
		argumentList: [
			"op",
			"item",
			"get",
			"item-2",
			"--vault",
			"Agent Vault",
			"--format",
			"json",
		],
		canaryPresent: false,
	})
})

test("the disposable list sanitizer drops username-bearing additional information", async () => {
	const wrapper = detailWrapper([
		{
			id: "item-2",
			title: sentinel,
			additional_information: sentinel,
			vault: { id: "vlt-1", name: "Agent Vault" },
			urls: [{ href: "https://fixture.test/sign-in" }],
			unknown: { value: sentinel },
		},
	])
	const input = {
		wrapper: wrapper.path,
		entry,
		vault: "Agent Vault",
	}

	const result = await withEnvironmentCanary(() => runSanitizedCredentialList(input))

	expect(result.status).toBe(0)
	expect(result.signal).toBeNull()
	expect(result.failed).toBe(false)
	expect(JSON.parse(result.stdout!)).toEqual({
		schemaVersion: 1,
		status: "sanitized",
		candidates: [
			{
				id: "item-2",
				vault: { id: "vlt-1", name: "Agent Vault" },
				urls: [{ href: "https://fixture.test" }],
			},
		],
	})
	expect(result.stdout).not.toContain(sentinel)
	expect(JSON.stringify(input)).not.toContain(sentinel)
	expect(wrapper.observation()).toEqual({
		argumentList: [
			"op",
			"item",
			"list",
			"--vault",
			"Agent Vault",
			"--categories",
			"Login",
			"--format",
			"json",
		],
		canaryPresent: false,
	})
})

test("a sanitizer refuses an uninterpretable wrapper reply without stdout", async () => {
	const wrapper = detailWrapper("not an item")

	const result = await runSanitizedCredentialDetail({
		wrapper: wrapper.path,
		entry,
		itemId: "item-2",
		vault: "Agent Vault",
	})

	expect(result.status).toBe(20)
	expect(result.signal).toBeNull()
	expect(result.stdout).toBe("")
})

test("the hidden sanitizer entry refuses a missing argument without stdout", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, entry, privateDeliveryDetailSanitizerArgument],
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(20)
	expect(result.stdout.toString()).toBe("")
})

test("the parent parser rejects a sanitizer reply carrying an extra value", () => {
	const reply = JSON.stringify({
		schemaVersion: 1,
		status: "sanitized",
		detail: {
			id: "item-2",
			vault: { id: "vlt-1", name: "Agent Vault" },
			urls: [{ href: "https://fixture.test" }],
			fields: [{ id: "password-field", purpose: "PASSWORD", value: sentinel }],
		},
	})

	expect(interpretSanitizedCredentialDetail(reply)).toBeUndefined()
})

test("the parent list parser rejects a candidate carrying additional information", () => {
	const reply = JSON.stringify({
		schemaVersion: 1,
		status: "sanitized",
		candidates: [
			{
				id: "item-2",
				vault: { id: "vlt-1", name: "Agent Vault" },
				urls: [{ href: "https://fixture.test" }],
				additional_information: sentinel,
			},
		],
	})

	expect(interpretSanitizedCredentialList(reply)).toBeUndefined()
})
