import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, test } from "bun:test"

const root = resolve(import.meta.dir, "..")
const skill = readFileSync(resolve(root, "plugin/skills/notebooklm/SKILL.md"), "utf8")
const operations = readFileSync(
	resolve(root, "plugin/skills/notebooklm/references/operations.md"),
	"utf8",
)

function section(markdown: string, heading: string): string {
	const start = markdown.indexOf(`## ${heading}`)
	if (start === -1) throw new Error(`missing section: ${heading}`)
	const next = markdown.indexOf("\n## ", start + heading.length + 3)
	return markdown.slice(start, next === -1 ? undefined : next)
}

function prose(markdown: string): string {
	return markdown.replace(/\s+/g, " ")
}

describe("NotebookLM model-only workflow contract", () => {
	test("runs a safe authentication preflight before choosing any browser route", () => {
		expect(prose(skill)).toContain(
			"Before any authentication window or browser route, read [Authentication Preflight]",
		)
		const preflight = section(operations, "Authentication Preflight")
		expect(prose(preflight)).toContain("Never run `nlm login` during preflight")
		expect(prose(preflight)).toContain("Never inspect browser state during preflight")
	})

	test("publishes the complete readiness outcome matrix", () => {
		const preflight = section(operations, "Authentication Preflight")
		const expectedRows = [
			"| `configured` | `ready` | Client route |",
			"| `stale` or `not_configured` | `blocked` | Choice required |",
			"| Missing dependency, alias, bad schema, or `error` | `unavailable` | Repair route |",
			"| Authentication choice cancelled in this task | `cancelled` | No route |",
			"| Personal or Monash existing-browser client bridge | `unsupported_route` | Browser upload |",
		]
		for (const row of expectedRows) expect(preflight).toContain(row)
	})

	test("keeps application-session and client-authentication readiness distinct", () => {
		const preflight = section(operations, "Authentication Preflight")
		expect(preflight).toContain("Set `application_session` to `unknown`")
		expect(preflight).toContain("`client_authentication`")
		expect(prose(preflight)).toContain("A signed-in NotebookLM tab does not make the MCP client ready")
	})

	test("records why the existing-browser client bridge remains unqualified", () => {
		const evidence = section(operations, "Qualified Client Evidence")
		expect(evidence).toContain("notebooklm-mcp-cli 0.9.13")
		expect(evidence).toContain("`Network.getAllCookies`")
		expect(evidence).toContain("`.example.test`")
		expect(evidence).toContain("unqualified")
		expect(evidence).toContain("Credential scope: all cookies visible to the connected CDP target")
	})

	test("preserves cancellation without silently reopening authentication", () => {
		const authentication = section(operations, "Authentication Choice")
		expect(prose(authentication)).toContain("record `cancelled` for the current task")
		expect(authentication).toContain("Do not offer or run `nlm login` again")
		expect(prose(authentication)).toContain(
			"explicitly selects client authentication in a later message",
		)
	})

	test("defines the browser-upload fallback and its independent success criteria", () => {
		const fallback = section(operations, "Browser Upload Fallback")
		expect(fallback).toContain("invoke the installed `$browser-use` entry skill")
		expect(fallback).toContain("Supported operations: local-file source upload")
		expect(fallback).toContain("Owner: `browser-use`")
		expect(fallback).toContain("Independent success criteria")
		expect(fallback).toContain("stable source identity")
	})
})
