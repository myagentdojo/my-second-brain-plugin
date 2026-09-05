import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const sourceCommand = resolve(import.meta.dir, "main.ts")
const command = process.env.VAULT_NOTE_COMMITS_COMMAND ?? sourceCommand
const commandPrefix = command === sourceCommand ? [process.execPath, command] : [command]
const temporaryRoots: string[] = []

interface CommandResult {
	exitCode: number
	stdout: string
	stderr: string
	json: Record<string, unknown>
}

function run(cwd: string, arguments_: string[], environment: Record<string, string> = {}): CommandResult {
	const result = Bun.spawnSync([...commandPrefix, ...arguments_, "--json"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0" },
	})
	const stdout = new TextDecoder().decode(result.stdout)
	return {
		exitCode: result.exitCode,
		stdout,
		stderr: new TextDecoder().decode(result.stderr),
		json: JSON.parse(stdout) as Record<string, unknown>,
	}
}

function git(cwd: string, ...arguments_: string[]): string {
	const result = Bun.spawnSync(["git", ...arguments_], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	})
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr))
	}
	return new TextDecoder().decode(result.stdout).trim()
}

function write(root: string, path: string, contents: string): void {
	const target = join(root, path)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, contents)
}

function fixture(): { root: string; vault: string; state: string; initialHead: string } {
	const root = mkdtempSync(join(tmpdir(), "vault-note-commits-test-"))
	temporaryRoots.push(root)
	const vault = join(root, "vault")
	const state = join(root, "state")
	mkdirSync(vault)
	git(vault, "init", "-b", "main")
	git(vault, "config", "user.name", "Vault Test")
	git(vault, "config", "user.email", "vault-test@example.invalid")
	write(vault, "package.json", `${JSON.stringify({ private: true, scripts: { check: "bun run check.ts" } }, null, 2)}\n`)
	write(
		vault,
		"check.ts",
		'import { existsSync } from "node:fs"\nif (existsSync("BROKEN")) { console.error("broken fixture"); process.exit(1) }\n',
	)
	write(vault, "README.md", "# Fixture vault\n")
	write(vault, "projects/demo/GOAL.md", "# Goal\n\nOpen.\n")
	git(vault, "add", "--", "package.json", "check.ts", "README.md", "projects/demo/GOAL.md")
	git(vault, "commit", "-m", "chore: initialize fixture")
	return { root, vault, state, initialHead: git(vault, "rev-parse", "HEAD") }
}

function begin(vault: string, state: string, paths: string[]): CommandResult {
	return run(
		vault,
		["begin", "--vault", vault, ...paths.flatMap((path) => ["--path", path])],
		{ XDG_STATE_HOME: state },
	)
}

function finish(vault: string, state: string, worktree: string, message = "docs: record vault update"): CommandResult {
	return run(vault, ["finish", "--worktree", worktree, "--message", message], { XDG_STATE_HOME: state })
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("begin and finish create one checked project-note commit on canonical main", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/new-project/README.md"])

	expect(started.exitCode).toBe(0)
	expect(started.stderr).toBe("")
	expect(started.json).toMatchObject({ ok: true, code: "CANDIDATE_READY" })
	const worktree = started.json.worktree as string
	write(worktree, "projects/new-project/README.md", "# New project\n")

	const finished = finish(vault, state, worktree, "docs: create new project")
	expect(finished.exitCode).toBe(0)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED" })
	const canonicalHead = git(vault, "rev-parse", "HEAD")
	expect(canonicalHead).not.toBe(initialHead)
	expect(git(vault, "rev-list", "--count", `${initialHead}..${canonicalHead}`)).toBe("1")
	expect(git(vault, "diff-tree", "--no-commit-id", "--name-only", "-r", canonicalHead)).toBe(
		"projects/new-project/README.md",
	)
	expect(readFileSync(join(vault, "projects/new-project/README.md"), "utf8")).toBe("# New project\n")
	expect(() => readFileSync(worktree)).toThrow()
})

test("the same journey updates an existing goal note", () => {
	const { vault, state } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")

	const finished = finish(vault, state, worktree, "docs: complete demo goal")
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED" })
	expect(readFileSync(join(vault, "projects/demo/GOAL.md"), "utf8")).toContain("Completed")
})

test("checker failure preserves the uncommitted candidate and canonical head", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["BROKEN"])
	const worktree = started.json.worktree as string
	write(worktree, "BROKEN", "fail\n")

	const finished = finish(vault, state, worktree)
	expect(finished.exitCode).toBe(1)
	expect(finished.json).toMatchObject({
		ok: false,
		code: "CHECK_FAILED",
		changedState: "partial",
		worktree,
	})
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(readFileSync(join(worktree, "BROKEN"), "utf8")).toBe("fail\n")
})

