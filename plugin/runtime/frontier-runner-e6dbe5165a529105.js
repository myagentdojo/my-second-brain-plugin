// @bun
// packages/frontier-runner/src/main.ts
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import { createHash, randomUUID } from "crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
var schemaVersion = 1;
var receiptSchemaVersion = 1;
var maximumPromptBytes = 32 * 1024;
var maximumResponseBytes = 1024;
var unitIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var runIdPattern = /^fr-[a-f0-9]{16}$/;
var sha256Pattern = /^[a-f0-9]{64}$/;
var completedStatuses = new Set(["idle", "done"]);
var agentStatuses = new Set(["idle", "working", "blocked", "done", "unknown"]);
var promptUncertainCodes = new Set(["timeout", "agent_prompt_stalled"]);
var responseFailedCodes = new Set(["agent_not_found", "agent_not_ready", "invalid_key", "agent_send_keys_failed"]);
var effectOutcomeValues = ["planned", "unknown", "succeeded", "timed_out", "failed"];
var effectOutcomes = new Set(effectOutcomeValues);
var runStateValues = [
  "prepared",
  "starting",
  "timed_out",
  "blocked",
  "responded",
  "settled_unproved",
  "completed",
  "review_starting",
  "review_timed_out",
  "review_unproved",
  "reviewed",
  "review_breached",
  "decision_starting",
  "decided",
  "cleanup_pending",
  "cleaned",
  "failed"
];
var runStates = new Set(runStateValues);
var initialEffectNames = [
  "editorPane",
  "editorLaunch",
  "browserPane",
  "browserLaunch",
  "workerPane",
  "workerStart",
  "promptDispatch"
];
var effectNameValues = [
  ...initialEffectNames,
  "responseDispatch",
  "resumeWait",
  "reviewerPane",
  "reviewerStart",
  "reviewPromptDispatch",
  "reviewWait",
  "decisionRecord",
  "reviewerPaneClose",
  "workerPaneClose",
  "browserPaneClose",
  "editorPaneClose",
  "cleanupComplete"
];
var effectNames = new Set(effectNameValues);

