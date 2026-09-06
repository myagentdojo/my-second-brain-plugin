import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content)
	chmodSync(path, 0o755)
}

export interface FakeCodexPlugin {
	pluginId: string
	name: string
	marketplaceName: string
	version: string
	installed: boolean
	enabled: boolean
	source: { source: string; path: string }
	marketplaceSource: { sourceType: string; source: string }
}

interface FakeCodexState {
	marketplaces: Array<{ name: string; root: string }>
	plugins: FakeCodexPlugin[]
	commands: string[]
	skipInstall?: boolean
	failCommands?: string[]
	failAfterCommands?: string[]
	invalidJsonCommands?: string[]
}

export function fakeCodexProfile(
	repositoryRoot: string,
	options: {
		realBuild?: boolean
		marketplaceRoot?: string | null
		plugins?: FakeCodexPlugin[]
		skipInstall?: boolean
		failCommands?: string[]
		failAfterCommands?: string[]
		invalidJsonCommands?: string[]
	} = {},
) {
	const temporaryRoot = mkdtempSync(
		join(tmpdir(), "codex-development-profile-"),
	)
	const binaryRoot = join(temporaryRoot, "bin")
	const statePath = join(temporaryRoot, "state.json")
	const marketplaceRoot = join(repositoryRoot, ".dev", "codex-marketplace")
	mkdirSync(binaryRoot, { recursive: true })
	writeExecutable(
		join(binaryRoot, "bun"),
		`#!/bin/sh
${options.realBuild ? "" : 'if [ "$1" = "run" ] && [ "$2" = "build" ]; then exit 0; fi'}
exec '${process.execPath}' "$@"
`,
	)
	writeExecutable(
		join(binaryRoot, "codex"),
		`#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const statePath = process.env.CODEX_TEST_STATE
const state = JSON.parse(readFileSync(statePath, "utf8"))
const args = process.argv.slice(2)
const command = args.join(" ")
state.commands.push(command)
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n")
const completeMutation = (output) => {
  save()
  if (state.failAfterCommands?.includes(command)) {
    console.error("injected Codex post-mutation failure")
    process.exit(70)
  }
  console.log(JSON.stringify(output))
}
if (state.failCommands?.includes(command)) {
  save()
  console.error("injected Codex failure")
  process.exit(70)
} else if (state.invalidJsonCommands?.includes(command)) {
  save()
  console.log("not JSON")
} else if (command === "plugin marketplace list --json") {
  save()
  console.log(JSON.stringify({ marketplaces: state.marketplaces }))
} else if (command === "plugin list --json") {
  save()
  console.log(JSON.stringify({ installed: state.plugins, available: [] }))
} else if (args.slice(0, 3).join(" ") === "plugin marketplace add") {
	const root = args[3]
	state.marketplaces = state.marketplaces.filter((entry) => entry.name !== "my-second-brain-dev")
	state.marketplaces.push({ name: "my-second-brain-dev", root })
	completeMutation({ marketplaceName: "my-second-brain-dev", installedRoot: root })
} else if (args[0] === "plugin" && args[1] === "add") {
  if (!state.skipInstall) {
    const sourcePath = join(process.env.CODEX_TEST_MARKETPLACE_ROOT, "plugins", "my-second-brain-dev")
    const manifest = JSON.parse(readFileSync(join(sourcePath, ".codex-plugin", "plugin.json"), "utf8"))
    state.plugins = state.plugins.filter((entry) => entry.pluginId !== args[2])
    state.plugins.push({
      pluginId: args[2],
      name: "my-second-brain-dev",
      marketplaceName: "my-second-brain-dev",
      version: manifest.version,
      installed: true,
      enabled: true,
      source: { source: "local", path: sourcePath },
		marketplaceSource: { sourceType: "local", source: process.env.CODEX_TEST_MARKETPLACE_ROOT },
	})
	}
	completeMutation({ ok: true })
} else if (args[0] === "plugin" && args[1] === "remove") {
	state.plugins = state.plugins.filter((entry) => entry.pluginId !== args[2])
	completeMutation({ ok: true })
} else {
  save()
  console.error("unexpected Codex command: " + command)
  process.exit(99)
}
`,
	)
	const state: FakeCodexState = {
		marketplaces:
			options.marketplaceRoot === null
				? []
				: [
						{
							name: "my-second-brain-dev",
							root: options.marketplaceRoot ?? marketplaceRoot,
						},
					],
		plugins: options.plugins ?? [],
		commands: [],
		skipInstall: options.skipInstall,
		failCommands: options.failCommands,
		failAfterCommands: options.failAfterCommands,
		invalidJsonCommands: options.invalidJsonCommands,
	}
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
	return {
		environment: {
			...process.env,
			PATH: `${binaryRoot}:${process.env.PATH ?? ""}`,
			CODEX_TEST_STATE: statePath,
			CODEX_TEST_MARKETPLACE_ROOT: marketplaceRoot,
		},
		marketplaceRoot,
		readState: () =>
			JSON.parse(readFileSync(statePath, "utf8")) as FakeCodexState,
		writeState: (state: FakeCodexState) =>
			writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`),
		cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true }),
	}
}
