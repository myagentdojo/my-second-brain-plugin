export const schemaVersion = 1 as const

/**
 * One option a command accepts. Options are declared beside the command that
 * accepts them, so the parser, the usage line, and the help result all read the
 * same table and no command's argument rules are restated anywhere else.
 */
export interface CommandOption {
	readonly flag: string
	/** The placeholder a value-bearing option names in usage; a switch has none. */
	readonly value: string | null
	readonly required: boolean
}

/** Accepted by every command, so it is declared once instead of per command. */
export const runIdOption: CommandOption = { flag: "--run-id", value: "ID", required: false }

/**
 * Public selectors are outside this interface. A caller that names one is told
 * exactly that, rather than being told its argument was unrecognised, because
 * the answer is to take a snapshot and act through its Snapshot References.
 */
export const refusedSelectorFlags = ["--selector", "--css", "--xpath", "--text"] as const

export const commandVocabulary = [
	{ name: "help", sideEffects: "none", options: [] },
	{
		name: "start",
		sideEffects:
			"may stop a proved stale owned browser process group, then starts one owned browser process group",
		options: [{ flag: "--port", value: "NUMBER", required: false }],
	},
	{
		name: "status",
		sideEffects: "may stop a proved stale owned browser process group and remove its private state",
		options: [],
	},
	{
		name: "open",
		sideEffects:
			"navigates the one Controlled Page and invalidates every earlier Snapshot Reference",
		options: [
			{ flag: "--url", value: "URL", required: true },
			{ flag: "--adopt-page", value: null, required: false },
		],
	},
	{
		name: "snapshot",
		sideEffects: "reads the Controlled Page and replaces every earlier Snapshot Reference",
		options: [],
	},
	{
		name: "click",
		sideEffects: "dispatches one click on one referenced element of the Controlled Page",
		options: [{ flag: "--ref", value: "REFERENCE", required: true }],
	},
	{
		name: "fill",
		sideEffects: "types one non-secret value into one referenced field of the Controlled Page",
		options: [
			{ flag: "--ref", value: "REFERENCE", required: true },
			{ flag: "--value", value: "TEXT", required: true },
		],
	},
	{ name: "stop", sideEffects: "stops one verified owned browser process group", options: [] },
] as const

export type CliCommand = (typeof commandVocabulary)[number]["name"]
export type SliceCommand = Exclude<CliCommand, "help">
/** A command that acts on the Controlled Page of an already running session. */
export type PageCommand = Extract<CliCommand, "open" | "snapshot" | "click" | "fill">
export type TransactionState =
	| "unchanged"
	| "started"
	| "stopped"
	| "recovered"
	| "rolled_back"
	| "acted"

export type ResultCode =
	| "HELP"
	| "SESSION_STARTED"
	| "SESSION_RUNNING"
	| "SESSION_ABSENT"
	| "SESSION_STOPPED"
	| "STALE_SESSION_RECOVERED"
	| "USAGE_ERROR"
	| "PLATFORM_UNSUPPORTED"
	| "STATE_UNSAFE"
	| "CHROME_UNAVAILABLE"
	| "PROFILE_UNSAFE"
	| "PROFILE_PROCESS_AMBIGUOUS"
	| "PROFILE_IN_USE"
	| "PROCESS_INSPECTION_UNVERIFIED"
	| "PROCESS_IDENTITY_UNVERIFIED"
	| "LAUNCH_PROCESS_AMBIGUOUS"
	| "CDP_IDENTITY_UNVERIFIED"
	| "CONTROLLED_PAGE_UNAVAILABLE"
	| "CONTROLLED_PAGE_AMBIGUOUS"
	| "CONTROLLED_PAGE_REPLACED"
	| "SESSION_ALREADY_RUNNING"
	| "PORT_OCCUPIED"
	| "PORT_UNVERIFIABLE"
	| "START_IN_PROGRESS"
	| "PAGE_OPENED"
	| "SNAPSHOT_TAKEN"
	| "ELEMENT_CLICKED"
	| "FIELD_FILLED"
	| "SNAPSHOT_ABSENT"
	| "SNAPSHOT_REFERENCE_INVALID"
	| "SNAPSHOT_REFERENCE_STALE"
	| "PAGE_IDENTITY_CHANGED"
	| "SELECTOR_UNSUPPORTED"
	| "CREDENTIAL_FIELD_REFUSED"
	| "NAVIGATION_TARGET_REFUSED"
	| "NAVIGATION_FAILED"
	| "PAGE_CONTROL_UNVERIFIED"
	| "UNEXPECTED_FAILURE"