class FrontierError extends Error {
  code;
  exitCode;
  runId;
  state;
  changedState;
  sideEffects;
  retrySafe;
  nextAction;
  constructor(options) {
    super(options.message);
    this.name = "FrontierError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? 1;
    this.runId = options.runId;
    this.state = options.state;
    this.changedState = options.changedState ?? "none";
    this.sideEffects = options.sideEffects ?? [];
    this.retrySafe = options.retrySafe ?? false;
    this.nextAction = options.nextAction;
  }
}
function help() {
  return `Frontier Runner - one receipt-backed Herdr worker run

Usage:
  frontier-runner run --unit-id ID --workspace PATH --prompt-file PATH \\
    --timeout-ms MS --browser-url URL --result-file RELATIVE_PATH
  frontier-runner respond --run-id ID --response-file PATH
  frontier-runner resume --run-id ID
  frontier-runner review --run-id ID --review-prompt-file PATH
  frontier-runner decide --run-id ID --decision-file PATH
  frontier-runner cleanup --run-id ID
  frontier-runner --help

Commands:
  run      Create one Terminal Code pane, one Chromium pane, and one Codex worker.
  respond  Send one exact private-file response to the recorded blocked worker.
  resume   Reconcile the recorded worker after timeout without resending the prompt.
  review   Start one fresh read-only Codex reviewer for one proved run.
  decide   Record one state-bound accepted or declined operator decision.
  cleanup  Close only the panes recorded as owned by this run.

Output:
  Commands emit one schema-versioned JSON object on stdout. Diagnostics use stderr.
`;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function now() {
  return new Date().toISOString();
}
function jsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function stringField(record, field) {
  const value = record?.[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function parseJson(text) {
  try {
    return jsonObject(JSON.parse(text));
  } catch {
    return;
  }
}
function parseHerdrErrorCode(stderr) {
  for (const line of stderr.trim().split(/\r?\n/).reverse()) {
    const parsed = parseJson(line);
    const error = jsonObject(parsed?.error);
    const code = stringField(error, "code");
    if (code)
      return code;
  }
  return;
}
function emit(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}
`);
}
function emitFailure(command, error) {
  process.stderr.write(`frontier-runner: ${error.message}
repair: ${error.nextAction}
`);
  emit({
    schemaVersion,
    ok: false,
    command,
    code: error.code,
    runId: error.runId,
    state: error.state,
    changedState: error.changedState,
    sideEffects: error.sideEffects,
    retrySafe: error.retrySafe,
    nextAction: error.nextAction
  });
  process.exit(error.exitCode);
}
function parseFlags(arguments_, admitted) {
  const admittedSet = new Set(admitted);
  const values = new Map;
  for (let index = 0;index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || !admittedSet.has(flag)) {
      throw new FrontierError({
        message: `unknown option: ${flag ?? "<missing>"}`,
        code: "USAGE",
        exitCode: 2,
        nextAction: "Run frontier-runner --help and use only the documented flags."
      });
    }
    if (value === undefined || value.startsWith("--")) {
      throw new FrontierError({
        message: `missing value for ${flag}`,
        code: "USAGE",
        exitCode: 2,
        nextAction: `Supply one value after ${flag}.`
      });
    }
    if (values.has(flag)) {
      throw new FrontierError({
        message: `duplicate option: ${flag}`,
        code: "USAGE",
        exitCode: 2,
        nextAction: `Supply ${flag} exactly once.`
      });
    }
    values.set(flag, value);
  }
  return { values };
}
function requiredFlag(flags, flag) {
  const value = flags.values.get(flag);
  if (!value) {
    throw new FrontierError({
      message: `required option is missing: ${flag}`,
      code: "USAGE",
      exitCode: 2,
      nextAction: `Run frontier-runner --help and supply ${flag}.`
    });
  }
  return value;
}
function canonicalDirectory(input) {
  if (!existsSync(input) || !statSync(input).isDirectory()) {
    throw new FrontierError({
      message: `workspace is not an existing directory: ${input}`,
      code: "WORKSPACE_INVALID",
      exitCode: 2,
      nextAction: "Supply one explicitly granted existing workspace directory."
    });
  }
  return realpathSync(input);
}
function isSafeRelativeResultPath(input) {
  if (input.length === 0 || isAbsolute(input) || /[\r\n\u2028\u2029]/.test(input))
    return false;
  const normalized = input.split(/[\\/]/);
  return normalized.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function canonicalResultFile(workspace, input) {
  if (!isSafeRelativeResultPath(input)) {
    throw new FrontierError({
      message: "result file must be a safe workspace-relative path without line breaks or traversal",
      code: "RESULT_FILE_INVALID",
      exitCode: 2,
      nextAction: "Pass the existing fixture file as a relative path inside the granted workspace."
    });
  }
  const candidate = resolve(workspace, input);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new FrontierError({
      message: `result file is not an existing regular file: ${input}`,
      code: "RESULT_FILE_INVALID",
      exitCode: 2,
      nextAction: "Create the disposable fixture file inside the workspace, then retry."
    });
  }
  const path = realpathSync(candidate);
  const relativePath = relative(workspace, path);
  if (!isSafeRelativeResultPath(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new FrontierError({
      message: "result file resolves outside the granted workspace",
      code: "RESULT_FILE_INVALID",
      exitCode: 2,
      nextAction: "Use a non-escaping fixture file inside the granted workspace."
    });
  }
  return { path, relativePath };
}
function promptBytes(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new FrontierError({
      message: `prompt file is not an existing regular file: ${path}`,
      code: "PROMPT_INVALID",
      exitCode: 2,
      nextAction: "Write the bounded prompt to a file and pass that file path."
    });
  }
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > maximumPromptBytes) {
    throw new FrontierError({
      message: `prompt must contain 1 to ${maximumPromptBytes} bytes`,
      code: "PROMPT_INVALID",
      exitCode: 2,
      nextAction: "Use one non-empty bounded prompt no larger than 32 KiB."
    });
  }
  return bytes;
}
function privateReviewPrompt(path) {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new FrontierError({
      message: "review prompt is not an existing non-symlink regular file",
      code: "REVIEW_PROMPT_INVALID",
      exitCode: 2,
      nextAction: "Write the bounded review prompt to one private regular file."
    });
  }
  const mode = statSync(path).mode & 511;
  if ((mode & 63) !== 0 || (mode & 256) === 0) {
    throw new FrontierError({
      message: "review prompt permissions expose it beyond the owner",
      code: "REVIEW_PROMPT_NOT_PRIVATE",
      exitCode: 2,
      nextAction: "Set the review prompt file to owner-only permissions, such as mode 0600."
    });
  }
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > maximumPromptBytes) {
    throw new FrontierError({
      message: `review prompt must contain 1 to ${maximumPromptBytes} bytes`,
      code: "REVIEW_PROMPT_INVALID",
      exitCode: 2,
      nextAction: "Use one non-empty bounded review prompt no larger than 32 KiB."
    });
  }
  return bytes;
}
function privateDecision(path) {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new FrontierError({
      message: "decision file is not an existing non-symlink regular file",
      code: "DECISION_FILE_INVALID",
      exitCode: 2,
      nextAction: "Write exactly accepted or declined followed by one newline to a private regular file."
    });
  }
  const mode = statSync(path).mode & 511;
  if ((mode & 63) !== 0 || (mode & 256) === 0) {
    throw new FrontierError({
      message: "decision file permissions expose it beyond the owner",
      code: "DECISION_FILE_NOT_PRIVATE",
      exitCode: 2,
      nextAction: "Set the decision file to owner-only permissions, such as mode 0600."
    });
  }
  const bytes = readFileSync(path);
  const text = bytes.toString();
  if (text !== `accepted
` && text !== `declined
`) {
    throw new FrontierError({
      message: "decision file must contain exactly accepted or declined followed by one newline",
      code: "DECISION_FILE_INVALID",
      exitCode: 2,
      nextAction: "Replace the file with exactly accepted or declined followed by one trailing newline."
    });
  }
  return {
    classification: text.slice(0, -1),
    fileSha256: sha256(bytes)
  };
}
function workspaceSha256(workspace) {
  const hash = createHash("sha256");
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        hash.update(`directory\x00${relativePath}\x00`);
        visit(path, relativePath);
      } else if (stat.isFile()) {
        hash.update(`file\x00${relativePath}\x00`);
        hash.update(readFileSync(path));
        hash.update("\x00");
      } else if (stat.isSymbolicLink()) {
        hash.update(`symlink\x00${relativePath}\x00${readlinkSync(path)}\x00`);
      } else {
        throw new FrontierError({
          message: `workspace contains an unsupported filesystem entry: ${relativePath}`,
          code: "CANDIDATE_INVALID",
          nextAction: "Remove sockets or other special files from the disposable candidate workspace."
        });
      }
    }
  };
  visit(workspace, "");
  return hash.digest("hex");
}
function responseInput(path) {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new FrontierError({
      message: "response file is not an existing non-symlink regular file",
      code: "RESPONSE_INVALID",
      exitCode: 2,
      nextAction: "Write the exact approved response to one private regular file."
    });
  }
  const mode = statSync(path).mode & 511;
  if ((mode & 63) !== 0 || (mode & 256) === 0) {
    throw new FrontierError({
      message: "response file permissions expose it beyond the owner",
      code: "RESPONSE_FILE_NOT_PRIVATE",
      exitCode: 2,
      nextAction: "Set the response file to owner-only permissions, such as mode 0600."
    });
  }
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > maximumResponseBytes) {
    throw new FrontierError({
      message: `response must contain 1 to ${maximumResponseBytes} bytes`,
      code: "RESPONSE_INVALID",
      exitCode: 2,
      nextAction: "Use one non-empty response no larger than 1 KiB."
    });
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FrontierError({
      message: "response is not valid UTF-8",
      code: "RESPONSE_INVALID",
      exitCode: 2,
      nextAction: "Write one valid UTF-8 response line without control characters."
    });
  }
  if (/\r|\n|\u2028|\u2029|\p{C}/u.test(text)) {
    throw new FrontierError({
      message: "response must be exactly one printable line",
      code: "RESPONSE_INVALID",
      exitCode: 2,
      nextAction: "Remove line breaks and control characters without trimming approved text."
    });
  }
  if (/frontier-result:[a-f0-9]{64}/.test(text)) {
    throw new FrontierError({
      message: "response contains a complete Frontier Runner result marker",
      code: "RESPONSE_MARKER_CONFLICT",
      exitCode: 2,
      nextAction: "Remove the complete marker so echoed input cannot satisfy result proof."
    });
  }
  return {
    sha256: sha256(bytes),
    keys: Array.from(text, (character) => character === " " ? "space" : character)
  };
}
function timeoutValue(input) {
  if (!/^[1-9][0-9]*$/.test(input)) {
    throw new FrontierError({
      message: "timeout must be a positive integer in milliseconds",
      code: "TIMEOUT_INVALID",
      exitCode: 2,
      nextAction: "Supply --timeout-ms between 1 and 3600000."
    });
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value > 3600000) {
    throw new FrontierError({
      message: "timeout is outside the supported range",
      code: "TIMEOUT_INVALID",
      exitCode: 2,
      nextAction: "Supply --timeout-ms between 1 and 3600000."
    });
  }
  return value;
}
function browserUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new FrontierError({
      message: "browser URL is invalid",
      code: "BROWSER_URL_INVALID",
      exitCode: 2,
      nextAction: "Supply one explicit http or https URL."
    });
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new FrontierError({
      message: `browser URL protocol is unsupported: ${parsed.protocol}`,
      code: "BROWSER_URL_INVALID",
      exitCode: 2,
      nextAction: "Supply one explicit http or https URL."
    });
  }
  return parsed;
}
function requireInsideHerdr() {
  if (process.env.HERDR_ENV !== "1") {
    throw new FrontierError({
      message: "this command is not running inside Herdr",
      code: "HERDR_REQUIRED",
      nextAction: "Invoke Frontier Runner from a Herdr-managed pane."
    });
  }
  for (const variable of ["HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"]) {
    if (!process.env[variable]) {
      throw new FrontierError({
        message: `Herdr caller context is missing: ${variable}`,
        code: "HERDR_CONTEXT_MISSING",
        nextAction: "Invoke from a live Herdr-managed pane process, then retry."
      });
    }
  }
}
function requireTools(tools) {
  for (const tool of tools) {
    if (!Bun.which(tool)) {
      throw new FrontierError({
        message: `required command is missing: ${tool}`,
        code: "TOOL_MISSING",
        nextAction: `Install or expose ${tool} on PATH inside Herdr, then retry.`
      });
    }
  }
}
function proveToolContract(tool, expected, workspace) {
  const result = Bun.spawnSync({
    cmd: [tool, "--help"],
    cwd: workspace,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe"
  });
  const helpText = `${result.stdout.toString()}
${result.stderr.toString()}`;
  if (result.exitCode !== 0 || !expected.test(helpText)) {
    throw new FrontierError({
      message: `installed ${tool} does not expose the required launch contract`,
      code: "TOOL_INCOMPATIBLE",
      nextAction: tool === "tode" ? "Install a Terminal Code version whose help supports opening the current folder, then retry." : "Install a Terminal Browser version whose help supports `open <url>`, then retry."
    });
  }
}
function runHerdr(arguments_, cwd) {
  const result = Bun.spawnSync({
    cmd: ["herdr", ...arguments_],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe"
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return {
    exitCode: result.exitCode ?? 1,
    stdout,
    stderr,
    json: parseJson(stdout.trim()),
    errorCode: parseHerdrErrorCode(stderr)
  };
}
function requireHerdrSuccess(result, code, repair) {
  if (result.exitCode !== 0) {
    throw new FrontierError({
      message: `Herdr command failed${result.errorCode ? `: ${result.errorCode}` : ""}`,
      code,
      nextAction: repair
    });
  }
  if (!result.json) {
    throw new FrontierError({
      message: "Herdr returned malformed JSON",
      code: "HERDR_PROTOCOL_INVALID",
      nextAction: "Run the relevant Herdr command directly and verify client/server compatibility."
    });
  }
  return result.json;
}
function herdrResponseResult(result, expectedType) {
  if (result.exitCode !== 0 || !result.json)
    return;
  const response = jsonObject(result.json.result);
  return stringField(response, "type") === expectedType ? response : undefined;
}
function paneRunAccepted(result) {
  if (result.exitCode !== 0)
    return false;
  if (result.stdout.trim() === "" && result.stderr.trim() === "")
    return true;
  return Boolean(herdrResponseResult(result, "ok"));
}
function responsePaneMatches(response, expected) {
  const pane = jsonObject(response?.pane);
  const paneId = stringField(pane, "pane_id");
  return Boolean(paneId && (expected.paneId === undefined || paneId === expected.paneId) && stringField(pane, "workspace_id") === expected.workspaceId && stringField(pane, "tab_id") === expected.tabId);
}
function responseAgentMatches(response, receipt) {
  const agent = jsonObject(response?.agent);
  return Boolean(receipt.resources.workerPaneId && stringField(agent, "name") === receipt.resources.workerName && stringField(agent, "pane_id") === receipt.resources.workerPaneId && stringField(agent, "workspace_id") === receipt.workspace.workspaceId && stringField(agent, "tab_id") === receipt.workspace.tabId);
}
function responseReviewerMatches(response, receipt) {
  const agent = jsonObject(response?.agent);
  return Boolean(receipt.resources.reviewerName && receipt.resources.reviewerPaneId && stringField(agent, "name") === receipt.resources.reviewerName && stringField(agent, "pane_id") === receipt.resources.reviewerPaneId && stringField(agent, "workspace_id") === receipt.workspace.workspaceId && stringField(agent, "tab_id") === receipt.workspace.tabId);
}
function currentPane(workspace) {
  const json = requireHerdrSuccess(runHerdr(["pane", "current", "--current"], workspace), "HERDR_CURRENT_FAILED", "Run herdr pane current --current and repair the current session before retrying.");
  const result = jsonObject(json.result);
  if (stringField(result, "type") !== "pane_current") {
    throw new FrontierError({
      message: "Herdr current pane returned an unexpected response type",
      code: "HERDR_CURRENT_INVALID",
      nextAction: "Run herdr pane current --current and verify the installed client/server schema."
    });
  }
  const pane = jsonObject(result?.pane);
  const paneId = stringField(pane, "pane_id");
  const workspaceId = stringField(pane, "workspace_id");
  const tabId = stringField(pane, "tab_id");
  const foregroundCwd = stringField(pane, "foreground_cwd");
  const agentSession = jsonObject(pane?.agent_session);
  const sessionId = stringField(agentSession, "value");
  if (!paneId || !workspaceId || !tabId || !foregroundCwd || stringField(pane, "agent") !== "codex" || stringField(agentSession, "agent") !== "codex" || stringField(agentSession, "kind") !== "id" || stringField(agentSession, "source") !== "herdr:codex" || !sessionId) {
    throw new FrontierError({
      message: "Herdr current pane omitted the recognised Codex Controller identity or pane context",
      code: "HERDR_CURRENT_INVALID",
      nextAction: "Use a recognised Codex Controller pane whose identity and foreground cwd Herdr can resolve."
    });
  }
  if (paneId !== process.env.HERDR_PANE_ID) {
    throw new FrontierError({
      message: "Herdr current pane conflicts with inherited caller identity",
      code: "HERDR_CONTEXT_CONFLICT",
      nextAction: "Invoke again from the intended managed pane without changing focus-based targets."
    });
  }
  if (workspaceId !== process.env.HERDR_WORKSPACE_ID || tabId !== process.env.HERDR_TAB_ID) {
    throw new FrontierError({
      message: "Herdr current pane conflicts with inherited workspace or tab identity",
      code: "HERDR_CONTEXT_CONFLICT",
      nextAction: "Invoke again from the original Herdr workspace and tab."
    });
  }
  if (canonicalDirectory(foregroundCwd) !== workspace) {
    throw new FrontierError({
      message: "granted workspace does not match the calling pane foreground cwd",
      code: "WORKSPACE_CONFLICT",
      exitCode: 2,
      nextAction: "Invoke from a pane whose foreground cwd is the explicitly granted workspace."
    });
  }
  return { paneId, workspaceId, tabId, foregroundCwd: workspace, sessionId };
}
function stateRoot() {
  const base = process.env.XDG_STATE_HOME ? resolve(process.env.XDG_STATE_HOME) : process.env.HOME ? join(resolve(process.env.HOME), ".local", "state") : undefined;
  if (!base) {
    throw new FrontierError({
      message: "no private state home is available",
      code: "STATE_HOME_MISSING",
      nextAction: "Set XDG_STATE_HOME or HOME to a private writable location."
    });
  }
  return join(base, "my-second-brain-vault", "frontier-runner");
}
function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 448 });
  chmodSync(path, 448);
}
function receiptPath(runId) {
  if (!runIdPattern.test(runId)) {
    throw new FrontierError({
      message: `run id is invalid: ${runId}`,
      code: "RUN_ID_INVALID",
      exitCode: 2,
      nextAction: "Use the runId returned by Frontier Runner."
    });
  }
  return join(stateRoot(), `${runId}.json`);
}
function createReceipt(receipt) {
  const path = receiptPath(receipt.runId);
  ensurePrivateDirectory(dirname(path));
  try {
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}
`, { flag: "wx", mode: 384 });
    chmodSync(path, 384);
  } catch (error) {
    if (existsSync(path)) {
      throw new FrontierError({
        message: `an active or completed receipt already exists for ${receipt.runId}`,
        code: "RUN_ALREADY_EXISTS",
        runId: receipt.runId,
        nextAction: `Run frontier-runner resume --run-id ${receipt.runId}, or use a new unit ID after cleanup.`
      });
    }
    throw error;
  }
}
function writeReceipt(receipt) {
  const path = receiptPath(receipt.runId);
  ensurePrivateDirectory(dirname(path));
  receipt.updatedAt = now();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}
