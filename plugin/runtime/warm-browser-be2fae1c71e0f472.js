// @bun
// packages/agent-browser/src/modules/warm-browser/production-adapter.ts
import { spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { accessSync, constants, existsSync, lstatSync } from "fs";
import { createConnection } from "net";
import { homedir } from "os";
import { join } from "path";

// packages/agent-browser/src/modules/warm-browser/contract.ts
var schemaVersion = 1;

class SpawnCleanupUnverifiedError extends Error {
  constructor() {
    super("spawned Chrome process-group cleanup could not be verified");
    this.name = "SpawnCleanupUnverifiedError";
  }
}

// packages/agent-browser/src/modules/warm-browser/production-adapter.ts
var installedChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function privateOwnedDirectory(path) {
  if (!existsSync(path))
    return false;
  const metadata = lstatSync(path);
  return metadata.isDirectory() && !metadata.isSymbolicLink() && (typeof process.getuid !== "function" || metadata.uid === process.getuid()) && (metadata.mode & 63) === 0;
}
function processTable() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,lstart=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0)
    return [];
  const rows = [];
  for (const line of result.stdout.split(`
`)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+)$/.exec(line);
    if (!match)
      continue;
    const pid = Number(match[1]);
    const processGroupId = Number(match[2]);
    const commandLine = match[4];
    const executable = commandLine.startsWith(installedChrome) ? installedChrome : commandLine.split(" ")[0];
    rows.push({ pid, processGroupId, startedAtToken: match[3], executable, commandLine });
  }
  return rows;
}
function sameProcess(expected, observed) {
  return observed !== undefined && observed.pid === expected.pid && observed.processGroupId === expected.processGroupId && observed.startedAtToken === expected.startedAtToken && observed.executable === expected.executable && observed.commandLine === expected.commandLine;
}
function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function pause(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function terminateSpawnedProcessGroup(processGroupId) {
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH")
      return true;
    return false;
  }
  for (let attempt = 0;attempt < 40; attempt += 1) {
    if (!processGroupExists(processGroupId))
      return true;
    await pause(50);
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (error.code === "ESRCH")
      return true;
    return false;
  }
  for (let attempt = 0;attempt < 20; attempt += 1) {
    if (!processGroupExists(processGroupId))
      return true;
    await pause(50);
  }
  return false;
}
function listenerOwner(port) {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-a", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status === 1 && result.stdout.trim() === "")
    return "absent";
  if (result.status !== 0)
    return "unverifiable";
  const owners = [
    ...new Set(result.stdout.split(`
`).filter((line) => /^p[0-9]+$/.test(line)).map((line) => Number(line.slice(1))))
  ];
  return owners.length === 1 ? owners[0] : "unverifiable";
}
async function inspectLoopbackPort(port) {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish("occupied"));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? "free" : "unverifiable"));
    socket.setTimeout(300, () => finish("unverifiable"));
  });
}
async function readEndpoint(port, expected) {
  for (let attempt = 0;attempt < 40; attempt += 1) {
    const observed = processTable().find((processIdentity) => processIdentity.pid === expected.pid);
    if (!sameProcess(expected, observed))
      return { kind: "browser_unverified" };
    const owner = listenerOwner(port);
    if (owner === "unverifiable" || owner !== "absent" && owner !== expected.pid) {
      return { kind: "listener_unverified" };
    }
    if (owner === "absent") {
      if (attempt === 39)
        return { kind: "listener_unverified" };
      await pause(100);
      continue;
    }
    try {
      const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500)
      });
      const version = await versionResponse.json();
      if (!versionResponse.ok || typeof version.Browser !== "string" || !version.Browser.startsWith("Chrome/") || typeof version.webSocketDebuggerUrl !== "string") {
        return { kind: "browser_unverified" };
      }
      const webSocket = new URL(version.webSocketDebuggerUrl);
      if (webSocket.protocol !== "ws:" || webSocket.hostname !== "127.0.0.1" || Number(webSocket.port) !== port) {
        return { kind: "browser_unverified" };
      }
      const targetsResponse = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500)
      });
      const targets = await targetsResponse.json();
      if (!targetsResponse.ok || !Array.isArray(targets))
        return { kind: "browser_unverified" };
      const pages = targets.filter((target) => target.type === "page" && typeof target.id === "string");
      if (pages.length === 0) {
        if (attempt === 39)
          return { kind: "controlled_page_unavailable" };
        await pause(100);
        continue;
      }
      if (pages.length !== 1)
        return { kind: "controlled_page_ambiguous" };
      return {
        kind: "verified",
        endpoint: {
          browserVersion: version.Browser,
          controlledPageTargetId: pages[0].id
        }
      };
    } catch {
      if (attempt === 39)
        return { kind: "browser_unverified" };
      await pause(100);
    }
  }
  return { kind: "browser_unverified" };
}
var productionAdapter = {
  createRunId: () => `wb-${randomUUID()}`,
  createSessionId: () => `session-${randomUUID()}`,
  nowEpochMs: () => Date.now(),
  platform: () => process.platform,
  chromeExecutable: () => installedChrome,
  inspectChrome: (executable) => {
    try {
      const metadata = lstatSync(executable);
      if (!metadata.isFile() || metadata.isSymbolicLink())
        return "unavailable";
      accessSync(executable, constants.X_OK);
      return "installed";
    } catch {
      return "unavailable";
    }
  },
  profileRoot: () => join(homedir(), ".agent-warm-profile"),
  inspectProfile: (profileRoot) => privateOwnedDirectory(profileRoot) && privateOwnedDirectory(join(profileRoot, "Default")) ? "safe" : "unsafe",
  findProfileProcesses: (profileRoot) => {
    const plain = `--user-data-dir=${profileRoot}`;
    const quoted = `--user-data-dir="${profileRoot}"`;
    return processTable().filter((processIdentity) => processIdentity.executable === installedChrome && (processIdentity.commandLine.includes(plain) || processIdentity.commandLine.includes(quoted)));
  },
  inspectPort: inspectLoopbackPort,
  spawnChrome: async ({ executable, profileRoot, port }) => {
    const child = spawn(executable, [
      `--user-data-dir=${profileRoot}`,
      "--profile-directory=Default",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check"
    ], { detached: true, stdio: "ignore" });
    if (child.pid === undefined)
      throw new Error("Chrome returned no process identity");
    child.unref();
    for (let attempt = 0;attempt < 20; attempt += 1) {
      const observed = processTable().find((processIdentity) => processIdentity.pid === child.pid);
      if (observed !== undefined && observed.processGroupId === child.pid)
        return observed;
      await pause(25);
    }
    if (!await terminateSpawnedProcessGroup(child.pid)) {
      throw new SpawnCleanupUnverifiedError;
    }
    throw new Error("Chrome process identity could not be read");
  },
  inspectProcess: (pid) => processTable().find((processIdentity) => processIdentity.pid === pid),
  verifyEndpoint: async ({ port, process: expected }) => {
    const observed = processTable().find((processIdentity) => processIdentity.pid === expected.pid);
    if (!sameProcess(expected, observed))
      return { kind: "browser_unverified" };
    return readEndpoint(port, expected);
  },
  terminateProcessGroup: async (expected) => {
    const observed = processTable().find((processIdentity) => processIdentity.pid === expected.pid);
    if (!sameProcess(expected, observed) || expected.processGroupId !== expected.pid)
      return false;
    try {
      process.kill(-expected.processGroupId, "SIGTERM");
    } catch {
      return false;
    }
    for (let attempt = 0;attempt < 40; attempt += 1) {
      if (!processGroupExists(expected.processGroupId))
        return true;
      await pause(50);
    }
    try {
      process.kill(-expected.processGroupId, "SIGKILL");
    } catch {
      return false;
    }
    for (let attempt = 0;attempt < 20; attempt += 1) {
      if (!processGroupExists(expected.processGroupId))
        return true;
      await pause(50);
    }
    return false;
  }
};

