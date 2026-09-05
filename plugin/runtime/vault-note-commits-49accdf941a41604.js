// @bun
// packages/vault-note-commits/src/main.ts
import { createHash, randomUUID } from "crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
var schemaVersion = 1;
var manifestName = "vault-note-commit.json";
var runIdPattern = /^vnc-[a-f0-9]{32}$/;

class Refusal extends Error {
  result;
  constructor(result) {
    super(result.code);
    this.result = result;
  }
}
function outcome(ok, command, code, runId, nextAction, extra = {}) {
  return {
    schemaVersion,
    ok,
    command,
    code,
    runId,
    changedState: "none",
    sideEffects: [],
    retrySafe: true,
    nextAction,
    ...extra
  };
}
function refuse(command, code, runId, nextAction, extra = {}) {
  throw new Refusal(outcome(false, command, code, runId, nextAction, extra));
}
function run(command, cwd) {
  const child = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  return {
    exitCode: child.exitCode,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr)
  };
}
function git(cwd, args, command, runId) {
  const result = run(["git", "--no-optional-locks", ...args], cwd);
  if (result.exitCode !== 0) {
    refuse(command, "GIT_FAILED", runId, command === "begin" ? "Confirm the vault is a healthy local Git checkout, then retry begin." : "Inspect the preserved candidate and local Git state before retrying finish.", command === "finish" ? { changedState: "partial", sideEffects: ["candidate-worktree-preserved"], retrySafe: false } : {});
  }
  return result.stdout.trim();
}
function splitNul(value) {
  return value.split("\x00").filter(Boolean);
}
function flags(args, allowed) {
  const parsed = new Map;
  for (let index = 0;index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !allowed.has(key) || value.startsWith("--")) {
      refuse("help", "INVALID_USAGE", null, "Run vault-note-commits --help and use the documented flags.");
    }
    parsed.set(key, [...parsed.get(key) ?? [], value]);
  }
  return parsed;
}
function one(parsed, key, command) {
  const values = parsed.get(key) ?? [];
  const value = values[0];
  if (values.length !== 1 || value === undefined) {
    refuse(command, "INVALID_USAGE", null, `Provide ${key} exactly once.`);
  }
  return value;
}
function canonicalVault(input) {
  let vault;
  try {
    vault = realpathSync(input);
  } catch {
    refuse("begin", "VAULT_NOT_FOUND", null, "Provide an existing vault checkout with --vault.");
  }
  const top = git(vault, ["rev-parse", "--show-toplevel"], "begin", null);
  if (realpathSync(top) !== vault || git(vault, ["branch", "--show-current"], "begin", null) !== "main") {
    refuse("begin", "NOT_CANONICAL_MAIN", null, "Run begin from the root checkout while it has main checked out.");
  }
  return vault;
}
function admittedPath(vault, input) {
  if (!input || isAbsolute(input)) {
    refuse("begin", "INVALID_PATH", null, "Use non-empty paths relative to the vault root.");
  }
  const target = resolve(vault, input);
  const path = relative(vault, target);
  if (!path || path === ".." || path.startsWith(`..${sep}`)) {
    refuse("begin", "INVALID_PATH", null, "Keep every admitted path inside the vault.");
  }
  let cursor = vault;
  for (const component of path.split(sep)) {
    cursor = join(cursor, component);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      refuse("begin", "SYMLINK_PATH_UNSUPPORTED", null, "Use a path whose existing components are not symbolic links.");
    }
  }
  return path;
}
function stateRoot() {
  const root = process.env.XDG_STATE_HOME ?? (process.env.HOME ? join(process.env.HOME, ".local", "state") : "");
  if (!root)
    refuse("begin", "STATE_HOME_MISSING", null, "Set XDG_STATE_HOME or HOME, then retry begin.");
  return join(root, "my-second-brain", "vault-note-commits");
}
function manifestPath(worktree, command, runId) {
  const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"], command, runId);
  return join(gitDirectory, manifestName);
}
function begin(args) {
  const parsed = flags(args, new Set(["--vault", "--path"]));
  const vault = canonicalVault(one(parsed, "--vault", "begin"));
  const requested = parsed.get("--path") ?? [];
  if (requested.length === 0)
    refuse("begin", "INVALID_USAGE", null, "Provide at least one --path.");
  const paths = [...new Set(requested.map((path) => admittedPath(vault, path)))].sort();
  const runId = `vnc-${randomUUID().replaceAll("-", "")}`;
  const vaultId = createHash("sha256").update(vault).digest("hex").slice(0, 16);
  const requestedWorktree = join(stateRoot(), vaultId, runId);
  mkdirSync(dirname(requestedWorktree), { recursive: true, mode: 448 });
  chmodSync(stateRoot(), 448);
  chmodSync(dirname(requestedWorktree), 448);
  const baseCommit = git(vault, ["rev-parse", "main"], "begin", runId);
  git(vault, ["worktree", "add", "--detach", requestedWorktree, baseCommit], "begin", runId);
  const worktree = realpathSync(requestedWorktree);
  const manifest = {
    schemaVersion,
    runId,
    vault,
    worktree,
    commonGitDirectory: git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "begin", runId),
    baseCommit,
    paths
  };
  const target = manifestPath(worktree, "begin", runId);
  writeFileSync(target, `${JSON.stringify(manifest)}
`, { mode: 384 });
  chmodSync(target, 384);
  return outcome(true, "begin", "CANDIDATE_READY", runId, "Edit only the admitted paths in the returned worktree, then run finish.", {
    changedState: "partial",
    sideEffects: ["candidate-worktree-created"],
    worktree,
    paths
  });
}
function readManifest(input) {
  let worktree;
  try {
    worktree = realpathSync(input);
  } catch {
    refuse("finish", "CANDIDATE_NOT_FOUND", null, "Run begin to create a new candidate.");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath(worktree, "finish", null), "utf8"));
  } catch (error) {
    if (error instanceof Refusal)
      throw error;
    refuse("finish", "MANIFEST_INVALID", null, "Preserve the candidate and inspect its Git metadata before continuing.", {
      changedState: "partial",
      sideEffects: ["candidate-worktree-preserved"],
      retrySafe: false,
      worktree
    });
  }
  if (manifest.schemaVersion !== schemaVersion || !runIdPattern.test(manifest.runId) || manifest.worktree !== worktree || !Array.isArray(manifest.paths) || git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "finish", manifest.runId) !== manifest.commonGitDirectory) {
    refuse("finish", "MANIFEST_INVALID", manifest.runId ?? null, "Preserve the candidate and inspect its Git metadata before continuing.", {
      changedState: "partial",
      sideEffects: ["candidate-worktree-preserved"],
      retrySafe: false,
      worktree
    });
  }
  return manifest;
}
function changedPaths(worktree, baseCommit, runId) {
  const tracked = splitNul(git(worktree, ["diff", "--name-only", "-z", baseCommit, "--"], "finish", runId));
  const untracked = splitNul(git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], "finish", runId));
  return [...new Set([...tracked, ...untracked])].sort();
}
function samePaths(actual, admitted) {
  return actual.length === admitted.length && actual.every((path, index) => path === admitted[index]);
}
function preserve(manifest, code, nextAction, retrySafe = true, commit) {
  refuse("finish", code, manifest.runId, nextAction, {
    changedState: "partial",
    sideEffects: [commit ? "candidate-commit-preserved" : "candidate-worktree-preserved"],
    retrySafe,
    worktree: manifest.worktree,
    commit,
    paths: manifest.paths
  });
}
function checkCandidate(manifest) {
  const result = run([process.execPath, "run", "check"], manifest.worktree);
  if (result.exitCode !== 0) {
    preserve(manifest, "CHECK_FAILED", "Fix the admitted files in the candidate, then retry finish.");
  }
}
function candidateCommit(manifest, message) {
  const head = git(manifest.worktree, ["rev-parse", "HEAD"], "finish", manifest.runId);
  if (head !== manifest.baseCommit) {
    if (git(manifest.worktree, ["status", "--porcelain"], "finish", manifest.runId)) {
      preserve(manifest, "CANDIDATE_CHANGED_AFTER_COMMIT", "Inspect and restore the candidate to its committed state before retrying.", false, head);
    }
    const count = git(manifest.worktree, ["rev-list", "--count", `${manifest.baseCommit}..HEAD`], "finish", manifest.runId);
    const committed = splitNul(git(manifest.worktree, ["diff", "--name-only", "-z", `${manifest.baseCommit}..HEAD`, "--"], "finish", manifest.runId)).sort();
    if (count !== "1" || !samePaths(committed, manifest.paths)) {
      preserve(manifest, "CANDIDATE_HISTORY_INVALID", "Inspect the candidate history before continuing.", false, head);
    }
    return head;
  }
  const changed = changedPaths(manifest.worktree, manifest.baseCommit, manifest.runId);
  if (!samePaths(changed, manifest.paths)) {
    preserve(manifest, "PATH_SET_MISMATCH", "Change exactly the paths admitted by begin, then retry finish.");
  }
  checkCandidate(manifest);
  git(manifest.worktree, ["add", "--", ...manifest.paths], "finish", manifest.runId);
  git(manifest.worktree, ["commit", "-m", message], "finish", manifest.runId);
  return git(manifest.worktree, ["rev-parse", "HEAD"], "finish", manifest.runId);
}
function ownerIsLive(path) {
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    if (!Number.isInteger(owner.pid) || !owner.pid)
      return true;
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code !== "ESRCH";
  }
}
function withLock(manifest, action) {
  const lock = join(manifest.commonGitDirectory, "vault-note-commits.lock");
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      mkdirSync(lock, { mode: 448 });
      writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ schemaVersion, runId: manifest.runId, pid: process.pid })}
