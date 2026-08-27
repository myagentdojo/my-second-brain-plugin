// @bun
// packages/agent-browser/src/modules/warm-browser/production-adapter.ts
import { randomUUID } from "crypto";
import { existsSync, lstatSync as lstatSync2 } from "fs";
import { homedir } from "os";
import { join } from "path";

// packages/agent-browser/src/modules/warm-browser/contract.ts
var schemaVersion = 1;
var commandVocabulary = [
  { name: "help", sideEffects: "none" },
  { name: "start", sideEffects: "starts one owned browser process group" },
  { name: "status", sideEffects: "may remove proved stale private state" },
  { name: "stop", sideEffects: "stops one verified owned browser process group" }
];

class SpawnCleanupUnverifiedError extends Error {
  constructor() {
    super("spawned Chrome process-group cleanup could not be verified");
    this.name = "SpawnCleanupUnverifiedError";
  }
}

// packages/agent-browser/src/modules/warm-browser/host-effects.ts
import { spawn, spawnSync } from "child_process";
import { accessSync, constants, lstatSync } from "fs";
import { createConnection } from "net";
function hostPlatform() {
  return process.platform;
}
function readProcessTable() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,lstart=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return {
    status: result.status,
    signal: result.signal,
    failed: result.error !== undefined,
    stdout: typeof result.stdout === "string" ? result.stdout : null
  };
}
function isExecutableFile(path) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function startDetachedProcess(executable, argumentList) {
  const child = spawn(executable, [...argumentList], { detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  if (child.pid === undefined)
    throw new Error("the launched process returned no process identity");
  child.unref();
  return child.pid;
}
function signalProcessGroup(processGroupId, signal) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1)
    return "failed";
  try {
    process.kill(-processGroupId, signal);
    return "delivered";
  } catch (error) {
    const code = error.code;
    if (code === "ESRCH")
      return "absent";
    if (code === "EPERM")
      return "denied";
    return "failed";
  }
}
async function connectLoopbackPort(port) {
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
function readLoopbackListener(port) {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-a", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return {
    status: result.status,
    signal: result.signal,
    failed: result.error !== undefined,
    stdout: typeof result.stdout === "string" ? result.stdout : null
  };
}
async function readLoopbackJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(500) });
  return { ok: response.ok, body: await response.json() };
}

// packages/agent-browser/src/modules/warm-browser/listener-table.ts
var processIdentityField = /^p([1-9][0-9]*)$/;
function observeLoopbackListener(reading) {
  if (reading.failed || reading.signal !== null)
    return "unverifiable";
  const stdout = reading.stdout;
  if (typeof stdout !== "string")
    return "unverifiable";
  if (reading.status === 1)
    return stdout === "" ? "absent" : "unverifiable";
  if (reading.status !== 0)
    return "unverifiable";
  if (stdout === "" || !stdout.endsWith(`
`))
    return "unverifiable";
  const owners = new Set;
  for (const line of stdout.slice(0, -1).split(`
`)) {
    const match = processIdentityField.exec(line);
    if (!match)
      return "unverifiable";
    const owner = Number(match[1]);
    if (!Number.isSafeInteger(owner))
      return "unverifiable";
    owners.add(owner);
  }
  return owners.size === 1 ? [...owners][0] : "unverifiable";
}

