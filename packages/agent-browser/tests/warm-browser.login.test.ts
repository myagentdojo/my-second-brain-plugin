import { afterEach, expect, test } from "bun:test"
import {
	chmodSync,
	cpSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CdpPageFixtureOptions } from "./fixtures/cdp-page-fixture"
import {
	framedSignInPage,
	type PageProbe,
	pageProbe,
	readReceipt,
	signInPage,
	type SnapshotResult,
	stopControlledPageFixtures,
	takeSnapshot,
} from "./fixtures/controlled-page-probe"
import {
	configureCredentialVault,
	credentialVaultPath,
	deliveryActions,
	filesUnderPrivateState,
	loginItem,
	vaultActions,
	vaultReading,
	writeCredentialPlan,
} from "./fixtures/login-probe"
import {
	expectError,
	expectRefusal,
	packageRoot,
	productionCliProbe,
	productionEntry,
	runProductionCliAsync,
	removeProductionCliProbes,
} from "./fixtures/production-cli-harness"

/**
 * The login proofs: one Credential Match delivered privately into one
 * referenced credential field of the Controlled Page, through the real public
 * process, with only the host-effects and credential-effects seams
 * substituted. No 1Password account, vault, token, or website is ever reached,
 * and no browser is ever launched: the page is the deterministic local
 * Controlled Page fixture, and the secret is the sentinel below.
 */

afterEach(() => {
	stopControlledPageFixtures()
	removeProductionCliProbes()
	for (const root of copiedPackageRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const copiedPackageRoots: string[] = []

/** One private package copy whose entry permissions a test may safely perturb. */
function copiedPackage(): string {
	const root = mkdtempSync(join(tmpdir(), "agent-browser-entry-custody-"))
	copiedPackageRoots.push(root)
	chmodSync(root, 0o700)
	mkdirSync(join(root, "tests"), { mode: 0o700 })
	cpSync(join(packageRoot, "src"), join(root, "src"), { recursive: true })
	cpSync(join(packageRoot, "tests/fixtures"), join(root, "tests/fixtures"), { recursive: true })
	return root
}

/**
 * The one secret these proofs deliver. It is owned by this file alone, and its
 * value could never be confused with page text, so finding it anywhere outside
 * the referenced field is always a leak and never a coincidence.
 */
const sentinel = "sentinel-c2a41e7f-never-in-any-public-surface"

/** The credential pair one healthy Login item carries. Fixture input only. */
const credentialPair = [
	{ id: "username-field", purpose: "USERNAME" },
	{ id: "password-field", purpose: "PASSWORD" },
]

/**
 * One planned Credential Vault holding one Login item that declares the given
 * websites. Fixture input, never an expected value: the reference and the
 * command the Module builds from it are restated by hand where they are
 * asserted.
 */
function oneItemPlan(websites: readonly string[]): Record<string, unknown> {
	return {
		vaultList: vaultReading([vaultListingItem("item-1", websites)]),
		vaultGet: vaultReading(vaultItem("item-1", websites)),
		sentinel,
	}
}

/** One Login-item list record, which carries no fields and no secret values. */
function vaultListingItem(id: string, websites: readonly string[]): Record<string, unknown> {
	return {
		id,
		vault: { id: "vlt-1", name: "Agent Vault" },
		urls: websites.map((href) => ({ href })),
	}
}

/** One Login item of the configured vault declaring the given websites. Fixture input only. */
function vaultItem(id: string, websites: readonly string[]): Record<string, unknown> {
	return loginItem({
		id,
		vault: { id: "vlt-1", name: "Agent Vault" },
		websites,
		fields: credentialPair,
	})
}

interface LoginProbe extends PageProbe {
	readonly snapshot: SnapshotResult
}

/** One started Browser Session on the sign-in page, already snapshotted. */
async function signInProbe(options: Partial<CdpPageFixtureOptions> = {}): Promise<LoginProbe> {
	const started = await pageProbe({
		url: "https://fixture.test/sign-in",
		elements: signInPage,
		...options,
	})
	const snapshot = await takeSnapshot(started.probe, "login-snapshot")
	return { ...started, snapshot }
}

test("help names login as one literal command entry and no other command", () => {
	// Independent oracle: the login entry and the whole command list, restated
	// by hand, never computed from the vocabulary that would agree with itself.
	const result = Bun.spawnSync({
		cmd: [process.execPath, productionEntry, "help", "--run-id", "login-help"],
		cwd: packageRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(0)
	const data = JSON.parse(result.stdout.toString()).data as {
		commands: Array<{ name: string; sideEffects: string; options: unknown }>
	}
	expect(data.commands.find(({ name }) => name === "login")).toEqual({
		name: "login",
		sideEffects:
			"delivers one Credential Match field into one referenced credential field of the Controlled Page and invalidates every earlier Snapshot Reference",
		options: [
			{ flag: "--ref", value: "REFERENCE", required: true },
			{ flag: "--field", value: "KIND", required: true },
			{ flag: "--human-approved", value: null, required: false },
		],
	})
	expect(data.commands.map(({ name }) => name)).toEqual([
		"help",
		"start",
		"status",
		"open",
		"snapshot",
		"screenshot",
		"click",
		"fill",
		"login",
		"stop",
	])
})

test("login without --field is one literal usage refusal naming the flag", async () => {
	const probe = productionCliProbe()

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		"e1@g",
		"--run-id",
		"login-usage",
	])

	expectError(result, 2, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "USAGE_ERROR",
		runId: "login-usage",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser help --run-id ID and correct the command arguments.",
		message: "The --field option is required by login.",
	})
})

test("a --field outside username and password is one literal usage refusal", async () => {
	const probe = productionCliProbe()

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		"e1@g",
		"--field",
		"admin",
		"--run-id",
		"login-kind",
	])

	expectError(result, 2, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "USAGE_ERROR",
		runId: "login-kind",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser help --run-id ID and correct the command arguments.",
		message: "The --field value must be username or password.",
	})
})