`, {
      flag: "wx",
      mode: 384
    });
    chmodSync(temporary, 384);
    renameSync(temporary, path);
    chmodSync(path, 384);
  } finally {
    if (existsSync(temporary))
      rmSync(temporary);
  }
}
function readReceipt(runId) {
  const path = receiptPath(runId);
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new FrontierError({
      message: `receipt does not exist: ${runId}`,
      code: "RECEIPT_MISSING",
      exitCode: 2,
      runId,
      nextAction: "Use the runId returned by the original Frontier Runner run."
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new FrontierError({
      message: `receipt is malformed: ${runId}`,
      code: "RECEIPT_INVALID",
      runId,
      nextAction: `Inspect the private receipt at ${path}; do not rerun the worker until it is reconciled.`
    });
  }
  if (!isReceipt(parsed) || parsed.runId !== runId) {
    throw new FrontierError({
      message: `receipt identity or schema is invalid: ${runId}`,
      code: "RECEIPT_INVALID",
      runId,
      nextAction: `Inspect the private receipt at ${path}; do not rerun the worker until it is reconciled.`
    });
  }
  return parsed;
}
function receiptHasRunResources(receipt) {
  return Boolean(receipt.resources.editorPaneId && receipt.resources.browserPaneId && receipt.resources.workerPaneId);
}
function effectIs(receipt, effect, ...outcomes) {
  const outcome = receipt.effects[effect]?.outcome;
  return outcome !== undefined && outcomes.includes(outcome);
}
function splitResourceInvariants(receipt) {
  for (const [effect, resource] of [
    ["editorPane", "editorPaneId"],
    ["browserPane", "browserPaneId"],
    ["workerPane", "workerPaneId"]
  ]) {
    const hasResource = typeof receipt.resources[resource] === "string";
    if (effectIs(receipt, effect, "succeeded") !== hasResource)
      return false;
  }
  return true;
}
function completedRunEffects(receipt) {
  return receiptHasRunResources(receipt) && effectIs(receipt, "editorPane", "succeeded") && effectIs(receipt, "editorLaunch", "succeeded") && effectIs(receipt, "browserPane", "succeeded") && effectIs(receipt, "browserLaunch", "succeeded") && effectIs(receipt, "workerPane", "succeeded") && effectIs(receipt, "workerStart", "succeeded") && effectIs(receipt, "promptDispatch", "succeeded", "timed_out");
}
function responseEffectValid(receipt) {
  const effect = receipt.effects.responseDispatch;
  if (!receipt.response && !effect)
    return true;
  return Boolean(receipt.response && sha256Pattern.test(receipt.response.sha256) && effect && effect.outcome !== "planned");
}
function completedObservationValid(receipt) {
  const resultSha256 = receipt.observation?.resultSha256 ?? "";
  return completedRunEffects(receipt) && completedStatuses.has(receipt.observation?.agentStatus ?? "") && sha256Pattern.test(resultSha256) && resultSha256 !== receipt.inputs.resultBeforeSha256 && receipt.observation?.resultMarkerSha256 === sha256(`frontier-result:${resultSha256}`);
}
function reviewRecordValid(receipt) {
  if (!receipt.review)
    return false;
  if (!sha256Pattern.test(receipt.review.promptSha256) || !sha256Pattern.test(receipt.review.candidateBeforeSha256) || receipt.review.candidateAfterSha256 !== undefined && !sha256Pattern.test(receipt.review.candidateAfterSha256) || receipt.review.verdictMarkerSha256 !== undefined && !sha256Pattern.test(receipt.review.verdictMarkerSha256) || receipt.review.verdict !== undefined && !["approve", "request_changes", "reject", "cancelled"].includes(receipt.review.verdict)) {
    return false;
  }
  return Boolean(receipt.resources.reviewerName && completedObservationValid(receipt) && receipt.effects.reviewerPane && receipt.effects.reviewerStart && receipt.effects.reviewPromptDispatch);
}
function decisionRecordValid(receipt) {
  const decision = receipt.decision;
  const review = receipt.review;
  if (!decision || !review)
    return false;
  return Boolean(["accepted", "declined"].includes(decision.classification) && sha256Pattern.test(decision.fileSha256) && decision.submissionAttempt === 1 && decision.runId === receipt.runId && decision.candidateSha256 === review.candidateBeforeSha256 && decision.candidateSha256 === review.candidateAfterSha256 && decision.reviewerName === receipt.resources.reviewerName && decision.verdict === "approve" && review.verdict === "approve" && decision.verdictMarkerSha256 === review.verdictMarkerSha256 && decision.controller.workspaceId === receipt.workspace.workspaceId && decision.controller.tabId === receipt.workspace.tabId && decision.controller.paneId === receipt.workspace.callerPaneId && decision.controller.sessionId.length > 0 && decision.submittedAt.length > 0);
}
function receiptStateInvariants(receipt) {
  if (!initialEffectNames.every((effect) => receipt.effects[effect] !== undefined))
    return false;
  if (!splitResourceInvariants(receipt))
    return false;
  if (!responseEffectValid(receipt))
    return false;
  if (receipt.review && !reviewRecordValid(receipt))
    return false;
  if (receipt.decision && !decisionRecordValid(receipt))
    return false;
  if (receipt.state === "prepared") {
    return !receiptHasRunResources(receipt) && !receipt.response && !receipt.effects.responseDispatch && initialEffectNames.every((effect) => effectIs(receipt, effect, "planned"));
  }
  if (receipt.state === "timed_out") {
    const promptTimedOut = completedRunEffects(receipt) && (effectIs(receipt, "promptDispatch", "timed_out") && promptUncertainCodes.has(receipt.effects.promptDispatch?.code ?? "") || effectIs(receipt, "promptDispatch", "succeeded") && effectIs(receipt, "resumeWait", "timed_out") && receipt.effects.resumeWait?.code === "timeout");
    const responseTimedOut = completedRunEffects(receipt) && effectIs(receipt, "responseDispatch", "timed_out") && receipt.effects.responseDispatch?.code === "timeout";
    return promptTimedOut || responseTimedOut;
  }
  if (receipt.state === "blocked") {
    return completedRunEffects(receipt) && receipt.observation?.agentStatus === "blocked" && !effectIs(receipt, "responseDispatch", "succeeded");
  }
  if (receipt.state === "responded") {
    return completedRunEffects(receipt) && effectIs(receipt, "responseDispatch", "succeeded");
  }
  if (receipt.state === "settled_unproved") {
    return completedRunEffects(receipt) && completedStatuses.has(receipt.observation?.agentStatus ?? "") && sha256Pattern.test(receipt.observation?.resultSha256 ?? "") && receipt.observation?.resultMarkerSha256 === undefined;
  }
  if (receipt.state === "completed") {
    return completedObservationValid(receipt) && !receipt.review;
  }
  if (receipt.state === "review_starting" || receipt.state === "review_timed_out" || receipt.state === "review_unproved" || receipt.state === "reviewed" || receipt.state === "review_breached") {
    if (!reviewRecordValid(receipt))
      return false;
    if (receipt.state === "reviewed") {
      return Boolean(receipt.review?.verdict && receipt.review.verdictMarkerSha256 && receipt.review.candidateAfterSha256 === receipt.review.candidateBeforeSha256);
    }
    if (receipt.state === "review_breached") {
      return Boolean(receipt.review?.candidateAfterSha256 && receipt.review.candidateAfterSha256 !== receipt.review.candidateBeforeSha256 && !receipt.review.verdict);
    }
    return !receipt.review?.verdict;
  }
  if (receipt.state === "decision_starting" || receipt.state === "decided") {
    if (!decisionRecordValid(receipt))
      return false;
    if (receipt.state === "decision_starting") {
      return !receipt.decision?.recordedAt && effectIs(receipt, "decisionRecord", "planned", "unknown");
    }
    return Boolean(receipt.decision?.recordedAt && effectIs(receipt, "decisionRecord", "succeeded"));
  }
  if (receipt.state === "cleanup_pending" || receipt.state === "cleaned") {
    for (const splitEffect of ["editorPane", "browserPane", "workerPane"]) {
      if (effectIs(receipt, splitEffect, "unknown"))
        return false;
    }
    if (receipt.state === "cleanup_pending")
      return true;
    if (!effectIs(receipt, "cleanupComplete", "succeeded"))
      return false;
    for (const [resource, closeEffect] of [
      ["editorPaneId", "editorPaneClose"],
      ["browserPaneId", "browserPaneClose"],
      ["workerPaneId", "workerPaneClose"],
      ["reviewerPaneId", "reviewerPaneClose"]
    ]) {
      if (receipt.resources[resource] && !effectIs(receipt, closeEffect, "succeeded"))
        return false;
    }
    return true;
  }
  return receipt.state === "starting" || receipt.state === "failed";
}
function isReceipt(value) {
  const receipt = jsonObject(value);
  const workspace = jsonObject(receipt?.workspace);
  const inputs = jsonObject(receipt?.inputs);
  const resources = jsonObject(receipt?.resources);
  const response = jsonObject(receipt?.response);
  const review = jsonObject(receipt?.review);
  const decision = jsonObject(receipt?.decision);
  const controller = jsonObject(decision?.controller);
  const effects = jsonObject(receipt?.effects);
  if (receipt?.schemaVersion !== receiptSchemaVersion || !runIdPattern.test(stringField(receipt, "runId") ?? "") || !unitIdPattern.test(stringField(receipt, "unitId") ?? "") || !sha256Pattern.test(stringField(receipt, "requestHash") ?? "") || !runStates.has(stringField(receipt, "state") ?? "") || !stringField(receipt, "createdAt") || !stringField(receipt, "updatedAt") || !stringField(workspace, "path") || !stringField(workspace, "workspaceId") || !stringField(workspace, "tabId") || !stringField(workspace, "callerPaneId") || !sha256Pattern.test(stringField(inputs, "promptSha256") ?? "") || !sha256Pattern.test(stringField(inputs, "browserUrlSha256") ?? "") || !isSafeRelativeResultPath(stringField(inputs, "resultFile") ?? "") || !sha256Pattern.test(stringField(inputs, "resultBeforeSha256") ?? "") || typeof inputs?.timeoutMs !== "number" || !Number.isSafeInteger(inputs.timeoutMs) || inputs.timeoutMs < 1 || inputs.timeoutMs > 3600000 || !stringField(resources, "workerName") || receipt?.response !== undefined && !sha256Pattern.test(stringField(response, "sha256") ?? "") || receipt?.review !== undefined && !review || receipt?.decision !== undefined && (!decision || !controller || !sha256Pattern.test(stringField(decision, "fileSha256") ?? "") || decision.submissionAttempt !== 1 || !stringField(decision, "runId") || !stringField(decision, "candidateSha256") || !stringField(decision, "reviewerName") || !stringField(decision, "verdict") || !stringField(decision, "verdictMarkerSha256") || !stringField(controller, "sessionId") || !stringField(controller, "workspaceId") || !stringField(controller, "tabId") || !stringField(controller, "paneId") || !stringField(decision, "submittedAt")) || !effects) {
    return false;
  }
  if (!resources || !effects)
    return false;
  for (const paneField of ["editorPaneId", "browserPaneId", "workerPaneId", "reviewerPaneId"]) {
    const paneId = resources[paneField];
    if (paneId !== undefined && (typeof paneId !== "string" || paneId.length === 0))
      return false;
  }
  for (const [effectName, effect] of Object.entries(effects)) {
    if (!effectNames.has(effectName))
      return false;
    const record = jsonObject(effect);
    if (!effectOutcomes.has(stringField(record, "outcome") ?? "") || !stringField(record, "observedAt")) {
      return false;
    }
    if (record?.code !== undefined && !stringField(record, "code"))
      return false;
  }
  return receiptStateInvariants(receipt);
}
function recordEffect(receipt, effect, outcome, code) {
  receipt.effects[effect] = { outcome, observedAt: now(), ...code ? { code } : {} };
  writeReceipt(receipt);
}
function splitPane(receipt, effect, resource, sourcePaneId, direction) {
  if (receipt.state !== "review_starting")
    receipt.state = "starting";
  recordEffect(receipt, effect, "unknown");
  const result = runHerdr(["pane", "split", sourcePaneId, "--direction", direction, "--cwd", receipt.workspace.path, "--no-focus"], receipt.workspace.path);
  const response = herdrResponseResult(result, "pane_info");
  if (!responsePaneMatches(response, {
    workspaceId: receipt.workspace.workspaceId,
    tabId: receipt.workspace.tabId
  })) {
    throw new FrontierError({
      message: `Herdr could not prove the ${effect} pane response type and identity`,
      code: "PANE_SPLIT_UNKNOWN",
      runId: receipt.runId,
      state: receipt.state,
      changedState: "partial",
      nextAction: "Inspect the Herdr layout and private receipt before cleanup; the split outcome is unknown."
    });
  }
  const pane = jsonObject(response.pane);
  const paneId = stringField(pane, "pane_id");
  const forbiddenPaneIds = new Set([
    receipt.workspace.callerPaneId,
    sourcePaneId,
    receipt.resources.editorPaneId,
    receipt.resources.browserPaneId,
    receipt.resources.workerPaneId,
    receipt.resources.reviewerPaneId
  ]);
  if (!paneId || forbiddenPaneIds.has(paneId)) {
    throw new FrontierError({
      message: `Herdr returned a missing or conflicting pane ID for ${effect}`,
      code: "PANE_SPLIT_UNKNOWN",
      runId: receipt.runId,
      state: receipt.state,
      changedState: "partial",
      nextAction: "Inspect the Herdr layout and private receipt before cleanup; the split outcome is unknown."
    });
  }
  receipt.resources[resource] = paneId;
  recordEffect(receipt, effect, "succeeded");
  return paneId;
}
function dispatchPaneCommand(receipt, effect, paneId, command) {
  if (!paneExists(receipt, paneId)) {
    throw new FrontierError({
      message: `Herdr cannot find the recorded target pane for ${effect}`,
      code: "PANE_COMMAND_UNKNOWN",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: `Inspect pane ${paneId}; do not dispatch the command to another pane.`
    });
  }
  recordEffect(receipt, effect, "unknown");
  const result = runHerdr(["pane", "run", paneId, command], receipt.workspace.path);
  if (!paneRunAccepted(result)) {
    throw new FrontierError({
      message: `Herdr could not confirm ${effect}`,
      code: "PANE_COMMAND_UNKNOWN",
      runId: receipt.runId,
      state: receipt.state,
      changedState: "partial",
      nextAction: `Inspect pane ${paneId}; the command dispatch outcome is unknown.`
    });
  }
  recordEffect(receipt, effect, "succeeded");
}
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function workerPrompt(prompt, resultFile) {
  const quotedResultFile = shellQuote(resultFile);
  return `${prompt.trimEnd()}