export interface SuccessEnvelope {
	readonly schemaVersion: typeof schemaVersion
	readonly status: "ok"
	readonly command: CliCommand
	readonly resultCode: ResultCode
	readonly runId: string
	readonly transactionState: TransactionState
	readonly retrySafe: boolean
	readonly nextAction: string
	readonly data: Record<string, unknown>
}

export interface ErrorEnvelope {
	readonly schemaVersion: typeof schemaVersion
	readonly status: "error"
	readonly command: CliCommand | "unknown"
	readonly resultCode: ResultCode
	readonly runId: string
	readonly transactionState: TransactionState
	readonly retrySafe: boolean
	readonly nextAction: string
	readonly message: string
}

export interface CliOutcome {
	readonly exitCode: 0 | 1 | 2 | 20 | 21 | 22
	readonly stdout: string
	readonly stderr: string
}

export class SpawnCleanupUnverifiedError extends Error {
	constructor() {
		super("spawned Chrome process-group cleanup could not be verified")
		this.name = "SpawnCleanupUnverifiedError"
	}
}

export interface BrowserProcessIdentity {
	readonly pid: number
	readonly processGroupId: number
	readonly startedAtToken: string
	readonly executable: string
	readonly commandLine: string
}

export type ProcessInspection =
	| { readonly kind: "found"; readonly process: BrowserProcessIdentity }
	| { readonly kind: "absent" }
	| { readonly kind: "unverifiable" }

export type ProcessListInspection =
	| { readonly kind: "verified"; readonly processes: readonly BrowserProcessIdentity[] }
	| { readonly kind: "unverifiable" }

export interface VerifiedEndpoint {
	readonly browserVersion: string
	readonly controlledPageTargetId: string
}

export type EndpointVerification =
	| { readonly kind: "verified"; readonly endpoint: VerifiedEndpoint }
	| { readonly kind: "process_unverifiable" }
	| { readonly kind: "browser_unverified" }
	| { readonly kind: "listener_unverified" }
	| { readonly kind: "controlled_page_unavailable" }
	| { readonly kind: "controlled_page_ambiguous" }

/**
 * What the Controlled Page is at one instant: which target it is, which frame
 * and document load it is showing, and where it is. A Snapshot Reference is
 * only ever usable while this whole identity is unchanged, so it is compared
 * as a whole and never field by field at a call site.
 */
export interface ControlledPageBasis {
	readonly targetId: string
	readonly frameId: string
	readonly loaderId: string
	readonly url: string
}

/** One element the Controlled Page exposes to a semantic snapshot. */
export interface ControlledPageElement {
	readonly backendNodeId: number
	readonly role: string
	readonly name: string
	readonly credentialField: boolean
}

export type PageNavigation =
	| { readonly kind: "navigated"; readonly basis: ControlledPageBasis }
	/** The browser answered the navigation with its own error. */
	| { readonly kind: "refused" }
	| { readonly kind: "unverified" }

export type PageSnapshotReading =
	| {
		readonly kind: "observed"
		readonly basis: ControlledPageBasis
		readonly elements: readonly ControlledPageElement[]
		readonly truncated: boolean
	}
	/** The page moved while it was being read, so no reference may be issued. */
	| { readonly kind: "identity_changed" }
	| { readonly kind: "unverified" }

export type PageActionOutcome =
	| { readonly kind: "acted"; readonly basis: ControlledPageBasis }
	/** The page was not the one the reference was issued against. */
	| { readonly kind: "identity_changed" }
	/** The referenced element is no longer a thing this page can be acted on. */
	| { readonly kind: "element_absent" }
	/** The live element is a credential field, whatever the snapshot recorded. */
	| { readonly kind: "credential_field" }
	| { readonly kind: "unverified" }