test("a selector handed to login is refused by name", async () => {
	const probe = productionCliProbe()

	const result = await runProductionCliAsync(probe, [
		"login",
		"--selector",
		"#password",
		"--run-id",
		"login-selector",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "SELECTOR_UNSUPPORTED",
		runId: "login-selector",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID and act through the references it issues.",
		message: "Warm Browser acts through Snapshot References, not the --selector selector.",
	})
})

test("login without a Browser Session is refused before any credential effect", async () => {
	const probe = productionCliProbe()

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		"e1@g",
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-absent",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "SESSION_ABSENT",
		runId: "login-absent",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser start --run-id ID to create a Browser Session.",
		message: "No verified Browser Session owns a Controlled Page.",
	})
	expect(vaultActions(probe)).toEqual([])
	expect(deliveryActions(probe)).toEqual([])
})

test("approval provably precedes credential access", async () => {
	const { probe, snapshot } = await signInProbe()
	// A configured vault and a matching item are available on purpose: if the
	// approval gate were anywhere but first, this scenario would have read them.
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--run-id",
		"login-approval",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "APPROVAL_REQUIRED",
		runId: "login-approval",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction:
			"Obtain explicit human approval, then run warm-browser login --ref REFERENCE --field KIND --human-approved --run-id ID.",
		message: "Credential access needs a human approval given immediately before it.",
	})
	// The ordering proof: zero vault readings and zero deliveries were recorded,
	// so nothing was read from the vault and approval provably came first.
	expect(vaultActions(probe)).toEqual([])
	expect(deliveryActions(probe)).toEqual([])
})

test.each([
	["password", "Email", 1],
	["username", "Password", 2],
	["username", "Search", 4],
] as const)(
	"asking %s of the %s field is a mismatch decided before any vault access",
	async (field, _label, elementIndex) => {
		const { probe, snapshot } = await signInProbe()
		// The vault is configured and would match, so a mismatch that slipped past
		// the field gate would show up below as a recorded vault reading.
		configureCredentialVault(probe, "Agent Vault")
		writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

		const result = await runProductionCliAsync(probe, [
			"login",
			"--ref",
			snapshot.elements[elementIndex]!.ref,
			"--field",
			field,
			"--human-approved",
			"--run-id",
			"login-mismatch",
		])

		expectError(result, 21, {
			schemaVersion: 1,
			status: "error",
			command: "login",
			resultCode: "LOGIN_FIELD_MISMATCH",
			runId: "login-mismatch",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction:
				"Run warm-browser snapshot --run-id ID and select the credential field of the requested kind.",
			message: "The referenced live field is not a credential field of the requested kind.",
		})
		expect(vaultActions(probe)).toEqual([])
	},
)

test.each([
	["passwordHint", "password", "Hint"],
	["notpassword", "password", "Account note"],
	["emailPreferences", "username", "Preferences"],
] as const)(
	"the deceptive identifier %s does not classify its field as %s",
	async (identifier, field, accessibleName) => {
		const { probe, snapshot } = await signInProbe({
			elements: [
				{
					backendNodeId: 21,
					role: "textbox",
					name: accessibleName,
					nodeName: "INPUT",
					attributes: { type: "text", name: identifier },
					box: [10, 20, 200, 24],
				},
			],
		})
		configureCredentialVault(probe, "Agent Vault")
		writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

		const result = await runProductionCliAsync(probe, [
			"login",
			"--ref",
			snapshot.elements[0]!.ref,
			"--field",
			field,
			"--human-approved",
			"--run-id",
			"login-deceptive-identifier",
		])

		expectError(result, 21, {
			schemaVersion: 1,
			status: "error",
			command: "login",
			resultCode: "LOGIN_FIELD_MISMATCH",
			runId: "login-deceptive-identifier",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction:
				"Run warm-browser snapshot --run-id ID and select the credential field of the requested kind.",
			message: "The referenced live field is not a credential field of the requested kind.",
		})
		expect(vaultActions(probe)).toEqual([])
		expect(deliveryActions(probe)).toEqual([])
	},
)

test("a credential field inside a frame is refused before any vault access", async () => {
	const { probe, snapshot } = await signInProbe({ elements: framedSignInPage })
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	// The framed password field is referenced like any other: the full
	// accessibility tree reports it, so the snapshot names it as its sixth
	// element. Only the document read places it inside the frame.
	expect(snapshot.elements).toHaveLength(6)

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[5]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-framed",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "LOGIN_FRAME_UNSUPPORTED",
		runId: "login-framed",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction:
			"Run warm-browser open --url URL --run-id ID with the login page whose own document carries the field.",
		message:
			"The referenced credential field sits inside a frame, and login delivers into the top document only.",
	})
	expect(vaultActions(probe)).toEqual([])
})

test.each([
	["about:blank", "login-no-origin"],
	["http://fixture.test/sign-in", "login-insecure-origin"],
	["http://localhost:9311/login", "login-localhost-alias"],
	["http://127.1:9311/login", "login-numeric-loopback-alias"],
] as const)("a page at %s is refused before the vault is spoken to", async (url, runId) => {
	// Independent oracle: neither a non-origin page nor remote HTTP is eligible
	// for Private Delivery. The literal table does not reuse the production
	// predicate that enforces that boundary.
	const { probe, snapshot } = await signInProbe({ url })
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		runId,
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "ORIGIN_UNSUPPORTED",
		runId,
		transactionState: "unchanged",
		retrySafe: false,
		nextAction:
			"Run warm-browser open --url URL --run-id ID with an HTTPS address, or 127.0.0.1 or [::1] HTTP for local testing, then retry login.",
		message: "The Controlled Page must use HTTPS, except for literal 127.0.0.1 or [::1] HTTP.",
	})
	expect(vaultActions(probe)).toEqual([])
	expect(deliveryActions(probe)).toEqual([])
})