Frontier Runner completion contract:
- Modify the existing workspace-relative fixture file: ${resultFile}
- The final bytes must differ from the initial bytes.
- As your final shell action, run exactly: result_sha256=$(shasum -a 256 -- ${quotedResultFile} | awk '{print $1}') && printf 'frontier-result:%s\\n' "$result_sha256"
- After that command prints the marker, do not repeat the marker in prose.
`;
}
function startWorker(receipt) {
  recordEffect(receipt, "workerStart", "unknown");
  const result = runHerdr([
    "agent",
    "start",
    receipt.resources.workerName,
    "--kind",
    "codex",
    "--pane",
    receipt.resources.workerPaneId,
    "--",
    "--enable",
    "default_mode_request_user_input"
  ], receipt.workspace.path);
  const response = herdrResponseResult(result, "agent_started");
  const startedAgent = jsonObject(response?.agent);
  if (!responseAgentMatches(response, receipt) || !completedStatuses.has(stringField(startedAgent, "agent_status") ?? "")) {
    throw new FrontierError({
      message: `Herdr could not confirm Codex worker start${result.errorCode ? `: ${result.errorCode}` : ""}`,
      code: "WORKER_START_UNKNOWN",
      runId: receipt.runId,
      state: receipt.state,
      changedState: "partial",
      nextAction: `Inspect pane ${receipt.resources.workerPaneId} and the private receipt; do not start another worker.`
    });
  }
  recordEffect(receipt, "workerStart", "succeeded");
}
function promptWorker(receipt, prompt) {
  recordEffect(receipt, "promptDispatch", "unknown");
  const result = runHerdr([
    "agent",
    "prompt",
    receipt.resources.workerName,
    workerPrompt(prompt, receipt.inputs.resultFile),
    "--wait",
    "--timeout",
    String(receipt.inputs.timeoutMs)
  ], receipt.workspace.path);
  const response = herdrResponseResult(result, "agent_prompted");
  if (responseAgentMatches(response, receipt)) {
    recordEffect(receipt, "promptDispatch", "succeeded");
    return;
  }
  if (result.errorCode && promptUncertainCodes.has(result.errorCode)) {
    receipt.state = "timed_out";
    recordEffect(receipt, "promptDispatch", "timed_out", result.errorCode);
    throw new FrontierError({
      message: `prompt delivery is classified but unsettled: ${result.errorCode}`,
      code: "PROMPT_TIMEOUT",
      exitCode: 124,
      runId: receipt.runId,
      state: receipt.state,
      changedState: "partial",
      sideEffects: ["receipt", "editor-pane", "browser-pane", "worker-pane", "codex-worker", "prompt-maybe-delivered"],
      nextAction: `Run frontier-runner resume --run-id ${receipt.runId}; do not rerun run or resend the prompt.`
    });
  }
  throw new FrontierError({
    message: `prompt dispatch outcome is unknown${result.errorCode ? `: ${result.errorCode}` : ""}`,
    code: "PROMPT_EFFECT_UNKNOWN",
    runId: receipt.runId,
    state: receipt.state,
    changedState: "partial",
    nextAction: `Inspect ${receipt.resources.workerName} and the private receipt; do not resend the prompt.`
  });
}
function agentObservation(receipt) {
  const result = runHerdr(["agent", "get", receipt.resources.workerName], receipt.workspace.path);
  if (result.exitCode !== 0 || !result.json) {
    throw new FrontierError({
      message: `recorded worker identity is unavailable${result.errorCode ? `: ${result.errorCode}` : ""}`,
      code: "WORKER_IDENTITY_LOST",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: `Inspect pane ${receipt.resources.workerPaneId}; do not create a replacement worker for this run.`
    });
  }
  const resultObject = herdrResponseResult(result, "agent_info");
  if (!responseAgentMatches(resultObject, receipt)) {
    throw new FrontierError({
      message: "Herdr returned a worker observation for a conflicting identity",
      code: "WORKER_IDENTITY_CONFLICT",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Stop and inspect the live agent and private receipt; do not prompt or clean a conflicting pane."
    });
  }
  const agent = jsonObject(resultObject.agent);
  const paneId = stringField(agent, "pane_id");
  const status = stringField(agent, "agent_status");
  if (!paneId || !status) {
    throw new FrontierError({
      message: "Herdr returned an incomplete worker observation",
      code: "HERDR_PROTOCOL_INVALID",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Inspect herdr agent get output and verify client/server compatibility."
    });
  }
  if (paneId !== receipt.resources.workerPaneId) {
    throw new FrontierError({
      message: "recorded worker name now resolves to a conflicting pane",
      code: "WORKER_IDENTITY_CONFLICT",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Stop and inspect the live agent and private receipt; do not prompt or clean a conflicting pane."
    });
  }
  if (!agentStatuses.has(status)) {
    throw new FrontierError({
      message: `Herdr returned an unsupported worker state: ${status}`,
      code: "HERDR_PROTOCOL_INVALID",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Verify the installed Herdr client and server versions, then inspect agent get output."
    });
  }
  return { paneId, status };
}
function waitForWorker(receipt) {
  const result = runHerdr(["agent", "wait", receipt.resources.workerName, "--timeout", String(receipt.inputs.timeoutMs)], receipt.workspace.path);
  if (result.exitCode !== 0) {
    if (result.errorCode === "timeout") {
      receipt.state = "timed_out";
      recordEffect(receipt, "resumeWait", "timed_out", result.errorCode);
      throw new FrontierError({
        message: "recorded worker has not settled within the resume timeout",
        code: "PROMPT_TIMEOUT",
        exitCode: 124,
        runId: receipt.runId,
        state: receipt.state,
        changedState: "none",
        retrySafe: true,
        nextAction: `Run frontier-runner resume --run-id ${receipt.runId} again later; no prompt will be resent.`
      });
    }
    throw new FrontierError({
      message: `worker wait failed${result.errorCode ? `: ${result.errorCode}` : ""}`,
      code: "WORKER_WAIT_FAILED",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: `Inspect ${receipt.resources.workerName} with herdr agent get and agent read.`
    });
  }
  recordEffect(receipt, "resumeWait", "succeeded");
  return agentObservation(receipt);
}
function exactMarkerCount(readback, marker) {
  const lines = readback.split(/\r?\n/);
  let count = 0;
  for (let index = 0;index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const codexToolOutput = line.match(/^\s*\u2514\s+(frontier-result:[a-f0-9]*)$/);
    let candidate = codexToolOutput?.[1] ?? line;
    if (!candidate || !marker.startsWith(candidate))
      continue;
    let end = index;
    while (candidate.length < marker.length) {
      end += 1;
      const nextLine = lines[end] ?? "";
      const next = codexToolOutput ? nextLine.match(/^\s+([a-f0-9]+)$/)?.[1] ?? "" : nextLine;
      if (!next || !marker.startsWith(candidate + next))
        break;
      candidate += next;
    }
    if (candidate !== marker)
      continue;
    count += 1;
    index = end;
  }
  return count;
}
function proveResult(receipt, observation) {
  if (observation.status === "blocked") {
    receipt.state = "blocked";
    receipt.observation = { agentStatus: observation.status };
    writeReceipt(receipt);
    const responseAttempted = receipt.effects.responseDispatch !== undefined;
    throw new FrontierError({
      message: "the recorded worker is blocked on human input",
      code: "AGENT_BLOCKED",
      runId: receipt.runId,
      state: receipt.state,
      retrySafe: !responseAttempted,
      nextAction: responseAttempted ? `Inspect ${receipt.resources.workerName}; the recorded response will not be sent again.` : `Inspect ${receipt.resources.workerName}, obtain exact operator approval, then use frontier-runner respond.`
    });
  }
  if (observation.status === "unknown") {
    throw new FrontierError({
      message: "Herdr cannot classify the recorded worker state",
      code: "AGENT_STATE_UNKNOWN",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: `Inspect ${receipt.resources.workerName} with herdr agent get and agent read; terminal status does not prove completion.`
    });
  }
  if (!completedStatuses.has(observation.status)) {
    throw new FrontierError({
      message: `recorded worker is not settled: ${observation.status}`,
      code: "AGENT_NOT_SETTLED",
      runId: receipt.runId,
      state: receipt.state,
      retrySafe: true,
      nextAction: `Run frontier-runner resume --run-id ${receipt.runId} to wait without resending the prompt.`
    });
  }
  const resultFile = canonicalResultFile(receipt.workspace.path, receipt.inputs.resultFile);
  const resultSha256 = sha256(readFileSync(resultFile.path));
  const marker = `frontier-result:${resultSha256}`;
  const read = runHerdr(["agent", "read", receipt.resources.workerName, "--source", "recent-unwrapped", "--lines", "120"], receipt.workspace.path);
  if (read.exitCode !== 0) {
    throw new FrontierError({
      message: `could not read the recorded worker${read.errorCode ? `: ${read.errorCode}` : ""}`,
      code: "WORKER_READ_FAILED",
      runId: receipt.runId,
      state: receipt.state,
      retrySafe: true,
      nextAction: `Inspect ${receipt.resources.workerName} directly, then resume without resending the prompt.`
    });
  }
  const exactMarkerLines = exactMarkerCount(read.stdout, marker);
  if (resultSha256 === receipt.inputs.resultBeforeSha256 || exactMarkerLines !== 1) {
    receipt.state = "settled_unproved";
    receipt.observation = { agentStatus: observation.status, resultSha256 };
    writeReceipt(receipt);
    throw new FrontierError({
      message: "worker settled without the independently derived result marker",
      code: "RESULT_NOT_PROVED",
      runId: receipt.runId,
      state: receipt.state,
      retrySafe: true,
      nextAction: `Inspect ${receipt.resources.workerName} and the fixture file; resume reads again but never resends the prompt.`
    });
  }
  receipt.state = "completed";
  receipt.observation = {
    agentStatus: observation.status,
    resultSha256,
    resultMarkerSha256: sha256(marker)
  };
  writeReceipt(receipt);
  return {
    schemaVersion,
    ok: true,
    command: "resume",
    code: "RUN_COMPLETED",
    runId: receipt.runId,
    state: receipt.state,
    changedState: "complete",
    sideEffects: [],
    retrySafe: true,
    nextAction: `Run frontier-runner cleanup --run-id ${receipt.runId} when the panes are no longer needed.`
  };
}
function validateReceiptContext(receipt) {
  requireInsideHerdr();
  requireTools(["herdr"]);
  if (process.env.HERDR_WORKSPACE_ID !== receipt.workspace.workspaceId || process.env.HERDR_TAB_ID !== receipt.workspace.tabId) {
    throw new FrontierError({
      message: "current Herdr workspace or tab conflicts with the recorded run",
      code: "WORKSPACE_CONFLICT",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Invoke from the original Herdr workspace and tab recorded by the run."
    });
  }
  canonicalDirectory(receipt.workspace.path);
}
function unknownEffect(receipt, ignored = []) {
  const ignoredSet = new Set(ignored);
  return Object.entries(receipt.effects).find(([name, effect]) => effect.outcome === "unknown" && !ignoredSet.has(name))?.[0];
}
function runCommand(arguments_) {
  const flags = parseFlags(arguments_, [
    "--unit-id",
    "--workspace",
    "--prompt-file",
    "--timeout-ms",
    "--browser-url",
    "--result-file"
  ]);
  const unitId = requiredFlag(flags, "--unit-id");
  if (!unitIdPattern.test(unitId)) {
    throw new FrontierError({
      message: "unit ID must contain 1 to 64 safe identifier characters",
      code: "UNIT_ID_INVALID",
      exitCode: 2,
      nextAction: "Use letters, digits, dot, underscore, or hyphen, beginning with a letter or digit."
    });
  }
  const workspace = canonicalDirectory(requiredFlag(flags, "--workspace"));
  const prompt = promptBytes(requiredFlag(flags, "--prompt-file"));
  const promptText = prompt.toString();
  if (/frontier-result:[a-f0-9]{64}/.test(promptText)) {
    throw new FrontierError({
      message: "prompt already contains a complete Frontier Runner result marker",
      code: "PROMPT_MARKER_CONFLICT",
      exitCode: 2,
      nextAction: "Remove the complete marker from the prompt so echoed input cannot satisfy the result proof."
    });
  }
  const timeoutMs = timeoutValue(requiredFlag(flags, "--timeout-ms"));
  const url = browserUrl(requiredFlag(flags, "--browser-url"));
  const resultFile = canonicalResultFile(workspace, requiredFlag(flags, "--result-file"));
  requireInsideHerdr();
  requireTools(["herdr", "tode", "terminal-browser", "codex"]);
  proveToolContract("tode", /Usage:\s+tode|tode\s+<folder>/, workspace);
  proveToolContract("terminal-browser", /\bopen\b/, workspace);
  const caller = currentPane(workspace);
  const promptSha256 = sha256(prompt);
  const browserUrlSha256 = sha256(url.toString());
  const resultBeforeSha256 = sha256(readFileSync(resultFile.path));
  const requestHash = sha256([
    unitId,
    workspace,
    promptSha256,
    String(timeoutMs),
    browserUrlSha256,
    resultFile.relativePath,
    resultBeforeSha256
  ].join("\x00"));
  const runId = `fr-${sha256(`${unitId}\x00${workspace}`).slice(0, 16)}`;
  const createdAt = now();
  const receipt = {
    schemaVersion: receiptSchemaVersion,
    runId,
    unitId,
    requestHash,
    state: "prepared",
    createdAt,
    updatedAt: createdAt,
    workspace: {
      path: workspace,
      workspaceId: caller.workspaceId,
      tabId: caller.tabId,
      callerPaneId: caller.paneId
    },
    inputs: {
      promptSha256,
      browserUrlSha256,
      resultFile: resultFile.relativePath,
      resultBeforeSha256,
      timeoutMs
    },
    resources: { workerName: `fr_${sha256(runId).slice(0, 12)}` },
    effects: {
      editorPane: { outcome: "planned", observedAt: createdAt },
      editorLaunch: { outcome: "planned", observedAt: createdAt },
      browserPane: { outcome: "planned", observedAt: createdAt },
      browserLaunch: { outcome: "planned", observedAt: createdAt },
      workerPane: { outcome: "planned", observedAt: createdAt },
      workerStart: { outcome: "planned", observedAt: createdAt },
      promptDispatch: { outcome: "planned", observedAt: createdAt }
    }
  };
  createReceipt(receipt);
  receipt.resources.editorPaneId = splitPane(receipt, "editorPane", "editorPaneId", caller.paneId, "right");
  dispatchPaneCommand(receipt, "editorLaunch", receipt.resources.editorPaneId, "exec tode .");
  receipt.resources.browserPaneId = splitPane(receipt, "browserPane", "browserPaneId", receipt.resources.editorPaneId, "down");
  dispatchPaneCommand(receipt, "browserLaunch", receipt.resources.browserPaneId, `exec terminal-browser open ${shellQuote(url.toString())}`);
  receipt.resources.workerPaneId = splitPane(receipt, "workerPane", "workerPaneId", caller.paneId, "down");
  startWorker(receipt);
  promptWorker(receipt, promptText);
  let observation = agentObservation(receipt);
  if (observation.status === "working")
    observation = waitForWorker(receipt);
  const completed = proveResult(receipt, observation);
  return { ...completed, command: "run", sideEffects: ["receipt", "editor-pane", "browser-pane", "worker-pane", "codex-worker", "prompt"] };
}
function respondCommand(arguments_) {
  const flags = parseFlags(arguments_, ["--run-id", "--response-file"]);
  const runId = requiredFlag(flags, "--run-id");
  const receipt = readReceipt(runId);
  const response = responseInput(requiredFlag(flags, "--response-file"));
  validateReceiptContext(receipt);
  if (receipt.response || receipt.effects.responseDispatch) {
    throw new FrontierError({
      message: "this run already has one recorded response attempt",
      code: "RESPONSE_ALREADY_ATTEMPTED",
      runId,
      state: receipt.state,
      nextAction: `Run frontier-runner resume --run-id ${runId}; the response will not be sent again.`
    });
  }
  if (receipt.state === "completed" || receipt.state === "cleaned") {
    throw new FrontierError({
      message: `cannot respond to a run in terminal state ${receipt.state}`,
      code: "RESPONSE_NOT_AVAILABLE",
      runId,
      state: receipt.state,
      nextAction: receipt.state === "completed" ? `Run frontier-runner cleanup --run-id ${runId} when the panes are no longer needed.` : "Use a new unit ID for another bounded run."
    });
  }
  const uncertainEffect = unknownEffect(receipt);
  if (uncertainEffect) {
    throw new FrontierError({
      message: `receipt contains an unknown external effect: ${uncertainEffect}`,
      code: "EFFECT_UNKNOWN",
      runId,
      state: receipt.state,
      nextAction: "Inspect the recorded panes and effect before any response; automatic replay is unsafe."
    });
  }
  if (!receipt.resources.workerPaneId || receipt.effects.workerStart?.outcome !== "succeeded") {
    throw new FrontierError({
      message: "receipt has no confirmed worker identity",
      code: "WORKER_IDENTITY_LOST",
      runId,
      state: receipt.state,
      nextAction: "Inspect the private receipt and Herdr layout; do not create a replacement worker."
    });
  }
  reconcileRunPanes(receipt);
  const observation = agentObservation(receipt);
  if (observation.status !== "blocked") {
    throw new FrontierError({
      message: `recorded worker is not blocked: ${observation.status}`,
      code: "RESPONSE_NOT_BLOCKED",
      runId,
      state: receipt.state,
      nextAction: `Inspect ${receipt.resources.workerName}; do not send input unless Herdr reports blocked.`
    });
  }
  receipt.state = "blocked";
  receipt.observation = { agentStatus: observation.status };
  receipt.response = { sha256: response.sha256 };
  recordEffect(receipt, "responseDispatch", "unknown");
  const result = runHerdr(["agent", "send-keys", receipt.resources.workerName, ...response.keys, "enter"], receipt.workspace.path);
  if (herdrResponseResult(result, "ok")) {
    receipt.state = "responded";
    recordEffect(receipt, "responseDispatch", "succeeded");
    return {
      schemaVersion,
      ok: true,
      command: "respond",
      code: "RESPONSE_DISPATCHED",
      runId,
      state: receipt.state,
      changedState: "partial",
      sideEffects: ["response"],
      retrySafe: false,
      nextAction: `Run frontier-runner resume --run-id ${runId}; neither prompt nor response will be resent.`
    };
  }
  if (result.errorCode === "timeout") {
    receipt.state = "timed_out";
    recordEffect(receipt, "responseDispatch", "timed_out", result.errorCode);
    throw new FrontierError({
      message: "response delivery timed out after it may have taken effect",
      code: "RESPONSE_TIMEOUT",
      exitCode: 124,
      runId,
      state: receipt.state,
      changedState: "partial",
      sideEffects: ["response-maybe-delivered"],
      nextAction: `Run frontier-runner resume --run-id ${runId}; do not repeat respond.`
    });
  }
  if (result.errorCode && responseFailedCodes.has(result.errorCode)) {
    receipt.state = "failed";
    recordEffect(receipt, "responseDispatch", "failed", result.errorCode);
    throw new FrontierError({
      message: `Herdr rejected the response before accepting input: ${result.errorCode}`,
      code: "RESPONSE_DISPATCH_FAILED",
      runId,
      state: receipt.state,
      changedState: "partial",
      nextAction: `Inspect ${receipt.resources.workerName}; do not repeat respond or create a replacement worker.`
    });
  }
  throw new FrontierError({
    message: `response dispatch outcome is unknown${result.errorCode ? `: ${result.errorCode}` : ""}`,
    code: "RESPONSE_EFFECT_UNKNOWN",
    runId,
    state: receipt.state,
    changedState: "partial",
    sideEffects: ["response-maybe-delivered"],
    nextAction: `Run frontier-runner resume --run-id ${runId}; do not repeat respond.`
  });
}
function reviewerObservation(receipt) {
  const reviewerName = receipt.resources.reviewerName;
  if (!reviewerName || !receipt.resources.reviewerPaneId) {
    throw new FrontierError({
      message: "receipt has no confirmed reviewer identity",
      code: "REVIEWER_IDENTITY_LOST",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Inspect the private receipt and Herdr layout; do not create a replacement reviewer."
    });
  }
  const result = runHerdr(["agent", "get", reviewerName], receipt.workspace.path);
  const response = herdrResponseResult(result, "agent_info");
  if (!responseReviewerMatches(response, receipt)) {
    throw new FrontierError({
      message: "Herdr returned a reviewer observation for a missing or conflicting identity",
      code: "REVIEWER_IDENTITY_CONFLICT",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Inspect the recorded reviewer and receipt; do not prompt or replace it."
    });
  }
  const agent = jsonObject(response.agent);
  const status = stringField(agent, "agent_status");
  if (!status || !agentStatuses.has(status)) {
    throw new FrontierError({
      message: "Herdr returned an unsupported reviewer state",
      code: "HERDR_PROTOCOL_INVALID",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Inspect herdr agent get output and verify client/server compatibility."
    });
  }
  return { paneId: receipt.resources.reviewerPaneId, status };
}
function waitForReviewer(receipt) {
  const result = runHerdr(["agent", "wait", receipt.resources.reviewerName, "--timeout", String(receipt.inputs.timeoutMs)], receipt.workspace.path);
  if (result.exitCode !== 0) {
    if (result.errorCode === "timeout") {
      receipt.state = "review_timed_out";
      recordEffect(receipt, "reviewWait", "timed_out", result.errorCode);
      throw new FrontierError({
        message: "recorded reviewer has not settled within the resume timeout",
        code: "REVIEW_TIMEOUT",
        exitCode: 124,
        runId: receipt.runId,
        state: receipt.state,
        retrySafe: true,
        nextAction: `Run frontier-runner resume --run-id ${receipt.runId}; the review prompt will not be resent.`
      });
    }
    throw new FrontierError({
      message: `reviewer wait failed${result.errorCode ? `: ${result.errorCode}` : ""}`,
      code: "REVIEWER_WAIT_FAILED",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: `Inspect ${receipt.resources.reviewerName}; do not create a replacement reviewer.`
    });
  }
  recordEffect(receipt, "reviewWait", "succeeded");
  return reviewerObservation(receipt);
}
function reviewMarkers(readback) {
  const prefix = "frontier-review:";
  const lines = readback.split(/\r?\n/);
  const markers = [];
  for (let index = 0;index < lines.length; index += 1) {
    const first = (lines[index] ?? "").trim();
    if (!first.startsWith(prefix))
      continue;
    let jsonText = first.slice(prefix.length);
    for (let end = index;end < Math.min(lines.length, index + 24); end += 1) {
      if (end > index)
        jsonText += (lines[end] ?? "").trim();
      if (!jsonText.startsWith("{"))
        continue;
      const parsed = parseJson(jsonText);
      if (!parsed)
        continue;
      const keys = Object.keys(parsed).sort().join(",");
      const verdict = stringField(parsed, "verdict");
      if (keys === "candidateSha256,schemaVersion,verdict" && parsed.schemaVersion === 1 && sha256Pattern.test(stringField(parsed, "candidateSha256") ?? "") && ["approve", "request_changes", "reject", "cancelled"].includes(verdict ?? "")) {
        markers.push({ marker: `${prefix}${jsonText}`, parsed });
      }
      index = end;
      break;
    }
  }
  return markers;
}
function proveReview(receipt, observation) {
  if (observation.status === "working")
    observation = waitForReviewer(receipt);
  if (!completedStatuses.has(observation.status)) {
    throw new FrontierError({
      message: `recorded reviewer is not settled: ${observation.status}`,
      code: observation.status === "blocked" ? "REVIEWER_BLOCKED" : "REVIEWER_NOT_SETTLED",
      runId: receipt.runId,
      state: receipt.state,
      retrySafe: true,
      nextAction: `Inspect ${receipt.resources.reviewerName}; resume later without resending the prompt.`
    });
  }
  const read = runHerdr(["agent", "read", receipt.resources.reviewerName, "--source", "recent-unwrapped", "--lines", "120"], receipt.workspace.path);
  if (read.exitCode !== 0) {
    throw new FrontierError({
      message: "could not read the recorded reviewer",
      code: "REVIEWER_READ_FAILED",
      runId: receipt.runId,
      state: receipt.state,
      retrySafe: true,
      nextAction: `Inspect ${receipt.resources.reviewerName}, then resume without resending the prompt.`
    });
  }
  const candidateAfterSha256 = workspaceSha256(receipt.workspace.path);
  receipt.review.candidateAfterSha256 = candidateAfterSha256;
  if (candidateAfterSha256 !== receipt.review.candidateBeforeSha256) {
    receipt.state = "review_breached";
    writeReceipt(receipt);
    throw new FrontierError({
      message: "the read-only reviewer changed candidate workspace bytes",
      code: "REVIEW_WORKSPACE_MUTATED",
      runId: receipt.runId,
      state: receipt.state,
      changedState: "partial",
      nextAction: "Stop and inspect the disposable workspace; this run cannot yield a reviewed verdict."
    });
  }
  const markers = reviewMarkers(read.stdout);
  if (markers.length !== 1) {
    receipt.state = "review_unproved";
    writeReceipt(receipt);
    throw new FrontierError({
      message: "reviewer settled without exactly one standalone review marker",
      code: "REVIEW_NOT_PROVED",
      runId: receipt.runId,
      state: receipt.state,
      retrySafe: true,
      nextAction: `Inspect ${receipt.resources.reviewerName}; resume reads again but never resends the prompt.`
    });
  }
  const { marker, parsed } = markers[0];
  const verdict = stringField(parsed, "verdict");
  if (stringField(parsed, "candidateSha256") !== receipt.review.candidateBeforeSha256) {
    receipt.state = "review_unproved";
    writeReceipt(receipt);
    throw new FrontierError({
      message: "review verdict names a different candidate workspace",
      code: "REVIEW_CANDIDATE_MISMATCH",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: `Inspect ${receipt.resources.reviewerName}; no verdict was persisted.`
    });
  }
  receipt.review.verdict = verdict;
  receipt.review.verdictMarkerSha256 = sha256(marker);
  receipt.state = "reviewed";
  writeReceipt(receipt);
  return {
    schemaVersion,
    ok: true,
    command: "review",
    code: "REVIEW_COMPLETED",
    runId: receipt.runId,
    state: receipt.state,
    changedState: "complete",
    sideEffects: [],
    retrySafe: true,
    nextAction: `The ${verdict} verdict is advisory. Run frontier-runner cleanup --run-id ${receipt.runId} when ready.`
  };
}
function reviewCommand(arguments_) {
  const flags = parseFlags(arguments_, ["--run-id", "--review-prompt-file"]);
  const runId = requiredFlag(flags, "--run-id");
  const prompt = privateReviewPrompt(requiredFlag(flags, "--review-prompt-file"));
  const receipt = readReceipt(runId);
  if (receipt.review || receipt.resources.reviewerName || receipt.effects.reviewerPane) {
    throw new FrontierError({
      message: "this run already has one recorded review attempt",
      code: "REVIEW_ALREADY_ATTEMPTED",
      runId,
      state: receipt.state,
      nextAction: `Run frontier-runner resume --run-id ${runId}; never start a replacement reviewer.`
    });
  }
  validateReceiptContext(receipt);
  if (receipt.state !== "completed") {
    throw new FrontierError({
      message: `only a proved, uncleaned completed run can be reviewed: ${receipt.state}`,
      code: "REVIEW_NOT_AVAILABLE",
      runId,
      state: receipt.state,
      nextAction: `Complete the existing run with frontier-runner resume --run-id ${runId} before review.`
    });
  }
  const uncertainEffect = unknownEffect(receipt);
  if (uncertainEffect) {
    throw new FrontierError({
      message: `receipt contains an unknown external effect: ${uncertainEffect}`,
      code: "EFFECT_UNKNOWN",
      runId,
      state: receipt.state,
      nextAction: "Resolve the existing effect before review; do not create a reviewer."
    });
  }
  reconcileRunPanes(receipt);
  agentObservation(receipt);
  const resultFile = canonicalResultFile(receipt.workspace.path, receipt.inputs.resultFile);
  if (sha256(readFileSync(resultFile.path)) !== receipt.observation?.resultSha256) {
    throw new FrontierError({
      message: "candidate result bytes conflict with the proved run receipt",
      code: "CANDIDATE_CONFLICT",
      runId,
      state: receipt.state,
      nextAction: "Restore the exact proved disposable candidate or create a new bounded run."
    });
  }
  const candidateBeforeSha256 = workspaceSha256(receipt.workspace.path);
  const createdAt = now();
  receipt.state = "review_starting";
  receipt.resources.reviewerName = `frr_${sha256(`${runId}\x00review`).slice(0, 12)}`;
  receipt.review = { promptSha256: sha256(prompt), candidateBeforeSha256 };
  receipt.effects.reviewerPane = { outcome: "planned", observedAt: createdAt };
  receipt.effects.reviewerStart = { outcome: "planned", observedAt: createdAt };
  receipt.effects.reviewPromptDispatch = { outcome: "planned", observedAt: createdAt };
  writeReceipt(receipt);
  receipt.resources.reviewerPaneId = splitPane(receipt, "reviewerPane", "reviewerPaneId", receipt.workspace.callerPaneId, "down");
  recordEffect(receipt, "reviewerStart", "unknown");
  const started = runHerdr([
    "agent",
    "start",
    receipt.resources.reviewerName,
    "--kind",
    "codex",
    "--pane",
    receipt.resources.reviewerPaneId,
    "--",
    "--sandbox",
    "read-only"
  ], receipt.workspace.path);
  if (!responseReviewerMatches(herdrResponseResult(started, "agent_started"), receipt)) {
    throw new FrontierError({
      message: "Herdr could not confirm the fresh read-only reviewer identity",
      code: "REVIEWER_START_UNKNOWN",
      runId,
      state: receipt.state,
      changedState: "partial",
      nextAction: "Inspect the recorded reviewer pane; do not start a replacement reviewer."
    });
  }
  recordEffect(receipt, "reviewerStart", "succeeded");
  const promptText = new TextDecoder().decode(prompt).trimEnd();
  const reviewPrompt = `${promptText}

