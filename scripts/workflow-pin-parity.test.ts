import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { expect, test } from "bun:test"

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const workflowPaths = [
	".github/workflows/plugin-ci.yml",
	".github/workflows/hosted-canary.yml",
	".github/workflows/release.yml",
] as const

function workflowSources(): string[] {
	return workflowPaths.map((path) => readFileSync(`${root}/${path}`, "utf8"))
}

function extractPinLine(workflow: string): string {
	const matches = workflow
		.split("\n")
		.filter((line) => line.trimStart().startsWith("run: bun add --global "))
	if (matches.length !== 1) {
		throw new Error(`expected one native CLI pin line, found ${matches.length}`)
	}
	const [pinLine] = matches
	if (pinLine === undefined) throw new Error("native CLI pin line is missing")
	return pinLine
}

function expectWorkflowPinParity(workflows: string[]): void {
	const pinLines = workflows.map(extractPinLine)
	const [firstPinLine] = pinLines
	if (firstPinLine === undefined) throw new Error("native CLI pin line is missing")
	expect(pinLines).toEqual(Array.from({ length: pinLines.length }, () => firstPinLine))
}

function bumpPinnedVersions(workflow: string): string {
	const pinLine = extractPinLine(workflow)
	const bumpedPinLine = pinLine.replace(
		/@(\d+)\.(\d+)\.(\d+)(?=")/g,
		(_, major, minor, patch) => `@${major}.${minor}.${Number(patch) + 1}`,
	)
	if (bumpedPinLine === pinLine) {
		throw new Error("native CLI pin line contains no semantic versions")
	}
	return workflow.replace(pinLine, bumpedPinLine)
}

test("native CLI workflow pin lines are byte-identical", () => {
	expectWorkflowPinParity(workflowSources())
})

test("workflow pin parity rejects one differing line and accepts a coordinated bump", () => {
	const workflows = workflowSources()
	const oneDiffering = [...workflows]
	const firstWorkflow = oneDiffering[0]
	if (firstWorkflow === undefined) throw new Error("workflow source is missing")
	oneDiffering[0] = bumpPinnedVersions(firstWorkflow)

	expect(() => expectWorkflowPinParity(oneDiffering)).toThrow()
	expectWorkflowPinParity(workflows.map(bumpPinnedVersions))
})
