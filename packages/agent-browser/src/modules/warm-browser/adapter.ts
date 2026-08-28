import type {
	BrowserProcessIdentity,
	EndpointVerification,
	ProcessInspection,
	ProcessListInspection,
} from "./contract"
import type { LaunchOwnership } from "./ownership"

/**
 * The Module's private implementation seam.
 *
 * This is not part of the Warm Browser contract and never reaches a caller: the
 * public entry binds the one fixed production Adapter itself and takes no
 * injected dependency. A test substitutes this seam by replacing the owning
 * module, so the production entry, argument parser, vocabulary, and lifecycle
 * rules all stay real.
 */
export interface WarmBrowserAdapter {
	createRunId(): string
	createSessionId(): string
	createSnapshotId(): string
	createScreenshotId(): string
	nowEpochMs(): number
	platform(): string
	chromeExecutable(): string
	inspectChrome(executable: string): "installed" | "unavailable"
	profileRoot(): string
	inspectProfile(profileRoot: string): "safe" | "unsafe"
	findProfileProcesses(profileRoot: string): ProcessListInspection
	findLaunchProcesses(launchMarker: string): ProcessListInspection
	inspectPort(port: number): Promise<"free" | "occupied" | "unverifiable">
	spawnChrome(input: {
		readonly executable: string
		readonly argumentList: readonly string[]
		readonly ownership: LaunchOwnership
	}): Promise<BrowserProcessIdentity>
	inspectProcess(pid: number): ProcessInspection
	verifyEndpoint(input: {
		readonly host: "127.0.0.1"
		readonly port: number
		readonly process: BrowserProcessIdentity
	}): Promise<EndpointVerification>
	terminateProcessGroup(
		process: BrowserProcessIdentity,
		ownership: LaunchOwnership,
	): Promise<boolean>
}