test.each([
	["http://127.0.0.1:9311", "login-ipv4-loopback-origin"],
	["http://[::1]:9311", "login-ipv6-loopback-origin"],
] as const)("a literal loopback HTTP origin at %s remains eligible for local login", async (origin, runId) => {
	const { fixture, probe, snapshot } = await signInProbe({ url: `${origin}/login` })
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan([origin]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		runId,
	])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout).resultCode).toBe("LOGIN_FIELD_DELIVERED")
	expect(vaultActions(probe)).toHaveLength(2)
	expect(fixture.insertedText()).toEqual([sentinel])
})

test("a reference from an earlier generation or from no generation is refused", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	await takeSnapshot(probe, "login-second-generation")

	const stale = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-stale",
	])

	expectError(stale, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "SNAPSHOT_REFERENCE_STALE",
		runId: "login-stale",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message:
			"The Snapshot Reference belongs to another Snapshot Generation, another Controlled Page, or a generation that has expired.",
	})
	expect(vaultActions(probe)).toEqual([])

	// A session that never took a snapshot holds nothing a reference could name.
	const bare = await pageProbe({ url: "https://fixture.test/sign-in", elements: signInPage })
	const absent = await runProductionCliAsync(bare.probe, [
		"login",
		"--ref",
		"e1@g",
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-no-generation",
	])

	expectError(absent, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "SNAPSHOT_ABSENT",
		runId: "login-no-generation",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID before acting on the Controlled Page.",
		message: "This Browser Session holds no Snapshot Generation.",
	})
})

test("a field that already holds a value is refused by name before any vault access", async () => {
	const prefilled = signInPage.map((element) =>
		element.backendNodeId === 13 ? { ...element, value: "already-filled" } : element
	)
	const { probe, snapshot } = await signInProbe({ elements: prefilled })
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-not-empty",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "ELEMENT_NOT_ACTIONABLE",
		runId: "login-not-empty",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message: "Warm Browser fills an empty field, and the referenced one already holds a value.",
	})
	expect(vaultActions(probe)).toEqual([])
})

test("no configured Credential Vault refuses before any vault access", async () => {
	const { probe, snapshot } = await signInProbe()
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-unconfigured",
	])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_VAULT_UNCONFIGURED",
		runId: "login-unconfigured",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction:
			"Configure the one Credential Vault in the private credential-vault.json state file, then retry.",
		message: "No Credential Vault is configured for Private Delivery.",
	})
	expect(vaultActions(probe)).toEqual([])
})

test("a Credential Vault configuration file at 0644 is unsafe, never repaired", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	// A file another reader could open is not a file this Module acts on.
	chmodSync(credentialVaultPath(probe), 0o644)

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-unsafe",
	])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "STATE_UNSAFE",
		runId: "login-unsafe",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Repair the private credential-vault.json ownership and permissions before retrying.",
		message: "The configured Credential Vault file could not be proved safe.",
	})
	expect(vaultActions(probe)).toEqual([])
})

test("a missing wrapper refuses by name with the vault never spoken to", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	// The probe owns its home, so the one wrapper path production resolves is
	// the probe-local file the harness created, and removing it proves which
	// file the refusal is about without the real dotfiles wrapper existing here.
	rmSync(join(probe.home, "code/dotfiles/bin/with-one-password-token"))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-no-wrapper",
	])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_WRAPPER_UNAVAILABLE",
		runId: "login-no-wrapper",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Restore the with-one-password-token wrapper before retrying.",
		message: "The one credential wrapper Private Delivery invokes is unavailable.",
	})
	expect(vaultActions(probe)).toEqual([])
	expect(deliveryActions(probe)).toEqual([])
})

test.each([
	["group-writable wrapper", "wrapper", 0o720, "login-group-writable-wrapper"],
	["world-writable wrapper", "wrapper", 0o702, "login-world-writable-wrapper"],
	["replaceable wrapper parent", "parent", 0o777, "login-replaceable-wrapper-parent"],
] as const)("a %s is refused before vault access", async (_name, target, mode, runId) => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	chmodSync(
		target === "wrapper"
			? join(probe.home, "code/dotfiles/bin/with-one-password-token")
			: join(probe.home, "code/dotfiles/bin"),
		mode,
	)

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		runId,
	])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_WRAPPER_UNAVAILABLE",
		runId,
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Restore the with-one-password-token wrapper before retrying.",
		message: "The one credential wrapper Private Delivery invokes is unavailable.",
	})
	expect(vaultActions(probe)).toEqual([])
	expect(deliveryActions(probe)).toEqual([])
})

test("a sticky writable wrapper directory preserves another user's exclusion", async () => {
	const { fixture, probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	chmodSync(join(probe.home, "code/dotfiles/bin"), 0o1777)

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-sticky-wrapper-parent",
	])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout).resultCode).toBe("LOGIN_FIELD_DELIVERED")
	expect(vaultActions(probe)).toHaveLength(2)
	expect(fixture.insertedText()).toEqual([sentinel])
})

test.each([
	["entry", 0o664, "login-group-writable-entry"],
	["parent", 0o777, "login-replaceable-entry-parent"],
] as const)("a writable shipped %s is refused before vault access", async (target, mode, runId) => {
	const root = copiedPackage()
	chmodSync(target === "entry" ? join(root, "src/main.ts") : join(root, "src"), mode)
	const { probe } = await pageProbe(
		{ url: "https://fixture.test/sign-in", elements: signInPage },
		root,
	)
	const snapshot = await takeSnapshot(probe, `${runId}-snapshot`, root)
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(
		probe,
		[
			"login",
			"--ref",
			snapshot.elements[2]!.ref,
			"--field",
			"password",
			"--human-approved",
			"--run-id",
			runId,
		],
		root,
	)

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "PRIVATE_DELIVERY_UNVERIFIED",
		runId,
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the credential wrapper and the Controlled Page before retrying.",
		message: "The disposable child did not prove what it did with the delivery.",
	})
	expect(vaultActions(probe)).toEqual([])
	expect(deliveryActions(probe)).toEqual([])
})

