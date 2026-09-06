const compiledSkillEnvironmentName = "AGENT_PLUGIN_COMPILED_SKILL"

/** The skill selected by the generated compiled dispatcher in this process. */
export function currentCompiledSkill(): string | undefined {
	return process.env[compiledSkillEnvironmentName]
}

/** Select the verified file that owns one Private Delivery re-entry. */
export function privateEntryPath(input: {
	readonly executable: string
	readonly invocationEntry: string | undefined
	readonly compiledSkill: string | undefined
}): string | undefined {
	return input.compiledSkill === "agent-browser"
		? input.executable
		: input.invocationEntry
}

/** Build one source-bundle or compiled-executable Private Delivery command. */
export function privateEntryCommand(input: {
	readonly executable: string
	readonly entry: string
	readonly compiledSkill: string | undefined
	readonly argumentList: readonly string[]
}): readonly string[] {
	if (input.compiledSkill === "agent-browser" && input.entry === input.executable) {
		return [input.executable, "agent-browser", ...input.argumentList]
	}
	return [
		input.executable,
		"--config=/dev/null",
		"--no-install",
		"--env-file=/dev/null",
		input.entry,
		...input.argumentList,
	]
}