// packages/agent-browser/src/modules/warm-browser/process-table.ts
var rowPattern = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(\S.*)$/;
var canonicalIdentifier = /^(?:0|[1-9][0-9]*)$/;
var unframedCharacter = /\p{Cc}/u;
var unverifiable = { kind: "unverifiable" };
function safeIdentifier(digits) {
  if (!canonicalIdentifier.test(digits))
    return;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : undefined;
}
function classifyExecutable(commandLine, knownExecutable) {
  return commandLine === knownExecutable || commandLine.startsWith(`${knownExecutable} `) ? knownExecutable : commandLine.split(" ")[0];
}
function observeProcessTable(reading, knownExecutable) {
  if (reading.failed || reading.signal !== null || reading.status !== 0)
    return unverifiable;
  const stdout = reading.stdout;
  if (typeof stdout !== "string" || stdout === "" || !stdout.endsWith(`
`))
    return unverifiable;
  const processes = [];
  const claimed = new Set;
  for (const line of stdout.slice(0, -1).split(`
`)) {
    if (unframedCharacter.test(line))
      return unverifiable;
    const match = rowPattern.exec(line);
    if (!match)
      return unverifiable;
    const pid = safeIdentifier(match[1]);
    const processGroupId = safeIdentifier(match[2]);
    if (pid === undefined || processGroupId === undefined || claimed.has(pid))
      return unverifiable;
    claimed.add(pid);
    const commandLine = match[4];
    processes.push({
      pid,
      processGroupId,
      startedAtToken: match[3],
      executable: classifyExecutable(commandLine, knownExecutable),
      commandLine
    });
  }
  return { kind: "verified", processes };
}