test("a resolved item outside the configured vault refuses the whole login", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, {
		vaultList: vaultReading([{
			id: "item-9",
			vault: { id: "other-vault", name: "Other Vault" },
			urls: [{ href: "https://fixture.test" }],
		}]),
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-vault-mismatch",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_VAULT_MISMATCH",
		runId: "login-vault-mismatch",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the configured Credential Vault before retrying.",
		message: "A resolved Login item does not belong to the configured Credential Vault.",
	})
	expect(vaultActions(probe)).toHaveLength(1)
	expect(deliveryActions(probe)).toEqual([])
})

test("zero items declaring the exact origin is a refusal with nothing delivered", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://other.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-no-match",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_MATCH_ABSENT",
		runId: "login-no-match",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Add exactly one Login item whose website is this exact origin, then retry.",
		message: "No Login item in the Credential Vault declares this exact origin.",
	})
	// The no-match listing decides before any candidate id can reach argv.
	expect(vaultActions(probe)).toHaveLength(1)
	expect(deliveryActions(probe)).toEqual([])
})

test("a listing naming no Login item is no match, with the vault asked for nothing more", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	// No batch reading is planned on purpose: a Module that asked for one
	// would be answered with nothing and could not report the match absent.
	writeCredentialPlan(probe, { vaultList: vaultReading([]), sentinel })

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-empty-listing",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_MATCH_ABSENT",
		runId: "login-empty-listing",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Add exactly one Login item whose website is this exact origin, then retry.",
		message: "No Login item in the Credential Vault declares this exact origin.",
	})
	// Independent oracle: the one listing was the whole vault conversation.
	expect(vaultActions(probe).map((entry) => entry.argumentList)).toEqual([
		["op", "item", "list", "--vault", "Agent Vault", "--categories", "Login", "--format", "json"],
	])
	expect(deliveryActions(probe)).toEqual([])
})

test("two items declaring the exact origin never picks a winner", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, {
		vaultList: vaultReading([
			vaultListingItem("item-1", ["https://fixture.test"]),
			vaultListingItem("item-2", ["https://fixture.test"]),
		]),
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-ambiguous",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_MATCH_AMBIGUOUS",
		runId: "login-ambiguous",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Leave exactly one Login item declaring this exact origin, then retry.",
		message: "More than one Login item in the Credential Vault declares this exact origin.",
	})
	// The ambiguous listing decides before any candidate id can reach argv.
	expect(vaultActions(probe)).toHaveLength(1)
	expect(deliveryActions(probe)).toEqual([])
})

test("lists metadata before reading only the unique exact-origin item", async () => {
	const { fixture, probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	// Three candidates in the configured vault: another host, the exact origin,
	// a sub-domain of it, and one unrelated Login item with no website. Only the
	// second is a Credential Match; the measured op list schema omits `urls`
	// entirely for the unrelated no-website Login item.
	writeCredentialPlan(probe, {
		vaultList: vaultReading([
			vaultListingItem("item-1", ["https://other.test"]),
			vaultListingItem("item-2", ["https://fixture.test"]),
			vaultListingItem("item-3", ["https://www.fixture.test"]),
			{ id: "item-4", vault: { id: "vlt-1", name: "Agent Vault" } },
		]),
		vaultGet: vaultReading(vaultItem("item-2", ["https://fixture.test"])),
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-two-stage",
	])

	// Independent oracle: the whole vault conversation, restated by hand. One
	// listing, then one detail read naming only the already-proved unique
	// candidate by id. No candidate data enters standard input, and the number
	// of wrapper calls stays constant as the listing grows.
	const wrapper = join(probe.home, "code/dotfiles/bin/with-one-password-token")
	expect(vaultActions(probe)).toEqual([
		{
			action: "vault",
			wrapper,
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
		},
		{
			action: "vault",
			wrapper,
			argumentList: ["op", "item", "get", "item-2", "--vault", "Agent Vault", "--format", "json"],
		},
	])
	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout).resultCode).toBe("LOGIN_FIELD_DELIVERED")
	// The one exact-origin item is the one delivered, named by id.
	expect(deliveryActions(probe).map((delivery) => delivery.reference)).toEqual([
		"op://vlt-1/item-2/password-field",
	])
	// The sentinel reached exactly the referenced field and no other node.
	expect(fixture.fieldValue(13)).toBe(sentinel)
	expect(fixture.insertedText()).toEqual([sentinel])
	for (const node of [11, 12, 14, 15, 16] as const) {
		expect(fixture.fieldValue(node), String(node)).toBe("")
	}
	// Neither the secret nor the matched item's identity reaches the public
	// stream or any byte of durable private state.
	const files = filesUnderPrivateState(probe)
	expect(files.length).toBeGreaterThan(0)
	for (const text of [result.stdout, ...files.map((file) => file.bytes)]) {
		expect(text).not.toContain(sentinel)
		expect(text).not.toContain("item-2")
	}
})

test("a detail reply containing more than the selected item proves nothing about the vault", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	const selected = vaultItem("item-2", ["https://fixture.test"])
	writeCredentialPlan(probe, {
		vaultList: vaultReading([vaultListingItem("item-2", ["https://fixture.test"])]),
		vaultGet: {
			status: 0,
			signal: null,
			failed: false,
			stdout: `${JSON.stringify(selected)}\n${JSON.stringify(selected)}`,
		},
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-detail-many",
	])

	expectRefusal(result, 20, {
		resultCode: "CREDENTIAL_VAULT_UNVERIFIED",
		runId: "login-detail-many",
		transactionState: "unchanged",
	})
	expect(deliveryActions(probe)).toEqual([])
})