test("an out-of-scope change is preserved without touching canonical main", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	write(worktree, "unexpected.md", "outside scope\n")

	const finished = finish(vault, state, worktree)
	expect(finished.json).toMatchObject({ ok: false, code: "PATH_SET_MISMATCH", worktree })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(readFileSync(join(worktree, "unexpected.md"), "utf8")).toBe("outside scope\n")
})

test("dirty canonical state preserves a committed candidate for a safe retry", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	write(vault, "README.md", "# Nathan's staged draft\n")
	git(vault, "add", "--", "README.md")
	write(vault, "personal-draft.md", "Nathan's work\n")
	const originalStatus = git(vault, "status", "--short")

	const blocked = finish(vault, state, worktree)
	expect(blocked.json).toMatchObject({ ok: false, code: "CANONICAL_NOT_READY", worktree })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(readFileSync(join(vault, "personal-draft.md"), "utf8")).toBe("Nathan's work\n")
	expect(git(vault, "status", "--short")).toBe(originalStatus)
	const candidateCommit = git(worktree, "rev-parse", "HEAD")
	expect(candidateCommit).not.toBe(initialHead)

	git(vault, "restore", "--staged", "README.md")
	write(vault, "README.md", "# Fixture vault\n")
	rmSync(join(vault, "personal-draft.md"))
	const retried = finish(vault, state, worktree)
	expect(retried.json).toMatchObject({ ok: true, code: "INTEGRATED", commit: candidateCommit })
	expect(git(vault, "rev-list", "--count", `${initialHead}..main`)).toBe("1")
})

test("a live integration lock preserves the committed candidate for retry", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	const lock = join(vault, ".git", "vault-note-commits.lock")
	mkdirSync(lock)
	write(lock, "owner.json", `${JSON.stringify({ schemaVersion: 1, runId: "another", pid: process.pid })}\n`)

	const blocked = finish(vault, state, worktree)
	expect(blocked.json).toMatchObject({ ok: false, code: "INTEGRATION_BUSY", worktree })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	const candidateCommit = git(worktree, "rev-parse", "HEAD")
	expect(candidateCommit).not.toBe(initialHead)

	rmSync(lock, { recursive: true })
	const retried = finish(vault, state, worktree)
	expect(retried.json).toMatchObject({ ok: true, code: "INTEGRATED", commit: candidateCommit })
})

test("begin rejects a path through an existing symbolic link", () => {
	const { root, vault, state, initialHead } = fixture()
	const outside = join(root, "outside")
	mkdirSync(outside)
	symlinkSync(outside, join(vault, "linked"))

	const started = begin(vault, state, ["linked/note.md"])
	expect(started.json).toMatchObject({ ok: false, code: "SYMLINK_PATH_UNSUPPORTED" })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(() => readFileSync(join(outside, "note.md"))).toThrow()
})

test("overlapping candidates cannot overwrite a main that already moved", () => {
	const { vault, state, initialHead } = fixture()
	const first = begin(vault, state, ["projects/first/README.md"])
	const second = begin(vault, state, ["projects/second/README.md"])
	const firstWorktree = first.json.worktree as string
	const secondWorktree = second.json.worktree as string
	write(firstWorktree, "projects/first/README.md", "# First\n")
	write(secondWorktree, "projects/second/README.md", "# Second\n")

	expect(finish(vault, state, firstWorktree, "docs: add first project").json).toMatchObject({
		ok: true,
		code: "INTEGRATED",
	})
	const blocked = finish(vault, state, secondWorktree, "docs: add second project")
	expect(blocked.json).toMatchObject({ ok: false, code: "MAIN_MOVED", worktree: secondWorktree })
	expect(readFileSync(join(vault, "projects/first/README.md"), "utf8")).toBe("# First\n")
	expect(() => readFileSync(join(vault, "projects/second/README.md"))).toThrow()
	expect(git(vault, "rev-list", "--count", `${initialHead}..main`)).toBe("1")
	expect(git(secondWorktree, "rev-list", "--count", `${initialHead}..HEAD`)).toBe("1")
})

test("repeating finish after successful cleanup cannot duplicate the commit", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")

	expect(finish(vault, state, worktree).json).toMatchObject({ ok: true, code: "INTEGRATED" })
	const repeated = finish(vault, state, worktree)
	expect(repeated.json).toMatchObject({ ok: false, code: "CANDIDATE_NOT_FOUND" })
	expect(git(vault, "rev-list", "--count", `${initialHead}..main`)).toBe("1")
})