Frontier Runner review contract:
- Review only; do not modify files, run acceptance, repair, commit, or publish.
Candidate workspace SHA-256: ${candidateBeforeSha256}
- Finish with exactly one standalone line: frontier-review:{"schemaVersion":1,"candidateSha256":"${candidateBeforeSha256}","verdict":"approve|request_changes|reject|cancelled"}
- Replace the verdict placeholder with exactly one allowed classification and do not repeat the marker.
`;
  recordEffect(receipt, "reviewPromptDispatch", "unknown");
  const prompted = runHerdr([
    "agent",
    "prompt",
    receipt.resources.reviewerName,
    reviewPrompt,
    "--wait",
    "--timeout",
    String(receipt.inputs.timeoutMs)
  ], receipt.workspace.path);
  if (responseReviewerMatches(herdrResponseResult(prompted, "agent_prompted"), receipt)) {
    recordEffect(receipt, "reviewPromptDispatch", "succeeded");
  } else if (prompted.errorCode && promptUncertainCodes.has(prompted.errorCode)) {
    receipt.state = "review_timed_out";
    recordEffect(receipt, "reviewPromptDispatch", "timed_out", prompted.errorCode);
    throw new FrontierError({
      message: "review prompt delivery is classified but unsettled",
      code: "REVIEW_TIMEOUT",
      exitCode: 124,
      runId,
      state: receipt.state,
      changedState: "partial",
      sideEffects: ["reviewer-pane", "codex-reviewer", "review-prompt-maybe-delivered"],
      nextAction: `Run frontier-runner resume --run-id ${runId}; never resend the review prompt.`
    });
  } else {
    throw new FrontierError({
      message: "review prompt dispatch outcome is unknown",
      code: "REVIEW_EFFECT_UNKNOWN",
      runId,
      state: receipt.state,
      changedState: "partial",
      sideEffects: ["review-prompt-maybe-delivered"],
      nextAction: `Run frontier-runner resume --run-id ${runId}; never resend the review prompt.`
    });
  }
  const result = proveReview(receipt, reviewerObservation(receipt));
  return {
    ...result,
    command: "review",
    sideEffects: ["reviewer-pane", "codex-reviewer", "review-prompt"]
  };
}
function decisionController(receipt) {
  const controller = currentPane(receipt.workspace.path);
  if (controller.paneId !== receipt.workspace.callerPaneId) {
    throw new FrontierError({
      message: "current Controller pane conflicts with the run's recorded caller pane",
      code: "CONTROLLER_IDENTITY_CONFLICT",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Invoke the decision from the original recognised Controller pane recorded by the run."
    });
  }
  return controller;
}
function requireDecisionCandidate(receipt) {
  const resultFile = canonicalResultFile(receipt.workspace.path, receipt.inputs.resultFile);
  if (sha256(readFileSync(resultFile.path)) !== receipt.observation?.resultSha256 || workspaceSha256(receipt.workspace.path) !== receipt.review?.candidateAfterSha256) {
    throw new FrontierError({
      message: "candidate workspace bytes conflict with the approved review receipt",
      code: "CANDIDATE_CONFLICT",
      runId: receipt.runId,
      state: receipt.state,
      nextAction: "Restore the exact approved disposable candidate; do not retarget this decision."
    });
  }
}
function decisionRecorded(receipt, command) {
  receipt.state = "decided";
  receipt.decision.recordedAt = now();
  receipt.effects.decisionRecord = { outcome: "succeeded", observedAt: now() };
  writeReceipt(receipt);
  return {
    schemaVersion,
    ok: true,
    command,
    code: "DECISION_RECORDED",
    runId: receipt.runId,
    state: receipt.state,
    changedState: "complete",
    sideEffects: ["operator-decision"],
    retrySafe: true,
    nextAction: `The ${receipt.decision?.classification} decision is recorded. Stop without repair, cleanup, Git, publication, or another unit.`
  };
}
function decideCommand(arguments_) {
  const flags = parseFlags(arguments_, ["--run-id", "--decision-file"]);
  const runId = requiredFlag(flags, "--run-id");
  const input = privateDecision(requiredFlag(flags, "--decision-file"));
  const receipt = readReceipt(runId);
  if (receipt.decision || receipt.effects.decisionRecord) {
    throw new FrontierError({
      message: "this run already has one recorded decision attempt",
      code: "DECISION_ALREADY_ATTEMPTED",
      runId,
      state: receipt.state,
      nextAction: `Run frontier-runner resume --run-id ${runId}; never replace or retarget the first decision.`
    });
  }
  validateReceiptContext(receipt);
  if (receipt.state !== "reviewed") {
    throw new FrontierError({
      message: `only one proved, uncleaned reviewed run can receive a decision: ${receipt.state}`,
      code: "DECISION_NOT_AVAILABLE",
      runId,
      state: receipt.state,
      nextAction: "Complete and prove the existing run and review before requesting a decision."
    });
  }
  if (receipt.review?.verdict !== "approve" || !receipt.review.verdictMarkerSha256) {
    throw new FrontierError({
      message: `operator decision requires advisory approve, not ${receipt.review?.verdict ?? "missing"}`,
      code: "REVIEW_NOT_APPROVED",
      runId,
      state: receipt.state,
      nextAction: "Stop without acceptance or repair; this review did not approve the candidate."
    });
  }
  const uncertainEffect = unknownEffect(receipt);
  if (uncertainEffect) {
    throw new FrontierError({
      message: `receipt contains an unknown external effect: ${uncertainEffect}`,
      code: "EFFECT_UNKNOWN",
      runId,
      state: receipt.state,
      nextAction: "Resolve the existing effect before decision; do not submit a decision."
    });
  }
  reconcileRunPanes(receipt);
  reviewerObservation(receipt);
  requireDecisionCandidate(receipt);
  const controller = decisionController(receipt);
  const submittedAt = now();
  receipt.state = "decision_starting";
  receipt.decision = {
    classification: input.classification,
    fileSha256: input.fileSha256,
    submissionAttempt: 1,
    runId,
    candidateSha256: receipt.review.candidateBeforeSha256,
    reviewerName: receipt.resources.reviewerName,
    verdict: "approve",
    verdictMarkerSha256: receipt.review.verdictMarkerSha256,
    controller: {
      sessionId: controller.sessionId,
      workspaceId: controller.workspaceId,
      tabId: controller.tabId,
      paneId: controller.paneId
    },
    submittedAt
  };
  receipt.effects.decisionRecord = { outcome: "planned", observedAt: submittedAt };
  writeReceipt(receipt);
  receipt.effects.decisionRecord = { outcome: "unknown", observedAt: now() };
  writeReceipt(receipt);
  try {
    const confirmed = decisionController(receipt);
    if (confirmed.sessionId !== controller.sessionId || confirmed.workspaceId !== controller.workspaceId || confirmed.tabId !== controller.tabId || confirmed.paneId !== controller.paneId) {
      throw new Error("Controller identity changed after the decision checkpoint");
    }
  } catch {
    throw new FrontierError({
      message: "decision effect is unknown after the bound checkpoint",
      code: "DECISION_EFFECT_UNKNOWN",
      runId,
      state: receipt.state,
      changedState: "partial",
      sideEffects: ["operator-decision-maybe-recorded"],
      retrySafe: false,
      nextAction: `Run frontier-runner resume --run-id ${runId}; never resubmit the decision file.`
    });
  }
  requireDecisionCandidate(receipt);
  return decisionRecorded(receipt, "decide");
}
function resumeCommand(arguments_) {
  const flags = parseFlags(arguments_, ["--run-id"]);
  const runId = requiredFlag(flags, "--run-id");
  const receipt = readReceipt(runId);
  validateReceiptContext(receipt);
  if (receipt.state === "cleaned") {
    return {
      schemaVersion,
      ok: true,
      command: "resume",
      code: "RUN_CLEANED",
      runId,
      state: receipt.state,
      changedState: "none",
      sideEffects: [],
      retrySafe: true,
      nextAction: "Use a new unit ID for another run."
    };
  }
  if (receipt.state === "decided") {
    return {
      schemaVersion,
      ok: true,
      command: "resume",
      code: "DECISION_RECORDED",
      runId,
      state: receipt.state,
      changedState: "none",
      sideEffects: [],
      retrySafe: true,
      nextAction: `The ${receipt.decision?.classification} decision is already recorded. Stop without another action.`
    };
  }
  if (receipt.state === "decision_starting") {
    const controller = decisionController(receipt);
    if (controller.sessionId !== receipt.decision?.controller.sessionId || controller.workspaceId !== receipt.decision?.controller.workspaceId || controller.tabId !== receipt.decision?.controller.tabId || controller.paneId !== receipt.decision?.controller.paneId) {
      throw new FrontierError({
        message: "current Controller identity conflicts with the checkpointed decision",
        code: "CONTROLLER_IDENTITY_CONFLICT",
        runId,
        state: receipt.state,
        nextAction: "Resume from the same recognised Controller session; never resubmit the decision."
      });
    }
    requireDecisionCandidate(receipt);
    return decisionRecorded(receipt, "resume");
  }
  if (receipt.state === "reviewed") {
    return {
      schemaVersion,
      ok: true,
      command: "resume",
      code: "REVIEW_COMPLETED",
      runId,
      state: receipt.state,
      changedState: "none",
      sideEffects: [],
      retrySafe: true,
      nextAction: `The ${receipt.review?.verdict} verdict is advisory. Run frontier-runner cleanup --run-id ${runId} when ready.`
    };
  }
  if (receipt.state === "review_breached") {
    throw new FrontierError({
      message: "reviewer workspace mutation permanently breached this review attempt",
      code: "REVIEW_WORKSPACE_MUTATED",
      runId,
      state: receipt.state,
      nextAction: `Inspect the disposable workspace, then run frontier-runner cleanup --run-id ${runId}.`
    });
  }
  if (receipt.state === "review_starting" || receipt.state === "review_timed_out" || receipt.state === "review_unproved") {
    const uncertainEffect2 = unknownEffect(receipt, ["reviewPromptDispatch"]);
    if (uncertainEffect2) {
      throw new FrontierError({
        message: `receipt contains an unknown external effect: ${uncertainEffect2}`,
        code: "EFFECT_UNKNOWN",
        runId,
        state: receipt.state,
        nextAction: "Inspect the reviewer pane and receipt; automatic replacement or replay is unsafe."
      });
    }
    reconcileRunPanes(receipt);
    if (!receipt.resources.reviewerPaneId || !paneExists(receipt, receipt.resources.reviewerPaneId)) {
      throw new FrontierError({
        message: "recorded reviewer pane identity is unavailable",
        code: "REVIEWER_IDENTITY_LOST",
        runId,
        state: receipt.state,
        nextAction: "Inspect the Herdr layout; do not create a replacement reviewer."
      });
    }
    return { ...proveReview(receipt, reviewerObservation(receipt)), command: "resume" };
  }
  if (receipt.state === "completed") {
    return {
      schemaVersion,
      ok: true,
      command: "resume",
      code: "RUN_COMPLETED",
      runId,
      state: receipt.state,
      changedState: "none",
      sideEffects: [],
      retrySafe: true,
      nextAction: `Run frontier-runner cleanup --run-id ${runId} when the panes are no longer needed.`
    };
  }
  const uncertainEffect = unknownEffect(receipt, ["responseDispatch"]);
  if (uncertainEffect) {
    throw new FrontierError({
      message: `receipt contains an unknown external effect: ${uncertainEffect}`,
      code: "EFFECT_UNKNOWN",
      runId,
      state: receipt.state,
      nextAction: "Inspect the recorded panes and effect before any retry; automatic replay is unsafe."
    });
  }
  if (!receipt.resources.workerPaneId || receipt.effects.workerStart?.outcome !== "succeeded") {
    throw new FrontierError({
      message: "receipt has no confirmed worker identity",
      code: "WORKER_IDENTITY_LOST",
      runId,
      state: receipt.state,
      nextAction: "Inspect the private receipt and Herdr layout; do not create a replacement worker."
    });
  }
  reconcileRunPanes(receipt);
  let observation = agentObservation(receipt);
  if (observation.status === "working")
    observation = waitForWorker(receipt);
  return proveResult(receipt, observation);
}
function paneExists(receipt, paneId) {
  const result = runHerdr(["pane", "get", paneId], receipt.workspace.path);
  if (result.exitCode === 0 && result.json) {
    const response = herdrResponseResult(result, "pane_info");
    if (!response) {
      throw new FrontierError({
        message: `Herdr returned an unexpected pane response type: ${paneId}`,
        code: "HERDR_PROTOCOL_INVALID",
        runId: receipt.runId,
        state: receipt.state,
        nextAction: "Inspect herdr pane get output and verify client/server compatibility."
      });
    }
    const pane = jsonObject(response.pane);
    const observedPaneId = stringField(pane, "pane_id");
    const workspaceId = stringField(pane, "workspace_id");
    const tabId = stringField(pane, "tab_id");
    if (observedPaneId !== paneId || workspaceId !== receipt.workspace.workspaceId || tabId !== receipt.workspace.tabId) {
      throw new FrontierError({
        message: `owned pane identity conflicts with the receipt: ${paneId}`,
        code: "PANE_IDENTITY_CONFLICT",
        runId: receipt.runId,
        state: receipt.state,
        nextAction: "Inspect the pane and receipt; do not prompt or close a conflicting target."
      });
    }
    return true;
  }
  if (result.errorCode === "pane_not_found" || result.errorCode === "not_found")
    return false;
  throw new FrontierError({
    message: `could not reconcile owned pane ${paneId}${result.errorCode ? `: ${result.errorCode}` : ""}`,
    code: "PANE_RECONCILIATION_FAILED",
    runId: receipt.runId,
    state: receipt.state,
    nextAction: "Inspect the Herdr session before cleanup; do not close an unverified target."
  });
}
function reconcileRunPanes(receipt) {
  for (const [role, paneId] of [
    ["Terminal Code", receipt.resources.editorPaneId],
    ["Chromium", receipt.resources.browserPaneId],
    ["worker", receipt.resources.workerPaneId]
  ]) {
    if (!paneId || !paneExists(receipt, paneId)) {
      throw new FrontierError({
        message: `recorded ${role} pane identity is unavailable`,
        code: "PANE_IDENTITY_LOST",
        runId: receipt.runId,
        state: receipt.state,
        nextAction: "Inspect the Herdr layout and private receipt; do not recreate or retarget this run automatically."
      });
    }
  }
}
function closeOwnedPane(receipt, resource, effect) {
  const paneId = receipt.resources[resource];
  if (typeof paneId !== "string")
    return false;
  if (!paneExists(receipt, paneId)) {
    recordEffect(receipt, effect, "succeeded", "already_absent");
    return false;
  }
  recordEffect(receipt, effect, "unknown");
  const result = runHerdr(["pane", "close", paneId], receipt.workspace.path);
  if (result.exitCode === 0 && !herdrResponseResult(result, "ok") || result.exitCode !== 0 && result.errorCode !== "pane_not_found" && result.errorCode !== "not_found") {
    throw new FrontierError({
      message: `could not confirm closure of owned pane ${paneId}`,
      code: "CLEANUP_EFFECT_UNKNOWN",
      runId: receipt.runId,
      state: receipt.state,
      changedState: "partial",
      nextAction: `Inspect pane ${paneId}; repeat cleanup only after its identity is clear.`
    });
  }
  recordEffect(receipt, effect, "succeeded");
  return true;
}
function cleanupCommand(arguments_) {
  const flags = parseFlags(arguments_, ["--run-id"]);
  const runId = requiredFlag(flags, "--run-id");
  const receipt = readReceipt(runId);
  validateReceiptContext(receipt);
  if (receipt.state === "cleaned") {
    return {
      schemaVersion,
      ok: true,
      command: "cleanup",
      code: "CLEANUP_CONVERGED",
      runId,
      state: receipt.state,
      changedState: "none",
      sideEffects: [],
      retrySafe: true,
      nextAction: "Use a new unit ID for another bounded run."
    };
  }
  if ([
    receipt.resources.editorPaneId,
    receipt.resources.browserPaneId,
    receipt.resources.workerPaneId,
    receipt.resources.reviewerPaneId
  ].includes(process.env.HERDR_PANE_ID)) {
    throw new FrontierError({
      message: "cleanup was invoked from a pane owned by the run",
      code: "CLEANUP_CALLER_OWNED",
      runId,
      state: receipt.state,
      nextAction: "Invoke cleanup from the original caller pane so the controller cannot close itself mid-receipt."
    });
  }
  for (const splitEffect of ["editorPane", "browserPane", "workerPane", "reviewerPane"]) {
    if (receipt.effects[splitEffect]?.outcome === "unknown") {
      throw new FrontierError({
        message: `cannot clean an unaddressed pane after unknown split: ${splitEffect}`,
        code: "CLEANUP_TARGET_UNKNOWN",
        runId,
        state: receipt.state,
        nextAction: "Inspect the Herdr layout and receipt; close only panes whose IDs can be proved owned."
      });
    }
  }
  receipt.state = "cleanup_pending";
  writeReceipt(receipt);
  const closed = [
    closeOwnedPane(receipt, "reviewerPaneId", "reviewerPaneClose"),
    closeOwnedPane(receipt, "workerPaneId", "workerPaneClose"),
    closeOwnedPane(receipt, "browserPaneId", "browserPaneClose"),
    closeOwnedPane(receipt, "editorPaneId", "editorPaneClose")
  ].filter(Boolean).length;
  recordEffect(receipt, "cleanupComplete", "succeeded");
  receipt.state = "cleaned";
  writeReceipt(receipt);
  return {
    schemaVersion,
    ok: true,
    command: "cleanup",
    code: "CLEANUP_CONVERGED",
    runId,
    state: receipt.state,
    changedState: closed > 0 ? "complete" : "none",
    sideEffects: closed > 0 ? ["owned-panes-closed"] : [],
    retrySafe: true,
    nextAction: "Use a new unit ID for another bounded run."
  };
}
var [commandInput, ...commandArguments] = process.argv.slice(2);
if (commandInput === undefined || commandInput === "--help" || commandInput === "-h") {
  process.stdout.write(help());
  process.exit(0);
}
if (!["run", "respond", "resume", "review", "decide", "cleanup"].includes(commandInput))
  emitFailure("unknown", new FrontierError({
    message: `unknown command: ${commandInput}`,
    code: "USAGE",
    exitCode: 2,
    nextAction: "Run frontier-runner --help."
  }));
var command = commandInput;
try {
  const envelope = command === "run" ? runCommand(commandArguments) : command === "respond" ? respondCommand(commandArguments) : command === "resume" ? resumeCommand(commandArguments) : command === "review" ? reviewCommand(commandArguments) : command === "decide" ? decideCommand(commandArguments) : cleanupCommand(commandArguments);
  emit(envelope);
} catch (error) {
  if (error instanceof FrontierError)
    emitFailure(command, error);
  const nextAction = "Inspect the private receipt and report this unexpected failure before retrying.";
  emitFailure(command, new FrontierError({
    message: error instanceof Error ? error.message : "unexpected failure",
    code: "INTERNAL_ERROR",
    nextAction
  }));
}