test.each([
	["another item id", vaultItem("item-3", ["https://fixture.test"])],
	["an incomplete item record", { id: "item-2", vault: {} }],
] as const)("a detail reply for %s proves nothing about the vault", async (_name, vaultGet) => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, {
		vaultList: vaultReading([vaultListingItem("item-2", ["https://fixture.test"])]),
		vaultGet: vaultReading(vaultGet),
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-detail-incomplete",
	])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_VAULT_UNVERIFIED",
		runId: "login-detail-incomplete",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the credential wrapper and the configured Credential Vault before retrying.",
		message: "The Credential Vault reply could not be read, interpreted, or safely used.",
	})
	expect(deliveryActions(probe)).toEqual([])
})

test("a detail reply naming another vault is refused after the listing agreed", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	// The listing puts this candidate in the configured vault and the detail
	// reply then puts it somewhere else. The listing is not taken on trust for
	// the item whose secret is about to be named.
	writeCredentialPlan(probe, {
		vaultList: vaultReading([vaultListingItem("item-2", ["https://fixture.test"])]),
		vaultGet: vaultReading(loginItem({
			id: "item-2",
			vault: { id: "vlt-9", name: "Another Vault" },
			websites: ["https://fixture.test"],
			fields: credentialPair,
		})),
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-detail-other-vault",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_VAULT_MISMATCH",
		runId: "login-detail-other-vault",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the configured Credential Vault before retrying.",
		message: "A resolved Login item does not belong to the configured Credential Vault.",
	})
	expect(deliveryActions(probe)).toEqual([])
})

test("a detail reply that drops the matched origin is refused", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	// The listing declares the current origin and the detail reply declares a
	// different one. The origin the whole match rests on is asked again of the
	// reply that names the field, so a listing that disagrees with it delivers
	// nothing.
	writeCredentialPlan(probe, {
		vaultList: vaultReading([vaultListingItem("item-2", ["https://fixture.test"])]),
		vaultGet: vaultReading(loginItem({
			id: "item-2",
			vault: { id: "vlt-1", name: "Agent Vault" },
			websites: ["https://elsewhere.test"],
			fields: credentialPair,
		})),
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-detail-other-origin",
	])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_VAULT_UNVERIFIED",
		runId: "login-detail-other-origin",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the credential wrapper and the configured Credential Vault before retrying.",
		message: "The Credential Vault reply could not be read, interpreted, or safely used.",
	})
	expect(deliveryActions(probe)).toEqual([])
})

test.each([
	[
		"a candidate missing its vault",
		[{ id: "item-2", urls: [{ href: "https://fixture.test" }] }],
	],
	[
		"a candidate with non-array URLs",
		[{ id: "item-2", vault: { id: "vlt-1", name: "Agent Vault" }, urls: {} }],
	],
	[
		"a repeated candidate id",
		[
			vaultListingItem("item-2", ["https://other.test"]),
			vaultListingItem("item-2", ["https://fixture.test"]),
		],
	],
] as const)("a listing with %s proves nothing about the vault", async (_name, listing) => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, {
		vaultList: vaultReading(listing),
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-list-malformed",
	])

	expectRefusal(result, 20, {
		resultCode: "CREDENTIAL_VAULT_UNVERIFIED",
		runId: "login-list-malformed",
		transactionState: "unchanged",
	})
	expect(deliveryActions(probe)).toEqual([])
	expect(vaultActions(probe)).toHaveLength(1)
})

// Independent oracle: what exact-origin equality decides for a page at
// https://fixture.test/sign-in, every expected result stated literally. A
// scheme, a port, a sub-domain, a superstring host, another host, and a value
// that is not a URL all miss; a path under the exact origin is that origin.
test.each([
	["http://fixture.test", "CREDENTIAL_MATCH_ABSENT", 21],
	["https://fixture.test:8443", "CREDENTIAL_MATCH_ABSENT", 21],
	["https://www.fixture.test", "CREDENTIAL_MATCH_ABSENT", 21],
	["https://fixture.test.evil.example", "CREDENTIAL_MATCH_ABSENT", 21],
	["https://other.test", "CREDENTIAL_MATCH_ABSENT", 21],
	["not a url at all", "CREDENTIAL_MATCH_ABSENT", 21],
	["https://fixture.test/some/path", "LOGIN_FIELD_DELIVERED", 0],
] as const)(
	"an item declaring %s answers %s against https://fixture.test/sign-in",
	async (declared, resultCode, exitCode) => {
		const { probe, snapshot } = await signInProbe()
		configureCredentialVault(probe, "Agent Vault")
		writeCredentialPlan(probe, oneItemPlan([declared]))

		const result = await runProductionCliAsync(probe, [
			"login",
			"--ref",
			snapshot.elements[2]!.ref,
			"--field",
			"password",
			"--human-approved",
			"--run-id",
			"login-origin-table",
		])

		expect(result.exitCode).toBe(exitCode)
		const line = exitCode === 0 ? result.stdout : result.stderr
		expect(JSON.parse(line).resultCode).toBe(resultCode)
	},
)

test("a matched item carrying two password fields is ambiguous, not guessed at", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, {
		vaultList: vaultReading([vaultListingItem("item-1", ["https://fixture.test"])]),
		vaultGet: vaultReading(
			loginItem({
				id: "item-1",
				vault: { id: "vlt-1", name: "Agent Vault" },
				websites: ["https://fixture.test"],
				fields: [
					{ id: "password-a", purpose: "PASSWORD" },
					{ id: "password-b", purpose: "PASSWORD" },
				],
			}),
		),
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-field-ambiguous",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_FIELD_AMBIGUOUS",
		runId: "login-field-ambiguous",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction:
			"Repair the matched Login item to carry exactly one field of the requested kind, then retry.",
		message: "The matched Login item does not carry exactly one field of the requested kind.",
	})
	expect(deliveryActions(probe)).toEqual([])
})