// packages/agent-browser/src/modules/warm-browser/state.ts
import {
  chmodSync,
  existsSync as existsSync2,
  lstatSync as lstatSync2,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import { dirname, join as join2, resolve } from "path";

class UnsafeStateError extends Error {
  constructor() {
    super("Warm Browser private state could not be proved safe");
    this.name = "UnsafeStateError";
  }
}
function privateDirectory(path) {
  if (!existsSync2(path)) {
    mkdirSync(path, { mode: 448 });
    chmodSync(path, 448);
    return;
  }
  const metadata = lstatSync2(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || typeof process.getuid === "function" && metadata.uid !== process.getuid() || (metadata.mode & 63) !== 0) {
    throw new UnsafeStateError;
  }
}
function resolveStatePaths(environment = process.env) {
  const base = environment.XDG_STATE_HOME ? resolve(environment.XDG_STATE_HOME) : environment.HOME ? resolve(environment.HOME, ".local", "state") : undefined;
  if (base === undefined)
    throw new UnsafeStateError;
  const root = join2(base, "my-second-brain", "warm-browser");
  return { root, lock: join2(root, "session.lock"), session: join2(root, "session.json") };
}
function ensurePrivateState(paths) {
  mkdirSync(dirname(paths.root), { recursive: true, mode: 448 });
  privateDirectory(dirname(paths.root));
  privateDirectory(paths.root);
}
function acquireSessionLock(paths) {
  try {
    mkdirSync(paths.lock, { mode: 448 });
    chmodSync(paths.lock, 448);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
    validateSessionLock(paths);
    return false;
  }
}
function validateSessionLock(paths) {
  let metadata;
  try {
    metadata = lstatSync2(paths.lock);
  } catch (error) {
    if (error.code === "ENOENT")
      return false;
    throw new UnsafeStateError;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || typeof process.getuid === "function" && metadata.uid !== process.getuid() || (metadata.mode & 511) !== 448) {
    throw new UnsafeStateError;
  }
  return true;
}
function lockAgeMs(paths, nowEpochMs) {
  return Math.max(0, nowEpochMs - statSync(paths.lock).mtimeMs);
}
function stateShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const state = value;
  const processIdentity = state.process;
  const endpoint = state.endpoint;
  return state.schemaVersion === 1 && (state.phase === "starting" || state.phase === "running") && typeof state.sessionId === "string" && typeof state.startRunId === "string" && Number.isSafeInteger(state.createdAtEpochMs) && typeof state.profileRoot === "string" && processIdentity !== undefined && Number.isSafeInteger(processIdentity.pid) && Number.isSafeInteger(processIdentity.processGroupId) && typeof processIdentity.startedAtToken === "string" && typeof processIdentity.executable === "string" && typeof processIdentity.commandLine === "string" && endpoint !== undefined && endpoint.host === "127.0.0.1" && Number.isSafeInteger(endpoint.port) && (endpoint.browserVersion === undefined || typeof endpoint.browserVersion === "string") && (endpoint.controlledPageTargetId === undefined || typeof endpoint.controlledPageTargetId === "string");
}
function readSessionState(paths) {
  if (!existsSync2(paths.session))
    return;
  const metadata = lstatSync2(paths.session);
  if (!metadata.isFile() || metadata.isSymbolicLink() || typeof process.getuid === "function" && metadata.uid !== process.getuid() || (metadata.mode & 127) !== 0) {
    throw new UnsafeStateError;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(paths.session, "utf8"));
  } catch {
    throw new UnsafeStateError;
  }
  if (!stateShape(parsed))
    throw new UnsafeStateError;
  return parsed;
}
function writeSessionState(paths, state) {
  const temporary = `${paths.session}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}
`, { flag: "wx", mode: 384 });
    chmodSync(temporary, 384);
    renameSync(temporary, paths.session);
    chmodSync(paths.session, 384);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function runningState(state, endpoint) {
  return {
    ...state,
    phase: "running",
    endpoint: { ...state.endpoint, ...endpoint }
  };
}
function removeOwnedState(paths) {
  try {
    rmdirSync(paths.lock);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
  }
  rmSync(paths.session, { force: true });
}