`, {
        mode: 384
      });
      try {
        return action();
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if (error instanceof Refusal)
        throw error;
      if (existsSync(lock) && !ownerIsLive(lock)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      preserve(manifest, "INTEGRATION_BUSY", "Wait for the active finisher to release the local integration lock, then retry.");
    }
  }
  return preserve(manifest, "INTEGRATION_BUSY", "Remove the stale integration lock after inspection, then retry.", false);
}
function integrate(manifest, commit) {
  return withLock(manifest, () => {
    const vault = realpathSync(manifest.vault);
    if (git(vault, ["branch", "--show-current"], "finish", manifest.runId) !== "main" || git(vault, ["status", "--porcelain"], "finish", manifest.runId)) {
      preserve(manifest, "CANONICAL_NOT_READY", "Restore a clean canonical main checkout, then retry finish.", true, commit);
    }
    if (git(vault, ["rev-parse", "HEAD"], "finish", manifest.runId) !== manifest.baseCommit) {
      preserve(manifest, "MAIN_MOVED", "Start a fresh candidate from the current main and reapply the admitted note change.", false, commit);
    }
    const merged = run(["git", "--no-optional-locks", "merge", "--ff-only", commit], vault);
    if (merged.exitCode !== 0 || git(vault, ["rev-parse", "HEAD"], "finish", manifest.runId) !== commit) {
      preserve(manifest, "INTEGRATION_UNPROVED", "Inspect canonical main and the candidate before taking another action.", false, commit);
    }
    const removed = run(["git", "--no-optional-locks", "worktree", "remove", "--force", manifest.worktree], vault);
    return outcome(true, "finish", "INTEGRATED", manifest.runId, removed.exitCode === 0 ? "Run remote sync separately when you want to publish main." : "The commit is integrated; remove the preserved candidate worktree when convenient.", {
      changedState: "complete",
      sideEffects: removed.exitCode === 0 ? ["canonical-main-fast-forwarded", "candidate-worktree-removed"] : ["canonical-main-fast-forwarded"],
      retrySafe: false,
      worktree: manifest.worktree,
      commit,
      paths: manifest.paths
    });
  });
}
function finish(args) {
  const parsed = flags(args, new Set(["--worktree", "--message"]));
  const worktree = one(parsed, "--worktree", "finish");
  const message = one(parsed, "--message", "finish").trim();
  if (!message || message.includes(`