test.each([
	["a non-zero status", { status: 1, signal: null, failed: false, stdout: "" }],
	["stdout that is not JSON", { status: 0, signal: null, failed: false, stdout: "not json" }],
] as const)(
	"an op item list reply with %s proves nothing about the vault",
	async (_name, vaultList) => {
		const { probe, snapshot } = await signInProbe()
		configureCredentialVault(probe, "Agent Vault")
		writeCredentialPlan(probe, { vaultList, sentinel })

		const result = await runProductionCliAsync(probe, [
			"login",
			"--ref",
			snapshot.elements[2]!.ref,
			"--field",
			"password",
			"--human-approved",
			"--run-id",
			"login-unverified-list",
		])

		expectError(result, 20, {
			schemaVersion: 1,
			status: "error",
			command: "login",
			resultCode: "CREDENTIAL_VAULT_UNVERIFIED",
			runId: "login-unverified-list",
			transactionState: "unchanged",
			retrySafe: false,
			nextAction: "Inspect the credential wrapper and the configured Credential Vault before retrying.",
			message: "The Credential Vault reply could not be read, interpreted, or safely used.",
		})
		expect(deliveryActions(probe)).toEqual([])
	},
)

test.each([
	["a field id carrying a segment separator", "password/field"],
	["a field id carrying the attribute selector", "password?attribute=otp"],
	["a field id carrying a per-cent sign", "password%2Ffield"],
])("%s is refused rather than escaped into a reference", async (_name, fieldId) => {
	const { fixture, probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, {
		vaultList: vaultReading([vaultListingItem("item-1", ["https://fixture.test"])]),
		vaultGet: vaultReading(loginItem({
			id: "item-1",
			vault: { id: "vlt-1", name: "Agent Vault" },
			websites: ["https://fixture.test"],
			fields: [{ id: fieldId, purpose: "PASSWORD" }],
		})),
		sentinel,
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-unnameable-field",
	])

	// A secret reference has no escape syntax, so an id the Module cannot name
	// exactly is an id it does not name at all: no wrapper delivery is attempted
	// and the page is left alone.
	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_VAULT_UNVERIFIED",
		runId: "login-unnameable-field",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the credential wrapper and the configured Credential Vault before retrying.",
		message: "The Credential Vault reply could not be read, interpreted, or safely used.",
	})
	expect(deliveryActions(probe)).toEqual([])
	expect(fixture.insertedText()).toEqual([])
})

test("a reference the installed op CLI would not parse delivers nothing", async () => {
	const { fixture, probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-reference-parses",
	])

	// The reference the Module builds is one the host would resolve. The
	// credential seam refuses any other the way the wrapper does, so this row
	// turns red if the Module ever escapes a segment again.
	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout).resultCode).toBe("LOGIN_FIELD_DELIVERED")
	expect(fixture.insertedText()).toEqual([sentinel])
})

test("the recorded delivery names the wrapper, the exact reference, and a non-secret command", async () => {
	const { fixture, probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-wrapper-contract",
	])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	const deliveries = deliveryActions(probe)
	expect(deliveries).toHaveLength(1)
	const delivery = deliveries[0]!
	// The one wrapper is the probe-local file under the probe's own home, so no
	// test can ever reach the real one.
	expect(delivery.wrapper).toBe(join(probe.home, "code/dotfiles/bin/with-one-password-token"))
	// Independent oracle: the reference restated by hand, three ids and nothing
	// escaped, naming the vault and the field by id and never by name or label.
	expect(delivery.reference).toBe("op://vlt-1/item-1/password-field")
	// The whole child command, restated by hand: the running Bun executable, the
	// flags that keep the child from reading any configuration or environment
	// file, the one shipped entry, the private re-entry argument, and only
	// non-secret values after it.
	expect(delivery.command).toEqual([
		process.execPath,
		"--config=/dev/null",
		"--no-install",
		"--env-file=/dev/null",
		join(packageRoot, "src/main.ts"),
		"--deliver-one-credential-field",
		"--port",
		String(fixture.port),
		"--target",
		"page-1",
		"--node",
		"13",
		"--frame",
		"frame-main",
		"--loader",
		"loader-1",
		"--url",
		"https://fixture.test/sign-in",
		"--origin",
		"https://fixture.test",
		"--field",
		"password",
	])
	expect(JSON.stringify(delivery.command)).not.toContain(sentinel)
})

test("the child's environment holds exactly what the wrapper preserves", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	// Every variable the wrapper preserves exists in the parent on purpose, so
	// the recorded scrub is a choice among present values, never an accident of
	// an absent one.
	probe.environment.LANG = "en_AU.UTF-8"
	probe.environment.LC_ALL = "en_AU.UTF-8"
	const temporary = join(probe.root, "wrapper-tmp")
	mkdirSync(temporary, { mode: 0o700 })
	probe.environment.TMPDIR = temporary

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-environment",
	])

	expect(result.exitCode).toBe(0)
	const delivery = deliveryActions(probe)[0]!
	// Independent oracle: the exact variable names the real wrapper preserves,
	// restated by hand, and no others.
	expect((delivery.environmentKeys as string[]).toSorted()).toEqual([
		"HOME",
		"LANG",
		"LC_ALL",
		"PATH",
		"TMPDIR",
	])
	expect(Object.keys(delivery.environment as Record<string, string>).toSorted()).toEqual([
		"HOME",
		"LANG",
		"LC_ALL",
		"PATH",
		"TMPDIR",
	])
	expect((delivery.environment as Record<string, string>).HOME).toBe(probe.home)
	expect(JSON.stringify(delivery.environment)).not.toContain(sentinel)
})