// packages/agent-browser/src/modules/warm-browser/production-adapter.ts
var installedChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function chromeArgumentList(input) {
  return [
    `--user-data-dir=${input.profileRoot}`,
    "--profile-directory=Default",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${input.port}`,
    `--agent-browser-launch-marker=${input.launchMarker}`,
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-first-run",
    "--no-default-browser-check"
  ];
}
function commandHasArgument(commandLine, argument) {
  return ` ${commandLine} `.includes(` ${argument} `);
}
function privateOwnedDirectory(path) {
  if (!existsSync(path))
    return false;
  const metadata = lstatSync2(path);
  return metadata.isDirectory() && !metadata.isSymbolicLink() && (typeof process.getuid !== "function" || metadata.uid === process.getuid()) && (metadata.mode & 63) === 0;
}
function sameProcess(expected, observed) {
  return observed !== undefined && observed.pid === expected.pid && observed.processGroupId === expected.processGroupId && observed.startedAtToken === expected.startedAtToken && observed.executable === expected.executable && observed.commandLine === expected.commandLine;
}
function processTable() {
  return observeProcessTable(readProcessTable(), installedChrome);
}
function loopbackListenerOwner(port) {
  return observeLoopbackListener(readLoopbackListener(port));
}
function observeProcessGroup(processGroupId) {
  const outcome = signalProcessGroup(processGroupId, 0);
  if (outcome === "delivered" || outcome === "denied")
    return "present";
  return outcome === "absent" ? "absent" : "unverified";
}
async function pause(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function awaitProcessGroupAbsence(processGroupId, attempts) {
  for (let attempt = 0;attempt < attempts; attempt += 1) {
    const observed = observeProcessGroup(processGroupId);
    if (observed !== "present")
      return observed;
    await pause(50);
  }
  return "present";
}
async function terminateProcessGroupWithEscalation(processGroupId) {
  const requested = signalProcessGroup(processGroupId, "SIGTERM");
  if (requested === "absent")
    return true;
  if (requested !== "delivered")
    return false;
  const afterTermination = await awaitProcessGroupAbsence(processGroupId, 40);
  if (afterTermination !== "present")
    return afterTermination === "absent";
  const escalated = signalProcessGroup(processGroupId, "SIGKILL");
  if (escalated === "absent")
    return true;
  if (escalated !== "delivered")
    return false;
  return await awaitProcessGroupAbsence(processGroupId, 20) === "absent";
}
async function readEndpoint(port, expected) {
  for (let attempt = 0;attempt < 40; attempt += 1) {
    const table = processTable();
    if (table.kind === "unverifiable")
      return { kind: "process_unverifiable" };
    const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid);
    if (!sameProcess(expected, observed))
      return { kind: "browser_unverified" };
    const owner = loopbackListenerOwner(port);
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
      const versionReading = await readLoopbackJson(`http://127.0.0.1:${port}/json/version`);
      const version = versionReading.body;
      if (!versionReading.ok || typeof version.Browser !== "string" || !version.Browser.startsWith("Chrome/") || typeof version.webSocketDebuggerUrl !== "string") {
        return { kind: "browser_unverified" };
      }
      const webSocket = new URL(version.webSocketDebuggerUrl);
      if (webSocket.protocol !== "ws:" || webSocket.hostname !== "127.0.0.1" || Number(webSocket.port) !== port) {
        return { kind: "browser_unverified" };
      }
      const targetsReading = await readLoopbackJson(`http://127.0.0.1:${port}/json/list`);
      const targets = targetsReading.body;
      if (!targetsReading.ok || !Array.isArray(targets))
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
  platform: hostPlatform,
  chromeExecutable: () => installedChrome,
  inspectChrome: (executable) => isExecutableFile(executable) ? "installed" : "unavailable",
  profileRoot: () => join(homedir(), ".agent-warm-profile"),
  inspectProfile: (profileRoot) => privateOwnedDirectory(profileRoot) && privateOwnedDirectory(join(profileRoot, "Default")) ? "safe" : "unsafe",
  findProfileProcesses: (profileRoot) => {
    const plain = `--user-data-dir=${profileRoot}`;
    const quoted = `--user-data-dir="${profileRoot}"`;
    const table = processTable();
    if (table.kind === "unverifiable")
      return table;
    return {
      kind: "verified",
      processes: table.processes.filter((processIdentity) => processIdentity.executable === installedChrome && (commandHasArgument(processIdentity.commandLine, plain) || commandHasArgument(processIdentity.commandLine, quoted)))
    };
  },
  findLaunchProcesses: (launchMarker) => {
    const table = processTable();
    if (table.kind === "unverifiable")
      return table;
    const marker = `--agent-browser-launch-marker=${launchMarker}`;
    return {
      kind: "verified",
      processes: table.processes.filter((processIdentity) => commandHasArgument(processIdentity.commandLine, marker))
    };
  },
  inspectPort: connectLoopbackPort,
  spawnChrome: async ({ executable, profileRoot, port, launchMarker }) => {
    const pid = await startDetachedProcess(executable, chromeArgumentList({ profileRoot, port, launchMarker }));
    for (let attempt = 0;attempt < 20; attempt += 1) {
      const table = processTable();
      if (table.kind === "unverifiable")
        break;
      const observed = table.processes.find((processIdentity) => processIdentity.pid === pid);
      if (observed !== undefined && observed.processGroupId === pid)
        return observed;
      await pause(25);
    }
    if (!await terminateProcessGroupWithEscalation(pid))
      throw new SpawnCleanupUnverifiedError;
    throw new Error("Chrome process identity could not be read");
  },
  inspectProcess: (pid) => {
    const table = processTable();
    if (table.kind === "unverifiable")
      return { kind: "unverifiable" };
    const processIdentity = table.processes.find((candidate) => candidate.pid === pid);
    return processIdentity === undefined ? { kind: "absent" } : { kind: "found", process: processIdentity };
  },
  verifyEndpoint: async ({ port, process: expected }) => {
    const table = processTable();
    if (table.kind === "unverifiable")
      return { kind: "process_unverifiable" };
    const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid);
    if (!sameProcess(expected, observed))
      return { kind: "browser_unverified" };
    return readEndpoint(port, expected);
  },
  terminateProcessGroup: async (expected) => {
    const table = processTable();
    if (table.kind === "unverifiable")
      return false;
    const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid);
    if (!sameProcess(expected, observed) || expected.processGroupId !== expected.pid)
      return false;
    return terminateProcessGroupWithEscalation(expected.processGroupId);
  }
};