`))
    refuse("finish", "INVALID_USAGE", null, "Provide one non-empty commit subject with --message.");
  const manifest = readManifest(worktree);
  return integrate(manifest, candidateCommit(manifest, message));
}
var usage = `Vault Note Commits

Usage:
  vault-note-commits begin --vault <path> --path <relative-path> [--path <relative-path>...] [--json]
  vault-note-commits finish --worktree <path> --message <subject> [--json]

begin creates a detached candidate worktree from local main. finish admits exactly the declared paths,
runs bun run check, creates one commit, and fast-forwards a clean, unchanged canonical main checkout.
Remote sync is a separate operation.`;
function main() {
  const raw = process.argv.slice(2);
  const json = raw.includes("--json");
  const args = raw.filter((argument) => argument !== "--json");
  try {
    const command = args.shift();
    if (command === "--help" || command === "-h" || command === undefined) {
      console.log(usage);
      return;
    }
    const result = command === "begin" ? begin(args) : command === "finish" ? finish(args) : refuse("help", "INVALID_USAGE", null, "Run vault-note-commits --help.");
    console.log(json ? JSON.stringify(result) : `${result.code}: ${result.nextAction}`);
  } catch (error) {
    const result = error instanceof Refusal ? error.result : outcome(false, "help", "UNEXPECTED_FAILURE", null, "Preserve any candidate worktree and inspect the local error before retrying.", { retrySafe: false });
    if (json)
      console.log(JSON.stringify(result));
    else
      console.error(`${result.code}: ${result.nextAction}`);
    process.exitCode = 1;
  }
}
main();