test("login delivers the password into exactly the referenced field", async () => {
	const { fixture, probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-password",
	])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	// Exactly one line of stdout: the envelope and nothing around it.
	expect(result.stdout.endsWith("\n")).toBe(true)
	expect(result.stdout.slice(0, -1)).not.toContain("\n")
	// Independent oracle: the whole envelope, restated by hand.
	expect(JSON.parse(result.stdout)).toEqual({
		schemaVersion: 1,
		status: "ok",
		command: "login",
		resultCode: "LOGIN_FIELD_DELIVERED",
		runId: "login-password",
		transactionState: "acted",
		retrySafe: false,
		nextAction:
			"Run warm-browser snapshot --run-id ID and obtain explicit human approval before any consequential submission.",
		data: {
			field: "password",
			reference: snapshot.elements[2]!.ref,
			fieldNowHoldsValue: true,
			controlledPage: { targetId: "page-1", url: "https://fixture.test/sign-in" },
			invalidatedReferences: true,
			postcondition: "running",
		},
	})
	// The sentinel reached exactly the referenced field, typed exactly once.
	expect(fixture.fieldValue(13)).toBe(sentinel)
	expect(fixture.insertedText()).toEqual([sentinel])
	// Every other node of the page is untouched.
	for (const node of [11, 12, 14, 15, 16] as const) {
		expect(fixture.fieldValue(node), String(node)).toBe("")
	}
	// The one focus the page saw is the child focusing the referenced field.
	expect(fixture.focusedNodes()).toEqual([13])
})

test("login delivers the username the same way, into the identifier field", async () => {
	const { fixture, probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[1]!.ref,
		"--field",
		"username",
		"--human-approved",
		"--run-id",
		"login-username",
	])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout)).toEqual({
		schemaVersion: 1,
		status: "ok",
		command: "login",
		resultCode: "LOGIN_FIELD_DELIVERED",
		runId: "login-username",
		transactionState: "acted",
		retrySafe: false,
		nextAction:
			"Run warm-browser snapshot --run-id ID and obtain explicit human approval before any consequential submission.",
		data: {
			field: "username",
			reference: snapshot.elements[1]!.ref,
			fieldNowHoldsValue: true,
			controlledPage: { targetId: "page-1", url: "https://fixture.test/sign-in" },
			invalidatedReferences: true,
			postcondition: "running",
		},
	})
	expect(deliveryActions(probe)[0]!.reference).toBe("op://vlt-1/item-1/username-field")
	expect(fixture.fieldValue(12)).toBe(sentinel)
	expect(fixture.insertedText()).toEqual([sentinel])
	expect(fixture.focusedNodes()).toEqual([12])
})

test("login proves username delivery when accessibility omits the post-insert value", async () => {
	const { fixture, probe, snapshot } = await signInProbe({
		elements: signInPage.map((element) =>
			element.backendNodeId === 12 ? { ...element, omitValueAfterInsert: true } : element),
	})
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[1]!.ref,
		"--field",
		"username",
		"--human-approved",
		"--run-id",
		"login-username-ax-omitted",
	])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout)).toMatchObject({
		resultCode: "LOGIN_FIELD_DELIVERED",
		transactionState: "acted",
		data: { fieldNowHoldsValue: true },
	})
	// Independent oracle: the fixture received one value only at the referenced
	// field even though its accessibility reply intentionally hid that value.
	expect(fixture.fieldValue(12)).toBe(sentinel)
	expect(fixture.insertedText()).toEqual([sentinel])
	// Independent protocol oracle: the child asks the exact resolved node for a
	// boolean after insertion, instead of asking Accessibility for another value.
	expect(fixture.latestConversation()).toEqual([
		"Page.enable",
		"DOM.enable",
		"Accessibility.enable",
		"Page.getFrameTree",
		"DOM.describeNode",
		"Accessibility.getPartialAXTree",
		"DOM.resolveNode",
		"Runtime.callFunctionOn",
		"Page.getFrameTree",
		"DOM.focus",
		"Accessibility.getPartialAXTree",
		"Input.insertText",
		"Page.getFrameTree",
		"DOM.resolveNode",
		"Runtime.callFunctionOn",
	])
})

test("an unavailable boolean empty check refuses username before insertion", async () => {
	const { fixture, probe, snapshot } = await signInProbe({
		failMethods: ["Runtime.callFunctionOn"],
	})
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[1]!.ref,
		"--field",
		"username",
		"--human-approved",
		"--run-id",
		"login-username-value-unverified",
	])

	expectRefusal(result, 20, {
		resultCode: "PRIVATE_DELIVERY_UNVERIFIED",
		runId: "login-username-value-unverified",
		transactionState: "acted",
	})
	// Independent oracle: a question the child cannot answer does not become an
	// assumption that the field is empty, so the sentinel never reaches the page.
	expect(fixture.insertedText()).toEqual([])
	expect(fixture.fieldValue(12)).toBe("")
})

test("the sentinel is absent from every public and durable surface", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-custody",
	])

	expect(result.exitCode).toBe(0)
	expect(result.stdout).not.toContain(sentinel)
	expect(result.stderr).not.toContain(sentinel)
	const delivery = deliveryActions(probe)[0]!
	expect(JSON.stringify(delivery.command)).not.toContain(sentinel)
	expect(JSON.stringify(delivery.environment)).not.toContain(sentinel)
	for (const vaultAction of vaultActions(probe)) {
		expect(JSON.stringify(vaultAction.argumentList)).not.toContain(sentinel)
	}
	expect(readFileSync(probe.sessionPath, "utf8")).not.toContain(sentinel)
	// Every byte of durable private state, read by a walker that imports nothing
	// from src. The scan must have found something, so an empty scan can never
	// pass for a clean one.
	const files = filesUnderPrivateState(probe)
	expect(files.length).toBeGreaterThan(0)
	for (const file of files) {
		expect(file.bytes, file.path).not.toContain(sentinel)
	}
})

