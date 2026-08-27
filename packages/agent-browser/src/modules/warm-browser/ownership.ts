import type { BrowserProcessIdentity } from "./contract"

/**
 * The one owner of what Warm Browser launches and of every comparison that
 * decides whether an observed process is that launch.
 *
 * Ownership used to be decided in several places with different rules: spawn
 * confirmation compared a process identity and its group, launching recovery
 * asked only whether four arguments were present, and termination compared the
 * saved record. Those rules drifted, and the weakest one governed the most
 * dangerous act, signalling a process group. Every caller now asks this module,
 * so an ownership rule can only be changed here, for all of them at once.
 */

/**
 * The single owner of the launched Chrome argument list, including every
 * security-sensitive argument. Each argument appears exactly once.
 */
export function chromeArgumentList(input: {
	readonly profileRoot: string
	readonly port: number
	readonly launchMarker: string
}): readonly string[] {
	return [
		`--user-data-dir=${input.profileRoot}`,
		"--profile-directory=Default",
		"--remote-debugging-address=127.0.0.1",
		`--remote-debugging-port=${input.port}`,
		`--agent-browser-launch-marker=${input.launchMarker}`,
		"--password-store=basic",
		"--use-mock-keychain",
		"--no-first-run",
		"--no-default-browser-check",
	]
}

/**
 * Everything a launch must be able to prove about itself later, bound durably
 * before the launch happens. The whole command line is kept, not a list of
 * interesting arguments, so recovery compares bytes instead of re-deciding
 * which arguments mattered.
 */
export interface LaunchOwnership {
	readonly executable: string
	readonly commandLine: string
}

/** Binds one launch's durable ownership from the arguments it will be given. */
export function launchOwnership(input: {
	readonly executable: string
	readonly profileRoot: string
	readonly port: number
	readonly launchMarker: string
}): LaunchOwnership {
	const argumentList = chromeArgumentList(input)
	return {
		executable: input.executable,
		commandLine: [input.executable, ...argumentList].join(" "),
	}
}

/** Reports whether one command line carries an argument as a whole token. */
export function commandHasArgument(commandLine: string, argument: string): boolean {
	return ` ${commandLine} `.includes(` ${argument} `)
}

/**
 * Proves an observed process is the launch this ownership describes.
 *
 * The row must lead its own process group, run the launched executable, and
 * carry the launched argument list byte for byte, marker included: one extra
 * argument, one missing security or keychain argument, or one changed argument
 * all fail. The start token is required so the identity handed back can be
 * compared again later.
 */
export function isOwnedLaunch(
	observed: BrowserProcessIdentity,
	ownership: LaunchOwnership,
): boolean {
	return (
		observed.processGroupId === observed.pid &&
		observed.executable === ownership.executable &&
		observed.commandLine === ownership.commandLine &&
		observed.startedAtToken !== ""
	)
}

/**
 * Proves an observed process is the exact saved one. A process identity can be
 * reused, so every field of the saved record must still agree.
 */
export function isSameProcess(
	expected: BrowserProcessIdentity,
	observed: BrowserProcessIdentity | undefined,
): boolean {
	return (
		observed !== undefined &&
		observed.pid === expected.pid &&
		observed.processGroupId === expected.processGroupId &&
		observed.startedAtToken === expected.startedAtToken &&
		observed.executable === expected.executable &&
		observed.commandLine === expected.commandLine
	)
}

/**
 * Proves an observed process is both the exact saved one and still the launch
 * Warm Browser owns. This is the only admissible answer before a signal.
 */
export function ownsProcess(
	expected: BrowserProcessIdentity,
	observed: BrowserProcessIdentity | undefined,
	ownership: LaunchOwnership,
): boolean {
	return isSameProcess(expected, observed) && isOwnedLaunch(observed!, ownership)
}
