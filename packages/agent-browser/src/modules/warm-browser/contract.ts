export const schemaVersion = 1 as const

export type SliceCommand = "start" | "status" | "stop"
export type CliCommand = "help" | SliceCommand
export type TransactionState = "unchanged" | "started" | "stopped" | "recovered" | "rolled_back"

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
	| "PROCESS_IDENTITY_UNVERIFIED"
	| "CDP_IDENTITY_UNVERIFIED"
	| "CONTROLLED_PAGE_UNAVAILABLE"
	| "CONTROLLED_PAGE_AMBIGUOUS"
	| "SESSION_ALREADY_RUNNING"
	| "PORT_OCCUPIED"
	| "PORT_UNVERIFIABLE"
	| "START_IN_PROGRESS"
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

export interface VerifiedEndpoint {
	readonly browserVersion: string
	readonly controlledPageTargetId: string
}

export type EndpointVerification =
	| { readonly kind: "verified"; readonly endpoint: VerifiedEndpoint }
	| { readonly kind: "browser_unverified" }
	| { readonly kind: "listener_unverified" }
	| { readonly kind: "controlled_page_unavailable" }
	| { readonly kind: "controlled_page_ambiguous" }

export interface WarmBrowserAdapter {
	createRunId(): string
	createSessionId(): string
	nowEpochMs(): number
	platform(): string
	chromeExecutable(): string
	inspectChrome(executable: string): "installed" | "unavailable"
	profileRoot(): string
	inspectProfile(profileRoot: string): "safe" | "unsafe"
	findProfileProcesses(profileRoot: string): readonly BrowserProcessIdentity[]
	inspectPort(port: number): Promise<"free" | "occupied" | "unverifiable">
	spawnChrome(input: {
		readonly executable: string
		readonly profileRoot: string
		readonly port: number
	}): Promise<BrowserProcessIdentity>
	inspectProcess(pid: number): BrowserProcessIdentity | undefined
	verifyEndpoint(input: {
		readonly host: "127.0.0.1"
		readonly port: number
		readonly process: BrowserProcessIdentity
	}): Promise<EndpointVerification>
	terminateProcessGroup(process: BrowserProcessIdentity): Promise<boolean>
}