test("no reference survives the delivery, so a fresh snapshot is mandatory", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	const reference = snapshot.elements[2]!.ref

	const delivered = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		reference,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-invalidate",
	])

	expect(delivered.exitCode).toBe(0)
	// The durable receipt dropped the whole generation with the delivery.
	expect(readReceipt(probe).snapshot).toBeUndefined()
	// The reference that was just used is dead: a consequential submit cannot
	// reuse it, because nothing can act before a fresh snapshot is taken.
	const clicked = await runProductionCliAsync(probe, [
		"click",
		"--ref",
		reference,
		"--run-id",
		"login-after-click",
	])
	expectError(clicked, 21, {
		schemaVersion: 1,
		status: "error",
		command: "click",
		resultCode: "SNAPSHOT_ABSENT",
		runId: "login-after-click",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID before acting on the Controlled Page.",
		message: "This Browser Session holds no Snapshot Generation.",
	})
})

test("one disposable child ran, its reply was consumed, and nothing was left behind", async () => {
	const { probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	// The temporary directory the child inherits, listed before and after so a
	// child that wrote anything at all would show up as a new entry.
	const temporary = join(probe.root, "child-tmp")
	mkdirSync(temporary, { mode: 0o700 })
	probe.environment.TMPDIR = temporary
	const entriesBefore = readdirSync(temporary, { recursive: true })

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-disposable",
	])

	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	expect(deliveryActions(probe)).toHaveLength(1)
	// The child's own reply line was consumed rather than forwarded: stdout is
	// one line, it is the login envelope, and no child outcome appears in it.
	expect(result.stdout.endsWith("\n")).toBe(true)
	expect(result.stdout.slice(0, -1)).not.toContain("\n")
	expect(JSON.parse(result.stdout).resultCode).toBe("LOGIN_FIELD_DELIVERED")
	expect(result.stdout).not.toContain("outcome")
	expect(readdirSync(temporary, { recursive: true })).toEqual(entriesBefore)
})

test("a page that moves between the parent's reading and the child's typing gets no secret", async () => {
	// The fourth frame read of the scenario is the parent's closing identity
	// proof: two for the snapshot, two around the parent's field reading. Moving
	// the page immediately after it lands the navigation in the exact window
	// between the parent's proof and the disposable child's own.
	const { fixture, probe, snapshot } = await signInProbe({
		navigateAfterMethod: {
			method: "Page.getFrameTree",
			url: "https://fixture.test/moved",
			occurrence: 4,
		},
	})
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-race",
	])

	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "PAGE_IDENTITY_CHANGED",
		runId: "login-race",
		transactionState: "invalidated",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message: "The Controlled Page is no longer the page this Snapshot Reference was issued against.",
	})
	// The child revalidated before typing, so the secret never reached the
	// moved document.
	expect(fixture.insertedText()).toEqual([])
})

test("a page that moves to another origin in that window gets no secret either", async () => {
	const { fixture, probe, snapshot } = await signInProbe({
		navigateAfterMethod: {
			method: "Page.getFrameTree",
			url: "https://elsewhere.example/landing",
			occurrence: 4,
		},
	})
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-origin-race",
	])

	// A cross-origin move is answered as the origin moving, not as the page
	// moving. Both are true of this document, and the origin is the one the
	// Credential Match was made against, so it is the one the caller is told
	// about; the test above proves a move within the same origin still answers
	// as the page moving, so the two are really distinguished.
	expectError(result, 21, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "ORIGIN_CHANGED",
		runId: "login-origin-race",
		transactionState: "invalidated",
		retrySafe: false,
		nextAction: "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.",
		message: "The Controlled Page's exact origin moved before the field was filled.",
	})
	expect(fixture.insertedText()).toEqual([])
})

test("a replaced Controlled Page refuses the login with nothing delivered", async () => {
	const { fixture, probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, oneItemPlan(["https://fixture.test"]))
	fixture.replacePage("page-2")

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-replaced",
	])

	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CONTROLLED_PAGE_REPLACED",
		runId: "login-replaced",
		transactionState: "invalidated",
		retrySafe: false,
		nextAction:
			"Run warm-browser open --url URL --adopt-page --run-id ID to bind the replacement Controlled Page.",
		message: "The Browser Session's Controlled Page was replaced by another page.",
	})
	expect(vaultActions(probe)).toEqual([])
	expect(deliveryActions(probe)).toEqual([])
	expect(fixture.insertedText()).toEqual([])
})

test("a wrapper that fails before the child runs proves nothing was inserted", async () => {
	const { fixture, probe, snapshot } = await signInProbe()
	configureCredentialVault(probe, "Agent Vault")
	writeCredentialPlan(probe, {
		...oneItemPlan(["https://fixture.test"]),
		// The wrapper's delivery-bootstrap exit, with no child reply at all: the
		// wrapper stopped before the child existed.
		deliveryFails: { status: 70 },
	})

	const result = await runProductionCliAsync(probe, [
		"login",
		"--ref",
		snapshot.elements[2]!.ref,
		"--field",
		"password",
		"--human-approved",
		"--run-id",
		"login-wrapper-failed",
	])

	// A reserved wrapper exit with no reply is the custody chain stopping
	// before any process that speaks to the page existed, so production answers
	// for the vault conversation rather than for a delivery that never began.
	expectError(result, 20, {
		schemaVersion: 1,
		status: "error",
		command: "login",
		resultCode: "CREDENTIAL_VAULT_UNVERIFIED",
		runId: "login-wrapper-failed",
		transactionState: "unchanged",
		retrySafe: false,
		nextAction: "Inspect the credential wrapper and the configured Credential Vault before retrying.",
		message: "The Credential Vault reply could not be read, interpreted, or safely used.",
	})
	expect(fixture.insertedText()).toEqual([])
})