// packages/agent-browser/src/modules/warm-browser/warm-browser.ts
var defaultPort = 9242;
var minimumPort = 1024;
var maximumPort = 65535;
var startingStateTimeoutMs = 15000;
var runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class WarmBrowserFailure extends Error {
  command;
  resultCode;
  exitCode;
  runId;
  transactionState;
  retrySafe;
  nextAction;
  constructor(options) {
    super(options.message);
    this.name = "WarmBrowserFailure";
    this.command = options.command;
    this.resultCode = options.resultCode;
    this.exitCode = options.exitCode;
    this.runId = options.runId;
    this.transactionState = options.transactionState ?? "unchanged";
    this.retrySafe = options.retrySafe;
    this.nextAction = options.nextAction;
  }
}
function success(envelope) {
  return { exitCode: 0, stdout: `${JSON.stringify(envelope)}
`, stderr: "" };
}
function failure(error) {
  const envelope = {
    schemaVersion,
    status: "error",
    command: error.command,
    resultCode: error.resultCode,
    runId: error.runId,
    transactionState: error.transactionState,
    retrySafe: error.retrySafe,
    nextAction: error.nextAction,
    message: error.message
  };
  return { exitCode: error.exitCode, stdout: "", stderr: `${JSON.stringify(envelope)}
` };
}
function candidateRunId(arguments_, adapter) {
  const index = arguments_.indexOf("--run-id");
  const value = index >= 0 ? arguments_[index + 1] : undefined;
  return value !== undefined && runIdPattern.test(value) ? value : adapter.createRunId();
}
function usage(runId, command, message) {
  throw new WarmBrowserFailure({
    command,
    resultCode: "USAGE_ERROR",
    exitCode: 2,
    runId,
    retrySafe: false,
    nextAction: "Run warm-browser help --run-id ID and correct the command arguments.",
    message
  });
}
function parseArguments(arguments_, adapter) {
  const generatedRunId = candidateRunId(arguments_, adapter);
  const first = arguments_[0];
  const command = first === undefined || first === "help" || first === "--help" || first === "-h" ? "help" : first === "start" || first === "status" || first === "stop" ? first : "unknown";
  if (command === "unknown")
    usage(generatedRunId, command, "Unknown Warm Browser command.");
  let runId = generatedRunId;
  let port;
  let runIdSeen = false;
  let portSeen = false;
  const startIndex = first === undefined ? 0 : 1;
  for (let index = startIndex;index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--run-id") {
      if (runIdSeen)
        usage(runId, command, "The --run-id flag may appear only once.");
      const value = arguments_[index + 1];
      if (value === undefined || !runIdPattern.test(value)) {
        usage(runId, command, "The --run-id value is missing or invalid.");
      }
      runId = value;
      runIdSeen = true;
      index += 1;
      continue;
    }
    if (argument === "--port") {
      if (command !== "start")
        usage(runId, command, "The --port flag is accepted only by start.");
      if (portSeen)
        usage(runId, command, "The --port flag may appear only once.");
      const value = arguments_[index + 1];
      if (value === undefined || !/^[0-9]+$/.test(value)) {
        usage(runId, command, "The --port value must be a decimal port number.");
      }
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < minimumPort || port > maximumPort) {
        usage(runId, command, "The --port value must be between 1024 and 65535.");
      }
      portSeen = true;
      index += 1;
      continue;
    }
    usage(runId, command, "Warm Browser received an unsupported argument.");
  }
  return { command, runId, ...port === undefined ? {} : { port } };
}
function requireMacOs(command, runId, adapter) {
  if (adapter.platform() === "darwin")
    return;
  throw new WarmBrowserFailure({
    command,
    resultCode: "PLATFORM_UNSUPPORTED",
    exitCode: 21,
    runId,
    retrySafe: false,
    nextAction: "Run Warm Browser on a supported macOS host.",
    message: "Warm Browser supports macOS only."
  });
}
function staticFailure(command, runId, resultCode, exitCode, message, nextAction, retrySafe = false, transactionState = "unchanged") {
  throw new WarmBrowserFailure({
    command,
    resultCode,
    exitCode,
    runId,
    retrySafe,
    nextAction,
    message,
    transactionState
  });
}
function identityMatches(expected, observed, profileRoot, port) {
  const userDataFlag = `--user-data-dir=${profileRoot}`;
  const quotedUserDataFlag = `--user-data-dir="${profileRoot}"`;
  return observed.pid === expected.pid && observed.processGroupId === expected.processGroupId && observed.processGroupId === observed.pid && observed.startedAtToken === expected.startedAtToken && observed.executable === expected.executable && observed.commandLine.startsWith(expected.executable) && (observed.commandLine.includes(userDataFlag) || observed.commandLine.includes(quotedUserDataFlag)) && observed.commandLine.includes("--remote-debugging-address=127.0.0.1") && observed.commandLine.includes(`--remote-debugging-port=${port}`);
}
function canonicalProcess(processIdentity) {
  return {
    pid: processIdentity.pid,
    processGroupId: processIdentity.processGroupId,
    startedAtToken: processIdentity.startedAtToken,
    executable: processIdentity.executable,
    commandLine: processIdentity.commandLine
  };
}
async function inspectSession(command, runId, paths, adapter) {
  const lockExists = validateSessionLock(paths);
  const state = readSessionState(paths);
  if (!lockExists && state !== undefined) {
    staticFailure(command, runId, "STATE_UNSAFE", 20, "Warm Browser state has no ownership lock.", "Inspect the private Warm Browser state before retrying.");
  }
  if (state === undefined) {
    if (!lockExists)
      return { kind: "absent" };
    if (lockAgeMs(paths, adapter.nowEpochMs()) <= startingStateTimeoutMs) {
      staticFailure(command, runId, "START_IN_PROGRESS", 22, "Another Warm Browser start transaction owns the session lock.", "Wait briefly, then run warm-browser status --run-id ID.", true);
    }
    staticFailure(command, runId, "PROCESS_IDENTITY_UNVERIFIED", 20, "An expired ownership lock has no process identity receipt.", "Inspect the private lock and profile processes; Warm Browser will not remove or signal them.");
  }
  const observed = adapter.inspectProcess(state.process.pid);
  if (observed === undefined) {
    removeOwnedState(paths);
    return { kind: "recovered", stoppedOwnedProcess: false };
  }
  if (!identityMatches(state.process, observed, state.profileRoot, state.endpoint.port)) {
    staticFailure(command, runId, "PROCESS_IDENTITY_UNVERIFIED", 20, "The stored browser process identity does not match the live process.", "Inspect the live process and private Warm Browser state; do not signal the stored process id.");
  }
  if (state.phase === "starting") {
    if (adapter.nowEpochMs() - state.createdAtEpochMs <= startingStateTimeoutMs) {
      staticFailure(command, runId, "START_IN_PROGRESS", 22, "The owned Warm Browser start transaction has not completed.", "Wait briefly, then run warm-browser status --run-id ID.", true);
    }
    if (!await adapter.terminateProcessGroup(observed)) {
      staticFailure(command, runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not clean up its stale starting process group.", "Inspect the owned process group and private state before retrying.");
    }
    removeOwnedState(paths);
    return { kind: "recovered", stoppedOwnedProcess: true };
  }
  const verification = await adapter.verifyEndpoint({
    host: "127.0.0.1",
    port: state.endpoint.port,
    process: observed
  });
  if (verification.kind !== "verified" || verification.endpoint.browserVersion !== state.endpoint.browserVersion || verification.endpoint.controlledPageTargetId !== state.endpoint.controlledPageTargetId) {
    staticFailure(command, runId, "CDP_IDENTITY_UNVERIFIED", 20, "The stored CDP endpoint identity could not be verified.", "Inspect the Browser Session with its owned process still preserved.");
  }
  return { kind: "running", state };
}
function sessionData(state, postcondition) {
  return {
    sessionId: state.sessionId,
    startRunId: state.startRunId,
    processId: state.process.pid,
    endpoint: { host: state.endpoint.host, port: state.endpoint.port },
    controlledPage: { targetId: state.endpoint.controlledPageTargetId },
    postcondition
  };
}
function recoveredData(trigger, stoppedOwnedProcess) {
  return { trigger, postcondition: "absent", removedState: true, stoppedOwnedProcess };
}
async function start(parsed, paths, adapter) {
  const inspection = await inspectSession("start", parsed.runId, paths, adapter);
  if (inspection.kind === "running") {
    staticFailure("start", parsed.runId, "SESSION_ALREADY_RUNNING", 21, "A verified Browser Session already owns the Agent Chrome Profile.", "Run warm-browser status --run-id ID or warm-browser stop --run-id ID.");
  }
  const recovered = inspection.kind === "recovered";
  const chromeExecutable = adapter.chromeExecutable();
  if (adapter.inspectChrome(chromeExecutable) !== "installed") {
    staticFailure("start", parsed.runId, "CHROME_UNAVAILABLE", 20, "The fixed installed Google Chrome executable is unavailable.", "Install Google Chrome at the fixed macOS application path before retrying.");
  }
  const profileRoot = adapter.profileRoot();
  if (adapter.inspectProfile(profileRoot) !== "safe") {
    staticFailure("start", parsed.runId, "PROFILE_UNSAFE", 21, "The Agent Chrome Profile ownership or permissions are unsafe.", "Repair the Agent Chrome Profile ownership and private permissions before retrying.");
  }
  const profileProcesses = adapter.findProfileProcesses(profileRoot);
  if (profileProcesses.length > 1) {
    staticFailure("start", parsed.runId, "PROFILE_PROCESS_AMBIGUOUS", 20, "More than one live process claims the Agent Chrome Profile.", "Inspect the profile process owners before retrying; Warm Browser will not signal them.");
  }
  if (profileProcesses.length === 1) {
    staticFailure("start", parsed.runId, "PROFILE_IN_USE", 21, "An unowned process is using the Agent Chrome Profile.", "Close the existing profile owner, then retry Warm Browser start.");
  }
  const port = parsed.port ?? defaultPort;
  const portStatus = await adapter.inspectPort(port);
  if (portStatus === "occupied") {
    staticFailure("start", parsed.runId, "PORT_OCCUPIED", 20, "The requested loopback CDP port is already occupied.", "Inspect the port owner or choose one free start --port override.");
  }
  if (portStatus === "unverifiable") {
    staticFailure("start", parsed.runId, "PORT_UNVERIFIABLE", 20, "Warm Browser could not prove that the requested CDP port is free.", "Inspect loopback port state before retrying.");
  }
  if (!acquireSessionLock(paths)) {
    staticFailure("start", parsed.runId, "START_IN_PROGRESS", 22, "Another start transaction acquired Browser Session ownership.", "Wait briefly, then run warm-browser status --run-id ID.", true);
  }
  let spawned;
  try {
    spawned = await adapter.spawnChrome({
      executable: chromeExecutable,
      profileRoot,
      port
    });
    const startingState = {
      schemaVersion: 1,
      phase: "starting",
      sessionId: adapter.createSessionId(),
      startRunId: parsed.runId,
      createdAtEpochMs: adapter.nowEpochMs(),
      profileRoot,
      process: canonicalProcess(spawned),
      endpoint: { host: "127.0.0.1", port }
    };
    writeSessionState(paths, startingState);
    const verification = await adapter.verifyEndpoint({
      host: "127.0.0.1",
      port,
      process: spawned
    });
    if (verification.kind !== "verified") {
      const mapped = verification.kind === "controlled_page_unavailable" ? ["CONTROLLED_PAGE_UNAVAILABLE", "The verified CDP endpoint exposes no Controlled Page."] : verification.kind === "controlled_page_ambiguous" ? ["CONTROLLED_PAGE_AMBIGUOUS", "The verified CDP endpoint exposes more than one page."] : ["CDP_IDENTITY_UNVERIFIED", "The launched Chrome CDP identity could not be verified."];
      if (!await adapter.terminateProcessGroup(spawned)) {
        staticFailure("start", parsed.runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not roll back its unverified browser process group.", "Inspect the owned process group and private state before retrying.");
      }
      removeOwnedState(paths);
      staticFailure("start", parsed.runId, mapped[0], 20, mapped[1], "Inspect installed Chrome and the explicit CDP endpoint before retrying.", false, "rolled_back");
    }
    const state = runningState(startingState, verification.endpoint);
    writeSessionState(paths, state);
    return success({
      schemaVersion,
      status: "ok",
      command: "start",
      resultCode: "SESSION_STARTED",
      runId: parsed.runId,
      transactionState: "started",
      retrySafe: false,
      nextAction: "Run warm-browser status --run-id ID to inspect the Browser Session.",
      data: {
        ...sessionData(state, "running"),
        recoveredFrom: recovered ? "stale_session" : null
      }
    });
  } catch (error) {
    if (error instanceof WarmBrowserFailure)
      throw error;
    const cleanupUnverified = error instanceof SpawnCleanupUnverifiedError;
    if (spawned !== undefined) {
      const terminated = await adapter.terminateProcessGroup(spawned);
      if (terminated)
        removeOwnedState(paths);
    } else if (!(error instanceof SpawnCleanupUnverifiedError)) {
      removeOwnedState(paths);
    }
    staticFailure("start", parsed.runId, "UNEXPECTED_FAILURE", 1, "Warm Browser start failed unexpectedly.", "Inspect private state and the owned process group before retrying.", false, spawned === undefined && !cleanupUnverified ? "rolled_back" : "unchanged");
  }
}
async function status(parsed, paths, adapter) {
  const inspection = await inspectSession("status", parsed.runId, paths, adapter);
  if (inspection.kind === "running") {
    return success({
      schemaVersion,
      status: "ok",
      command: "status",
      resultCode: "SESSION_RUNNING",
      runId: parsed.runId,
      transactionState: "unchanged",
      retrySafe: true,
      nextAction: "Continue with an implemented Agent Browser command or run warm-browser stop --run-id ID.",
      data: sessionData(inspection.state, "running")
    });
  }
  if (inspection.kind === "recovered") {
    return success({
      schemaVersion,
      status: "ok",
      command: "status",
      resultCode: "STALE_SESSION_RECOVERED",
      runId: parsed.runId,
      transactionState: "recovered",
      retrySafe: true,
      nextAction: "Run warm-browser start --run-id ID to create a new Browser Session.",
      data: recoveredData("status", inspection.stoppedOwnedProcess ?? false)
    });
  }
  return success({
    schemaVersion,
    status: "ok",
    command: "status",
    resultCode: "SESSION_ABSENT",
    runId: parsed.runId,
    transactionState: "unchanged",
    retrySafe: true,
    nextAction: "Run warm-browser start --run-id ID to create a Browser Session.",
    data: { postcondition: "absent" }
  });
}
async function stop(parsed, paths, adapter) {
  const inspection = await inspectSession("stop", parsed.runId, paths, adapter);
  if (inspection.kind === "recovered") {
    return success({
      schemaVersion,
      status: "ok",
      command: "stop",
      resultCode: "STALE_SESSION_RECOVERED",
      runId: parsed.runId,
      transactionState: "recovered",
      retrySafe: true,
      nextAction: "Run warm-browser start --run-id ID when another Browser Session is needed.",
      data: recoveredData("stop", inspection.stoppedOwnedProcess ?? false)
    });
  }
  if (inspection.kind === "absent") {
    return success({
      schemaVersion,
      status: "ok",
      command: "stop",
      resultCode: "SESSION_ABSENT",
      runId: parsed.runId,
      transactionState: "unchanged",
      retrySafe: true,
      nextAction: "Run warm-browser start --run-id ID when a Browser Session is needed.",
      data: { postcondition: "absent" }
    });
  }
  const state = inspection.state;
  const observed = adapter.inspectProcess(state.process.pid);
  if (observed === undefined || !identityMatches(state.process, observed, state.profileRoot, state.endpoint.port)) {
    staticFailure("stop", parsed.runId, "PROCESS_IDENTITY_UNVERIFIED", 20, "The owned browser process identity changed before stop.", "Inspect the live process and private state; Warm Browser did not signal it.");
  }
  if (!await adapter.terminateProcessGroup(observed)) {
    staticFailure("stop", parsed.runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not stop its verified browser process group.", "Inspect the owned process group and private state before retrying.");
  }
  removeOwnedState(paths);
  return success({
    schemaVersion,
    status: "ok",
    command: "stop",
    resultCode: "SESSION_STOPPED",
    runId: parsed.runId,
    transactionState: "stopped",
    retrySafe: true,
    nextAction: "Run warm-browser start --run-id ID when another Browser Session is needed.",
    data: {
      sessionId: state.sessionId,
      stoppedProcessId: state.process.pid,
      postcondition: "absent"
    }
  });
}
async function execute(parsed, adapter) {
  if (parsed.command === "help") {
    return success({
      schemaVersion,
      status: "ok",
      command: "help",
      resultCode: "HELP",
      runId: parsed.runId,
      transactionState: "unchanged",
      retrySafe: true,
      nextAction: "Run warm-browser start --run-id ID to create the Browser Session.",
      data: {
        usage: "warm-browser <help|start|status|stop> [--run-id ID] [--port NUMBER]",
        commands: [
          { name: "help", sideEffects: "none" },
          { name: "start", sideEffects: "starts one owned browser process group" },
          { name: "status", sideEffects: "may remove proved stale private state" },
          { name: "stop", sideEffects: "stops one verified owned browser process group" }
        ]
      }
    });
  }
  requireMacOs(parsed.command, parsed.runId, adapter);
  let paths;
  try {
    paths = resolveStatePaths();
    ensurePrivateState(paths);
  } catch (error) {
    if (error instanceof UnsafeStateError) {
      return failure(new WarmBrowserFailure({
        command: parsed.command,
        resultCode: "STATE_UNSAFE",
        exitCode: 20,
        runId: parsed.runId,
        retrySafe: false,
        nextAction: "Repair the private XDG state ownership and permissions before retrying.",
        message: "Warm Browser private state is unsafe or unreadable."
      }));
    }
    throw error;
  }
  if (parsed.command === "start")
    return start(parsed, paths, adapter);
  if (parsed.command === "status")
    return status(parsed, paths, adapter);
  return stop(parsed, paths, adapter);
}
async function runWarmBrowserCli(arguments_, adapter) {
  let parsed;
  try {
    parsed = parseArguments(arguments_, adapter);
    return await execute(parsed, adapter);
  } catch (error) {
    if (error instanceof WarmBrowserFailure)
      return failure(error);
    const runId = parsed?.runId ?? candidateRunId(arguments_, adapter);
    const command = parsed?.command ?? "unknown";
    if (error instanceof UnsafeStateError) {
      return failure(new WarmBrowserFailure({
        command,
        resultCode: "STATE_UNSAFE",
        exitCode: 20,
        runId,
        transactionState: "unchanged",
        retrySafe: false,
        nextAction: "Repair the private XDG state ownership and permissions before retrying.",
        message: "Warm Browser private state is unsafe or unreadable."
      }));
    }
    return failure(new WarmBrowserFailure({
      command,
      resultCode: "UNEXPECTED_FAILURE",
      exitCode: 1,
      runId,
      transactionState: "unchanged",
      retrySafe: false,
      nextAction: "Inspect private Warm Browser state before retrying.",
      message: "Warm Browser failed unexpectedly."
    }));
  }
}

// packages/agent-browser/src/main.ts
var outcome = await runWarmBrowserCli(process.argv.slice(2), productionAdapter);
if (outcome.stdout)
  process.stdout.write(outcome.stdout);
if (outcome.stderr)
  process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