// packages/agent-browser/src/modules/warm-browser/state.ts
import {
  chmodSync,
  existsSync as existsSync2,
  lstatSync as lstatSync3,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { dirname, join as join2, resolve } from "path";

class UnsafeStateError extends Error {
  constructor() {
    super("Warm Browser private state could not be proved safe");
    this.name = "UnsafeStateError";
  }
}
function exactPrivateDirectory(path) {
  if (!existsSync2(path)) {
    mkdirSync(path, { mode: 448 });
    chmodSync(path, 448);
    return;
  }
  const metadata = lstatSync3(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || typeof process.getuid === "function" && metadata.uid !== process.getuid() || (metadata.mode & 4095) !== 448) {
    throw new UnsafeStateError;
  }
}
function resolveStatePaths(environment = process.env) {
  const base = environment.XDG_STATE_HOME ? resolve(environment.XDG_STATE_HOME) : environment.HOME ? resolve(environment.HOME, ".local", "state") : undefined;
  if (base === undefined)
    throw new UnsafeStateError;
  const root = join2(base, "my-second-brain", "warm-browser");
  const lock = join2(root, "session.lock");
  return { root, lock, session: join2(lock, "session.json") };
}
function ensurePrivateState(paths) {
  mkdirSync(dirname(paths.root), { recursive: true, mode: 448 });
  exactPrivateDirectory(dirname(paths.root));
  exactPrivateDirectory(paths.root);
  if (readdirSync(paths.root).some((entry) => entry.startsWith(".cleanup-"))) {
    throw new UnsafeStateError;
  }
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
    metadata = lstatSync3(paths.lock);
  } catch (error) {
    if (error.code === "ENOENT")
      return false;
    throw new UnsafeStateError;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || typeof process.getuid === "function" && metadata.uid !== process.getuid() || (metadata.mode & 4095) !== 448) {
    throw new UnsafeStateError;
  }
  return true;
}
function lockAgeMs(paths, nowEpochMs) {
  return Math.max(0, nowEpochMs - statSync(paths.lock).mtimeMs);
}
function processShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const processIdentity = value;
  return Number.isSafeInteger(processIdentity.pid) && Number.isSafeInteger(processIdentity.processGroupId) && typeof processIdentity.startedAtToken === "string" && typeof processIdentity.executable === "string" && typeof processIdentity.commandLine === "string";
}
function stateShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const state = value;
  const endpoint = state.endpoint;
  const common = state.schemaVersion === 1 && (state.phase === "launching" || state.phase === "starting" || state.phase === "running") && typeof state.sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(state.sessionId) && typeof state.startRunId === "string" && typeof state.launchMarker === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(state.launchMarker) && Number.isSafeInteger(state.createdAtEpochMs) && typeof state.profileRoot === "string" && endpoint !== undefined && endpoint.host === "127.0.0.1" && Number.isSafeInteger(endpoint.port) && (endpoint.browserVersion === undefined || typeof endpoint.browserVersion === "string") && (endpoint.controlledPageTargetId === undefined || typeof endpoint.controlledPageTargetId === "string");
  if (!common)
    return false;
  if (state.phase === "launching")
    return !("process" in state);
  if (!processShape(state.process))
    return false;
  return state.phase !== "running" || typeof endpoint.browserVersion === "string" && typeof endpoint.controlledPageTargetId === "string";
}
function readSessionState(paths) {
  let metadata;
  try {
    metadata = lstatSync3(paths.session);
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    throw new UnsafeStateError;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || typeof process.getuid === "function" && metadata.uid !== process.getuid() || (metadata.mode & 4095) !== 384) {
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
  if (!validateSessionLock(paths))
    throw new UnsafeStateError;
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
function removeNewEmptyLock(paths) {
  if (!validateSessionLock(paths) || readSessionState(paths) !== undefined) {
    throw new UnsafeStateError;
  }
  rmdirSync(paths.lock);
}
function removeOwnedState(paths, sessionId, onDetached) {
  if (!validateSessionLock(paths))
    throw new UnsafeStateError;
  const state = readSessionState(paths);
  if (state === undefined || state.sessionId !== sessionId)
    throw new UnsafeStateError;
  const detached = join2(paths.root, `.cleanup-${sessionId}`);
  if (existsSync2(detached))
    throw new UnsafeStateError;
  renameSync(paths.lock, detached);
  const detachedSession = join2(detached, "session.json");
  try {
    onDetached?.();
    unlinkSync(detachedSession);
    rmdirSync(detached);
  } catch (error) {
    if (existsSync2(detached) && !existsSync2(detachedSession)) {
      writeFileSync(detachedSession, `${JSON.stringify(state, null, 2)}
`, {
        flag: "wx",
        mode: 384
      });
      chmodSync(detachedSession, 384);
    }
    throw error;
  }
}

// packages/agent-browser/src/modules/warm-browser/warm-browser.ts
var defaultPort = 9242;
var startingTimeoutMs = 15000;
var runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var commandNames = new Set(commandVocabulary.map(({ name }) => name));
var usageLine = `warm-browser <${commandVocabulary.map(({ name }) => name).join("|")}> [--run-id ID] [--port NUMBER]`;

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
function raise(options) {
  throw new WarmBrowserFailure(options);
}
function usage(runId, command, message) {
  raise({
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
  const command = first === undefined || first === "--help" || first === "-h" ? "help" : commandNames.has(first) ? first : "unknown";
  if (command === "unknown")
    usage(generatedRunId, command, "Unknown Warm Browser command.");
  let runId = generatedRunId;
  let port;
  let runIdSeen = false;
  let portSeen = false;
  for (let index = first === undefined ? 0 : 1;index < arguments_.length; index += 1) {
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
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
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
function staticFailure(command, runId, resultCode, exitCode, message, nextAction, retrySafe = false, transactionState = "unchanged") {
  raise({ command, resultCode, exitCode, runId, retrySafe, nextAction, message, transactionState });
}
function inspectionFailure(command, runId, tx = "unchanged") {
  staticFailure(command, runId, "PROCESS_INSPECTION_UNVERIFIED", 20, "Warm Browser could not verify the local process table.", "Inspect the host process table and private Warm Browser state before retrying.", false, tx);
}
function identityFailure(command, runId) {
  staticFailure(command, runId, "PROCESS_IDENTITY_UNVERIFIED", 20, "The stored browser process identity does not match the live process.", "Inspect the live process and private Warm Browser state; do not signal the stored process id.");
}
function launchCleanupUnverified(runId, transactionState) {
  staticFailure("start", runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not verify cleanup of its launched browser process group.", "Inspect the durable launch intent and marker-matched processes before retrying.", false, transactionState);
}
function removeStateAfterStop(command, runId, paths, sessionId) {
  try {
    removeOwnedState(paths, sessionId);
  } catch {
    staticFailure(command, runId, "STATE_UNSAFE", 20, "Warm Browser stopped the owned browser process group but could not remove its private session state.", "Repair the retained private Warm Browser session state; the owned browser process group is already stopped.", false, "stopped");
  }
}
function hasLaunchContract(observed, executable, profileRoot, port, marker) {
  const hasArgument = (argument) => ` ${observed.commandLine} `.includes(` ${argument} `);
  return observed.processGroupId === observed.pid && observed.executable === executable && (observed.commandLine === executable || observed.commandLine.startsWith(`${executable} `)) && (hasArgument(`--user-data-dir=${profileRoot}`) || hasArgument(`--user-data-dir="${profileRoot}"`)) && hasArgument("--remote-debugging-address=127.0.0.1") && hasArgument(`--remote-debugging-port=${port}`) && hasArgument(`--agent-browser-launch-marker=${marker}`);
}
function identityMatches(expected, observed, profileRoot, port, marker) {
  return observed.pid === expected.pid && observed.processGroupId === expected.processGroupId && observed.startedAtToken === expected.startedAtToken && observed.executable === expected.executable && observed.commandLine === expected.commandLine && hasLaunchContract(observed, expected.executable, profileRoot, port, marker);
}
function canonicalProcess(value) {
  return {
    pid: value.pid,
    processGroupId: value.processGroupId,
    startedAtToken: value.startedAtToken,
    executable: value.executable,
    commandLine: value.commandLine
  };
}
async function recoverLaunching(command, runId, paths, state, adapter) {
  const first = adapter.findLaunchProcesses(state.launchMarker);
  if (first.kind === "unverifiable")
    inspectionFailure(command, runId);
  if (first.processes.length === 0) {
    removeOwnedState(paths, state.sessionId);
    return { kind: "recovered", stoppedOwnedProcess: false };
  }
  if (first.processes.length !== 1) {
    staticFailure(command, runId, "LAUNCH_PROCESS_AMBIGUOUS", 20, "The stale launch marker does not identify exactly one browser leader.", "Inspect the marker-matched processes and private state; Warm Browser did not signal them.");
  }
  const candidate = first.processes[0];
  if (!hasLaunchContract(candidate, adapter.chromeExecutable(), state.profileRoot, state.endpoint.port, state.launchMarker))
    identityFailure(command, runId);
  const second = adapter.findLaunchProcesses(state.launchMarker);
  if (second.kind === "unverifiable")
    inspectionFailure(command, runId);
  if (second.processes.length === 0) {
    removeOwnedState(paths, state.sessionId);
    return { kind: "recovered", stoppedOwnedProcess: false };
  }
  if (second.processes.length !== 1 || !identityMatches(candidate, second.processes[0], state.profileRoot, state.endpoint.port, state.launchMarker)) {
    staticFailure(command, runId, "LAUNCH_PROCESS_AMBIGUOUS", 20, "The stale launch marker changed before cleanup.", "Inspect the marker-matched processes and private state; Warm Browser did not signal them.");
  }
  if (!await adapter.terminateProcessGroup(second.processes[0])) {
    staticFailure(command, runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not clean up its stale marked process group.", "Inspect the owned process group and private state before retrying.");
  }
  removeStateAfterStop(command, runId, paths, state.sessionId);
  return { kind: "recovered", stoppedOwnedProcess: true };
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
    if (lockAgeMs(paths, adapter.nowEpochMs()) <= startingTimeoutMs) {
      staticFailure(command, runId, "START_IN_PROGRESS", 22, "Another Warm Browser start transaction owns the session lock.", "Wait briefly, then run warm-browser status --run-id ID.", true);
    }
    staticFailure(command, runId, "PROCESS_IDENTITY_UNVERIFIED", 20, "An expired ownership lock has no durable launch intent.", "Inspect the private lock and profile processes; Warm Browser will not remove or signal them.");
  }
  if (state.phase === "launching") {
    if (adapter.nowEpochMs() - state.createdAtEpochMs <= startingTimeoutMs) {
      staticFailure(command, runId, "START_IN_PROGRESS", 22, "The owned Warm Browser launch transaction has not completed.", "Wait briefly, then run warm-browser status --run-id ID.", true);
    }
    return recoverLaunching(command, runId, paths, state, adapter);
  }
  const first = adapter.inspectProcess(state.process.pid);
  if (first.kind === "unverifiable")
    inspectionFailure(command, runId);
  if (first.kind === "absent") {
    removeOwnedState(paths, state.sessionId);
    return { kind: "recovered", stoppedOwnedProcess: false };
  }
  if (!identityMatches(state.process, first.process, state.profileRoot, state.endpoint.port, state.launchMarker))
    identityFailure(command, runId);
  if (state.phase === "starting") {
    if (adapter.nowEpochMs() - state.createdAtEpochMs <= startingTimeoutMs) {
      staticFailure(command, runId, "START_IN_PROGRESS", 22, "The owned Warm Browser start transaction has not completed.", "Wait briefly, then run warm-browser status --run-id ID.", true);
    }
    const second = adapter.inspectProcess(state.process.pid);
    if (second.kind === "unverifiable")
      inspectionFailure(command, runId);
    if (second.kind === "absent") {
      removeOwnedState(paths, state.sessionId);
      return { kind: "recovered", stoppedOwnedProcess: false };
    }
    if (!identityMatches(state.process, second.process, state.profileRoot, state.endpoint.port, state.launchMarker))
      identityFailure(command, runId);
    if (!await adapter.terminateProcessGroup(second.process)) {
      staticFailure(command, runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not clean up its stale starting process group.", "Inspect the owned process group and private state before retrying.");
    }
    removeStateAfterStop(command, runId, paths, state.sessionId);
    return { kind: "recovered", stoppedOwnedProcess: true };
  }
  const verification = await adapter.verifyEndpoint({
    host: "127.0.0.1",
    port: state.endpoint.port,
    process: first.process
  });
  if (verification.kind === "process_unverifiable")
    inspectionFailure(command, runId);
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
function recoveredStop(parsed, stoppedOwnedProcess) {
  return success({
    schemaVersion,
    status: "ok",
    command: "stop",
    resultCode: "STALE_SESSION_RECOVERED",
    runId: parsed.runId,
    transactionState: "recovered",
    retrySafe: true,
    nextAction: "Run warm-browser start --run-id ID when another Browser Session is needed.",
    data: recoveredData("stop", stoppedOwnedProcess)
  });
}
async function start(parsed, paths, adapter) {
  const inspection = await inspectSession("start", parsed.runId, paths, adapter);
  const priorTx = inspection.kind === "recovered" ? "recovered" : "unchanged";
  if (inspection.kind === "running") {
    staticFailure("start", parsed.runId, "SESSION_ALREADY_RUNNING", 21, "A verified Browser Session already owns the Agent Chrome Profile.", "Run warm-browser status --run-id ID or warm-browser stop --run-id ID.");
  }
  const executable = adapter.chromeExecutable();
  if (adapter.inspectChrome(executable) !== "installed") {
    staticFailure("start", parsed.runId, "CHROME_UNAVAILABLE", 20, "The fixed installed Google Chrome executable is unavailable.", "Install Google Chrome at the fixed macOS application path before retrying.", false, priorTx);
  }
  const profileRoot = adapter.profileRoot();
  if (adapter.inspectProfile(profileRoot) !== "safe") {
    staticFailure("start", parsed.runId, "PROFILE_UNSAFE", 21, "The Agent Chrome Profile ownership or permissions are unsafe.", "Repair the Agent Chrome Profile ownership and private permissions before retrying.", false, priorTx);
  }
  const profile = adapter.findProfileProcesses(profileRoot);
  if (profile.kind === "unverifiable")
    inspectionFailure("start", parsed.runId, priorTx);
  if (profile.processes.length > 1) {
    staticFailure("start", parsed.runId, "PROFILE_PROCESS_AMBIGUOUS", 20, "More than one live process claims the Agent Chrome Profile.", "Inspect the profile process owners before retrying; Warm Browser will not signal them.", false, priorTx);
  }
  if (profile.processes.length === 1) {
    staticFailure("start", parsed.runId, "PROFILE_IN_USE", 21, "An unowned process is using the Agent Chrome Profile.", "Close the existing profile owner, then retry Warm Browser start.", false, priorTx);
  }
  const port = parsed.port ?? defaultPort;
  const portStatus = await adapter.inspectPort(port);
  if (portStatus === "occupied") {
    staticFailure("start", parsed.runId, "PORT_OCCUPIED", 20, "The requested loopback CDP port is already occupied.", "Inspect the port owner or choose one free start --port override.", false, priorTx);
  }
  if (portStatus === "unverifiable") {
    staticFailure("start", parsed.runId, "PORT_UNVERIFIABLE", 20, "Warm Browser could not prove that the requested CDP port is free.", "Inspect loopback port state before retrying.", false, priorTx);
  }
  if (!acquireSessionLock(paths)) {
    staticFailure("start", parsed.runId, "START_IN_PROGRESS", 22, "Another start transaction acquired Browser Session ownership.", "Wait briefly, then run warm-browser status --run-id ID.", true, priorTx);
  }
  const sessionId = adapter.createSessionId();
  const launching = {
    schemaVersion: 1,
    phase: "launching",
    sessionId,
    startRunId: parsed.runId,
    launchMarker: sessionId,
    createdAtEpochMs: adapter.nowEpochMs(),
    profileRoot,
    endpoint: { host: "127.0.0.1", port }
  };
  let intentWritten = false;
  let spawned;
  try {
    writeSessionState(paths, launching);
    intentWritten = true;
    spawned = await adapter.spawnChrome({
      executable,
      profileRoot,
      port,
      launchMarker: launching.launchMarker
    });
    const starting = {
      ...launching,
      phase: "starting",
      process: canonicalProcess(spawned)
    };
    writeSessionState(paths, starting);
    const verification = await adapter.verifyEndpoint({
      host: "127.0.0.1",
      port,
      process: spawned
    });
    if (verification.kind === "process_unverifiable") {
      inspectionFailure("start", parsed.runId, priorTx);
    }
    if (verification.kind !== "verified") {
      const mapped = verification.kind === "controlled_page_unavailable" ? [
        "CONTROLLED_PAGE_UNAVAILABLE",
        "The verified CDP endpoint exposes no Controlled Page."
      ] : verification.kind === "controlled_page_ambiguous" ? [
        "CONTROLLED_PAGE_AMBIGUOUS",
        "The verified CDP endpoint exposes more than one page."
      ] : [
        "CDP_IDENTITY_UNVERIFIED",
        "The launched Chrome CDP identity could not be verified."
      ];
      if (!await adapter.terminateProcessGroup(spawned)) {
        staticFailure("start", parsed.runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not roll back its unverified browser process group.", "Inspect the owned process group and private state before retrying.");
      }
      removeOwnedState(paths, sessionId);
      staticFailure("start", parsed.runId, mapped[0], 20, mapped[1], "Inspect installed Chrome and the explicit CDP endpoint before retrying.", false, "rolled_back");
    }
    const state = runningState(starting, verification.endpoint);
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
        recoveredFrom: inspection.kind === "recovered" ? "stale_session" : null
      }
    });
  } catch (error) {
    if (error instanceof WarmBrowserFailure)
      throw error;
    if (error instanceof SpawnCleanupUnverifiedError) {
      launchCleanupUnverified(parsed.runId, priorTx);
    }
    if (spawned !== undefined) {
      if (!await adapter.terminateProcessGroup(spawned)) {
        launchCleanupUnverified(parsed.runId, priorTx);
      }
      removeOwnedState(paths, sessionId);
    } else if (intentWritten) {
      removeOwnedState(paths, sessionId);
    } else {
      removeNewEmptyLock(paths);
    }
    staticFailure("start", parsed.runId, "UNEXPECTED_FAILURE", 1, "Warm Browser start failed unexpectedly.", "Inspect private state and the owned process group before retrying.", false, "rolled_back");
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
    return recoveredStop(parsed, inspection.stoppedOwnedProcess ?? false);
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
  if (observed.kind === "unverifiable")
    inspectionFailure("stop", parsed.runId);
  if (observed.kind === "absent") {
    removeOwnedState(paths, state.sessionId);
    return recoveredStop(parsed, false);
  }
  if (!identityMatches(state.process, observed.process, state.profileRoot, state.endpoint.port, state.launchMarker))
    identityFailure("stop", parsed.runId);
  if (!await adapter.terminateProcessGroup(observed.process)) {
    staticFailure("stop", parsed.runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not stop its verified browser process group.", "Inspect the owned process group and private state before retrying.");
  }
  removeStateAfterStop("stop", parsed.runId, paths, state.sessionId);
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
        usage: usageLine,
        commands: commandVocabulary.map(({ name, sideEffects }) => ({ name, sideEffects }))
      }
    });
  }
  if (adapter.platform() !== "darwin") {
    staticFailure(parsed.command, parsed.runId, "PLATFORM_UNSUPPORTED", 21, "Warm Browser supports macOS only.", "Run Warm Browser on a supported macOS host.");
  }
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
