// @bun
// packages/agent-browser/src/modules/warm-browser/contract.ts
var schemaVersion = 1;
var runIdOption = { flag: "--run-id", value: "ID", required: false };
var refusedSelectorFlags = ["--selector", "--css", "--xpath", "--text"];
var commandVocabulary = [
  { name: "help", sideEffects: "none", options: [] },
  {
    name: "start",
    sideEffects: "may stop a proved stale owned browser process group and invalidate every earlier Snapshot Reference, then starts one owned browser process group",
    options: [{ flag: "--port", value: "NUMBER", required: false }]
  },
  {
    name: "status",
    sideEffects: "may stop a proved stale owned browser process group, remove its private state, and invalidate every earlier Snapshot Reference",
    options: []
  },
  {
    name: "open",
    sideEffects: "navigates the one Controlled Page and invalidates every earlier Snapshot Reference",
    options: [
      { flag: "--url", value: "URL", required: true },
      { flag: "--adopt-page", value: null, required: false }
    ]
  },
  {
    name: "snapshot",
    sideEffects: "reads the Controlled Page and replaces every earlier Snapshot Reference",
    options: []
  },
  {
    name: "click",
    sideEffects: "dispatches one click on one referenced element of the Controlled Page and may invalidate every earlier Snapshot Reference",
    options: [{ flag: "--ref", value: "REFERENCE", required: true }]
  },
  {
    name: "fill",
    sideEffects: "types one non-secret value into one referenced empty field of the Controlled Page and may invalidate every earlier Snapshot Reference",
    options: [
      { flag: "--ref", value: "REFERENCE", required: true },
      { flag: "--value", value: "TEXT", required: true }
    ]
  },
  {
    name: "stop",
    sideEffects: "stops one verified owned browser process group and removes its private state, including every Snapshot Reference",
    options: []
  }
];

class SpawnCleanupUnverifiedError extends Error {
  constructor() {
    super("spawned Chrome process-group cleanup could not be verified");
    this.name = "SpawnCleanupUnverifiedError";
  }
}

// packages/agent-browser/src/modules/warm-browser/bounds.ts
var portProbeTimeoutMs = 300;
var spawnConfirmationAttempts = 20;
var spawnConfirmationPauseMs = 25;
var endpointAttempts = 40;
var endpointPauseMs = 100;
var loopbackReadTimeoutMs = 500;
var loopbackReadsPerAttempt = 2;
var groupAbsenceAttempts = 40;
var groupAbsencePauseMs = 50;
var escalatedAbsenceAttempts = 20;
var startBudgetMs = portProbeTimeoutMs + spawnConfirmationAttempts * spawnConfirmationPauseMs + endpointAttempts * (loopbackReadsPerAttempt * loopbackReadTimeoutMs + endpointPauseMs) + (groupAbsenceAttempts + escalatedAbsenceAttempts) * groupAbsencePauseMs;
var startingTimeoutMs = startBudgetMs * 2;
var pageConnectTimeoutMs = 2000;
var pageCallTimeoutMs = 5000;
var snapshotReferenceTimeoutMs = 60000;
var snapshotElementLimit = 500;
var snapshotTextLimit = 256;
var fillValueLimit = 4096;

// packages/agent-browser/src/modules/warm-browser/cdp-channel.ts
var failedReply = { ok: false, result: undefined };
async function openCdpChannel(webSocketUrl) {
  let socket;
  try {
    socket = new WebSocket(webSocketUrl);
  } catch {
    return { kind: "unavailable" };
  }
  const pending = new Map;
  let closed = false;
  function releaseAll() {
    closed = true;
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      pending.delete(id);
      call.settle(failedReply);
    }
  }
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.id !== "number")
      return;
    const call = pending.get(message.id);
    if (call === undefined)
      return;
    clearTimeout(call.timer);
    pending.delete(message.id);
    call.settle(message.error === undefined && message.result !== undefined ? { ok: true, result: message.result } : failedReply);
  });
  socket.addEventListener("close", releaseAll);
  socket.addEventListener("error", releaseAll);
  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), pageConnectTimeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!opened) {
    try {
      socket.close();
    } catch {}
    return { kind: "unavailable" };
  }
  let nextCallId = 0;
  const channel = {
    call: async (method, parameters) => {
      if (closed)
        return failedReply;
      nextCallId += 1;
      const id = nextCallId;
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(failedReply);
        }, pageCallTimeoutMs);
        pending.set(id, { settle: resolve, timer });
        try {
          socket.send(JSON.stringify({ id, method, params: parameters }));
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          resolve(failedReply);
        }
      });
    },
    close: () => {
      releaseAll();
      try {
        socket.close();
      } catch {}
    }
  };
  return { kind: "open", channel };
}

// packages/agent-browser/src/modules/warm-browser/credential-fields.ts
var credentialInputTypes = ["password"];
var credentialAutocompleteTokens = [
  "current-password",
  "new-password",
  "one-time-code",
  "username"
];
var credentialIdentifierFragments = [
  "password",
  "passwd",
  "passphrase",
  "passcode",
  "pwd",
  "otp",
  "totp",
  "2fa",
  "mfa",
  "securitycode",
  "verificationcode",
  "username",
  "userid",
  "login",
  "email"
];
var identifierAttributes = ["name", "id", "autocomplete", "aria-label", "placeholder"];
function normalise(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}
function isCredentialField(description, accessibleName = "") {
  if (description === undefined)
    return true;
  const attributes = description.attributes;
  const type = (attributes.type ?? "").trim().toLowerCase();
  if (credentialInputTypes.includes(type))
    return true;
  const autocomplete = (attributes.autocomplete ?? "").trim().toLowerCase().split(/\s+/);
  if (autocomplete.some((token) => credentialAutocompleteTokens.includes(token))) {
    return true;
  }
  const identifier = [
    ...identifierAttributes.map((attribute) => normalise(attributes[attribute] ?? "")),
    normalise(accessibleName)
  ].join(" ");
  return credentialIdentifierFragments.some((fragment) => identifier.includes(fragment));
}

// packages/agent-browser/src/modules/warm-browser/controlled-page.ts
var addressableTargetId = /^[A-Za-z0-9_-]{1,128}$/;
function isAddressableTargetId(value) {
  return typeof value === "string" && addressableTargetId.test(value);
}
var actionableRoles = [
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textarea",
  "textbox"
];
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
function nonEmptyText(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}
function readableText(value) {
  if (typeof value !== "string")
    return "";
  return value.replaceAll(/\s+/gu, " ").trim().slice(0, snapshotTextLimit);
}
function readBasisReply(targetId, reply) {
  const frame = record(record(record(reply)?.frameTree)?.frame);
  const frameId = nonEmptyText(frame?.id);
  const loaderId = nonEmptyText(frame?.loaderId);
  const url = nonEmptyText(frame?.url);
  return frameId === undefined || loaderId === undefined || url === undefined ? undefined : { targetId, frameId, loaderId, url };
}
function sameBasis(left, right) {
  return left.targetId === right.targetId && left.frameId === right.frameId && left.loaderId === right.loaderId && left.url === right.url;
}
async function readBasis(channel, targetId) {
  const reply = await channel.call("Page.getFrameTree", {});
  return reply.ok ? readBasisReply(targetId, reply.result) : undefined;
}
function attributeMap(attributes) {
  const flat = Array.isArray(attributes) ? attributes : [];
  const map = {};
  for (let index = 0;index + 1 < flat.length; index += 2) {
    const name = flat[index];
    const value = flat[index + 1];
    if (typeof name === "string" && typeof value === "string")
      map[name] = value;
  }
  return map;
}
function describedNode(node) {
  const nodeName = nonEmptyText(node.nodeName);
  return nodeName === undefined ? undefined : { nodeName, attributes: attributeMap(node.attributes) };
}
function documentReading(reply) {
  const root = record(record(reply)?.root);
  if (root === undefined)
    return;
  const descriptions = new Map;
  const parents = new Map;
  const queue = [
    { node: root, parent: undefined }
  ];
  while (queue.length > 0) {
    const { node, parent } = queue.pop();
    const backendNodeId = node.backendNodeId;
    const identified = typeof backendNodeId === "number" ? backendNodeId : undefined;
    const description = describedNode(node);
    if (identified !== undefined) {
      if (description !== undefined)
        descriptions.set(identified, description);
      if (parent !== undefined)
        parents.set(identified, parent);
    }
    const nested = identified ?? parent;
    for (const key of ["children", "shadowRoots", "pseudoElements"]) {
      for (const child of Array.isArray(node[key]) ? node[key] : []) {
        const childRecord = record(child);
        if (childRecord !== undefined)
          queue.push({ node: childRecord, parent: nested });
      }
    }
    const contentDocument = record(node.contentDocument);
    if (contentDocument !== undefined)
      queue.push({ node: contentDocument, parent: nested });
  }
  return { descriptions, parents };
}
async function readDocument(channel) {
  const document = await channel.call("DOM.getDocument", { depth: -1, pierce: true });
  return document.ok ? documentReading(document.result) : undefined;
}
function isWithin(parents, node, ancestor) {
  let current = node;
  for (let step = 0;step < 128 && current !== undefined; step += 1) {
    if (current === ancestor)
      return true;
    current = parents.get(current);
  }
  return false;
}
function hasProperty(node, name) {
  const properties = Array.isArray(node.properties) ? node.properties : [];
  return properties.some((property) => {
    const entry = record(property);
    return entry?.name === name && record(entry.value)?.value === true;
  });
}
function nodeAccessibility(reply, backendNodeId) {
  const nodes = record(reply)?.nodes;
  if (!Array.isArray(nodes))
    return;
  for (const entry of nodes) {
    const node = record(entry);
    if (node === undefined || node.backendDOMNodeId !== backendNodeId)
      continue;
    const value = record(node.value)?.value;
    return {
      name: readableText(record(node.name)?.value),
      holdsValue: typeof value === "string" && value !== "",
      focused: hasProperty(node, "focused")
    };
  }
  return;
}
async function readNodeAccessibility(channel, backendNodeId) {
  const reply = await channel.call("Accessibility.getPartialAXTree", {
    backendNodeId,
    fetchRelatives: false
  });
  return reply.ok ? nodeAccessibility(reply.result, backendNodeId) : undefined;
}
function accessibilityNodes(reply) {
  const nodes = record(reply)?.nodes;
  if (!Array.isArray(nodes))
    return;
  const readings = [];
  for (const entry of nodes) {
    const node = record(entry);
    if (node === undefined)
      return;
    const backendNodeId = node.backendDOMNodeId;
    if (typeof backendNodeId !== "number" || !Number.isSafeInteger(backendNodeId) || backendNodeId < 1)
      continue;
    readings.push({
      role: readableText(record(node.role)?.value),
      name: readableText(record(node.name)?.value),
      focusable: hasProperty(node, "focusable"),
      ignored: node.ignored === true,
      backendNodeId
    });
  }
  return readings;
}
function interpretElements(nodes, descriptions) {
  const elements = [];
  let truncated = false;
  for (const node of nodes) {
    if (node.ignored)
      continue;
    const description = descriptions.get(node.backendNodeId);
    const credentialField = isCredentialField(description, node.name);
    const actionable = node.focusable || actionableRoles.includes(node.role);
    if (!actionable && !(description !== undefined && credentialField))
      continue;
    if (elements.length === snapshotElementLimit) {
      truncated = true;
      break;
    }
    elements.push({
      backendNodeId: node.backendNodeId,
      role: node.role,
      name: node.name,
      credentialField
    });
  }
  return { elements, truncated };
}
async function withControlledPage(port, targetId, unverified, work) {
  if (!isAddressableTargetId(targetId))
    return unverified;
  const connection = await openCdpChannel(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  if (connection.kind === "unavailable")
    return unverified;
  try {
    return await work(connection.channel);
  } catch {
    return unverified;
  } finally {
    connection.channel.close();
  }
}
async function openControlledPage(input) {
  return await withControlledPage(input.port, input.targetId, { kind: "unverified" }, async (channel) => {
    if (!(await channel.call("Page.enable", {})).ok)
      return { kind: "unverified" };
    const navigation = await channel.call("Page.navigate", { url: input.url });
    if (!navigation.ok)
      return { kind: "unverified" };
    const accepted = record(navigation.result);
    if (nonEmptyText(accepted?.errorText) !== undefined)
      return { kind: "refused" };
    const frameId = nonEmptyText(accepted?.frameId);
    const loaderId = nonEmptyText(accepted?.loaderId);
    if (frameId === undefined || loaderId === undefined)
      return { kind: "unverified" };
    const basis = await readBasis(channel, input.targetId);
    if (basis === undefined)
      return { kind: "unverified" };
    return basis.frameId === frameId && basis.loaderId === loaderId ? { kind: "navigated", basis } : { kind: "superseded" };
  });
}
async function readControlledPageSnapshot(input) {
  return await withControlledPage(input.port, input.targetId, { kind: "unverified" }, async (channel) => {
    for (const method of ["Page.enable", "DOM.enable", "Accessibility.enable"]) {
      if (!(await channel.call(method, {})).ok)
        return { kind: "unverified" };
    }
    const before = await readBasis(channel, input.targetId);
    if (before === undefined)
      return { kind: "unverified" };
    const reading = await readDocument(channel);
    if (reading === undefined)
      return { kind: "unverified" };
    const tree = await channel.call("Accessibility.getFullAXTree", {});
    if (!tree.ok)
      return { kind: "unverified" };
    const nodes = accessibilityNodes(tree.result);
    if (nodes === undefined)
      return { kind: "unverified" };
    const after = await readBasis(channel, input.targetId);
    if (after === undefined)
      return { kind: "unverified" };
    if (!sameBasis(before, after))
      return { kind: "identity_changed" };
    const { elements, truncated } = interpretElements(nodes, reading.descriptions);
    return { kind: "observed", basis: after, elements, truncated };
  });
}
function undeliverable(reason) {
  return { kind: "undeliverable", reason };
}
function mayNavigate(description) {
  const attributes = description.attributes;
  const nodeName = description.nodeName.toUpperCase();
  const type = (attributes.type ?? "").trim().toLowerCase();
  if ((nodeName === "A" || nodeName === "AREA") && nonEmptyText(attributes.href) !== undefined) {
    return true;
  }
  if (type === "submit" || type === "image")
    return true;
  return nodeName === "BUTTON" && attributes.type === undefined;
}
function contentPoint(reply) {
  const quads = record(reply)?.quads;
  const quad = Array.isArray(quads) ? quads[0] : undefined;
  if (!Array.isArray(quad) || quad.length < 8)
    return;
  const corners = quad.slice(0, 8);
  if (!corners.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return;
  }
  return {
    x: Math.round((corners[0] + corners[2] + corners[4] + corners[6]) / 4),
    y: Math.round((corners[1] + corners[3] + corners[5] + corners[7]) / 4)
  };
}
async function hitsReferencedNode(channel, point, backendNodeId) {
  const hit = await channel.call("DOM.getNodeForLocation", {
    x: point.x,
    y: point.y,
    includeUserAgentShadowDOM: false
  });
  if (!hit.ok)
    return false;
  const hitNodeId = record(hit.result)?.backendNodeId;
  if (typeof hitNodeId !== "number")
    return false;
  if (hitNodeId === backendNodeId)
    return true;
  const reading = await readDocument(channel);
  return reading !== undefined && isWithin(reading.parents, hitNodeId, backendNodeId);
}
async function clickNode(channel, backendNodeId) {
  if (!(await channel.call("DOM.scrollIntoViewIfNeeded", { backendNodeId })).ok) {
    return undeliverable("click_target_unproved");
  }
  const quads = await channel.call("DOM.getContentQuads", { backendNodeId });
  if (!quads.ok)
    return { kind: "element_absent" };
  const point = contentPoint(quads.result);
  if (point === undefined)
    return undeliverable("click_target_unproved");
  if (!await hitsReferencedNode(channel, point, backendNodeId)) {
    return undeliverable("click_target_unproved");
  }
  for (const type of ["mousePressed", "mouseReleased"]) {
    const dispatched = await channel.call("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1
    });
    if (!dispatched.ok)
      return { kind: "unverified" };
  }
  return { kind: "acted" };
}
async function typeIntoNode(channel, backendNodeId, value) {
  if (!(await channel.call("DOM.focus", { backendNodeId })).ok) {
    return undeliverable("field_not_focusable");
  }
  const focused = await readNodeAccessibility(channel, backendNodeId);
  if (focused === undefined)
    return undeliverable("field_unreadable");
  if (!focused.focused)
    return undeliverable("field_focus_moved");
  return (await channel.call("Input.insertText", { text: value })).ok ? { kind: "acted" } : { kind: "unverified" };
}
function outcomeAfterAct(input) {
  if (sameBasis(input.after, input.atDispatch))
    return { kind: "acted", basis: input.after };
  return input.action.kind === "click" && mayNavigate(input.description) ? { kind: "acted", basis: input.after } : { kind: "superseded" };
}
async function refuseUnfillableField(channel, backendNodeId, description) {
  if (!(await channel.call("Accessibility.enable", {})).ok)
    return { kind: "unverified" };
  const field = await readNodeAccessibility(channel, backendNodeId);
  if (field === undefined)
    return { kind: "undeliverable", reason: "field_unreadable" };
  if (isCredentialField(description, field.name))
    return { kind: "credential_field" };
  return field.holdsValue ? { kind: "undeliverable", reason: "field_not_empty" } : undefined;
}
async function actOnControlledPage(input) {
  return await withControlledPage(input.port, input.targetId, { kind: "unverified" }, async (channel) => {
    for (const method of ["Page.enable", "DOM.enable"]) {
      if (!(await channel.call(method, {})).ok)
        return { kind: "unverified" };
    }
    const before = await readBasis(channel, input.targetId);
    if (before === undefined)
      return { kind: "unverified" };
    if (!sameBasis(before, input.basis))
      return { kind: "identity_changed" };
    const described = await channel.call("DOM.describeNode", {
      backendNodeId: input.backendNodeId
    });
    if (!described.ok)
      return { kind: "element_absent" };
    const description = describedNode(record(record(described.result)?.node) ?? {});
    if (description === undefined)
      return { kind: "element_absent" };
    if (input.action.kind === "fill") {
      const refusal = await refuseUnfillableField(channel, input.backendNodeId, description);
      if (refusal !== undefined)
        return refusal;
    }
    const atDispatch = await readBasis(channel, input.targetId);
    if (atDispatch === undefined)
      return { kind: "unverified" };
    if (!sameBasis(atDispatch, input.basis))
      return { kind: "identity_changed" };
    const step = input.action.kind === "click" ? await clickNode(channel, input.backendNodeId) : await typeIntoNode(channel, input.backendNodeId, input.action.value);
    if (step.kind !== "acted")
      return step;
    const after = await readBasis(channel, input.targetId);
    if (after === undefined)
      return { kind: "unverified" };
    return outcomeAfterAct({ action: input.action, description, atDispatch, after });
  });
}

// packages/agent-browser/src/modules/warm-browser/ownership.ts
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
function launchOwnership(input) {
  const argumentList = chromeArgumentList(input);
  return {
    executable: input.executable,
    commandLine: [input.executable, ...argumentList].join(" ")
  };
}
function commandHasArgument(commandLine, argument) {
  return ` ${commandLine} `.includes(` ${argument} `);
}
function isOwnedLaunch(observed, ownership) {
  return observed.processGroupId === observed.pid && observed.executable === ownership.executable && observed.commandLine === ownership.commandLine && observed.startedAtToken !== "";
}
function isSameProcess(expected, observed) {
  return observed !== undefined && observed.pid === expected.pid && observed.processGroupId === expected.processGroupId && observed.startedAtToken === expected.startedAtToken && observed.executable === expected.executable && observed.commandLine === expected.commandLine;
}
function ownsProcess(expected, observed, ownership) {
  return isSameProcess(expected, observed) && isOwnedLaunch(observed, ownership);
}

// packages/agent-browser/src/modules/warm-browser/production-adapter.ts
import { randomUUID } from "crypto";
import { existsSync, lstatSync as lstatSync2 } from "fs";
import { homedir } from "os";
import { join } from "path";

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
    socket.setTimeout(portProbeTimeoutMs, () => finish("unverifiable"));
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
  const response = await fetch(url, { signal: AbortSignal.timeout(loopbackReadTimeoutMs) });
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
function privateOwnedDirectory(path) {
  if (!existsSync(path))
    return false;
  const metadata = lstatSync2(path);
  return metadata.isDirectory() && !metadata.isSymbolicLink() && (typeof process.getuid !== "function" || metadata.uid === process.getuid()) && (metadata.mode & 63) === 0;
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
    await pause(groupAbsencePauseMs);
  }
  return "present";
}
async function terminateProcessGroupWithEscalation(expected, ownership) {
  const processGroupId = expected.processGroupId;
  const requested = signalProcessGroup(processGroupId, "SIGTERM");
  if (requested === "absent")
    return true;
  if (requested !== "delivered")
    return false;
  const afterTermination = await awaitProcessGroupAbsence(processGroupId, groupAbsenceAttempts);
  if (afterTermination !== "present")
    return afterTermination === "absent";
  const table = processTable();
  if (table.kind === "unverifiable")
    return false;
  const remaining = table.processes.filter((processIdentity) => processIdentity.processGroupId === processGroupId);
  if (remaining.length === 0)
    return true;
  const observed = remaining.find((processIdentity) => processIdentity.pid === expected.pid);
  if (!ownsProcess(expected, observed, ownership))
    return false;
  const escalated = signalProcessGroup(processGroupId, "SIGKILL");
  if (escalated === "absent")
    return true;
  if (escalated !== "delivered")
    return false;
  return await awaitProcessGroupAbsence(processGroupId, escalatedAbsenceAttempts) === "absent";
}
async function readEndpoint(port, expected) {
  for (let attempt = 0;attempt < endpointAttempts; attempt += 1) {
    const table = processTable();
    if (table.kind === "unverifiable")
      return { kind: "process_unverifiable" };
    const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid);
    if (!isSameProcess(expected, observed))
      return { kind: "browser_unverified" };
    const owner = loopbackListenerOwner(port);
    if (owner === "unverifiable" || owner !== "absent" && owner !== expected.pid) {
      return { kind: "listener_unverified" };
    }
    if (owner === "absent") {
      if (attempt === endpointAttempts - 1)
        return { kind: "listener_unverified" };
      await pause(endpointPauseMs);
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
      const pages = targets.filter((target) => target.type === "page" && isAddressableTargetId(target.id));
      if (pages.length === 0) {
        if (attempt === endpointAttempts - 1)
          return { kind: "controlled_page_unavailable" };
        await pause(endpointPauseMs);
        continue;
      }
      if (pages.length !== 1)
        return { kind: "controlled_page_ambiguous" };
      const settled = processTable();
      if (settled.kind === "unverifiable")
        return { kind: "process_unverifiable" };
      if (!isSameProcess(expected, settled.processes.find((processIdentity) => processIdentity.pid === expected.pid))) {
        return { kind: "browser_unverified" };
      }
      if (loopbackListenerOwner(port) !== expected.pid)
        return { kind: "listener_unverified" };
      return {
        kind: "verified",
        endpoint: {
          browserVersion: version.Browser,
          controlledPageTargetId: pages[0].id
        }
      };
    } catch {
      if (attempt === endpointAttempts - 1)
        return { kind: "browser_unverified" };
      await pause(endpointPauseMs);
    }
  }
  return { kind: "browser_unverified" };
}
var productionAdapter = {
  createRunId: () => `wb-${randomUUID()}`,
  createSessionId: () => `session-${randomUUID()}`,
  createSnapshotId: () => `snapshot-${randomUUID()}`,
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
  spawnChrome: async ({ executable, argumentList, ownership }) => {
    const launchedPid = await startDetachedProcess(executable, argumentList);
    for (let attempt = 0;attempt < spawnConfirmationAttempts; attempt += 1) {
      const table = processTable();
      if (table.kind === "unverifiable")
        throw new SpawnCleanupUnverifiedError;
      const observed = table.processes.find((processIdentity) => processIdentity.pid === launchedPid);
      if (observed !== undefined) {
        if (!isOwnedLaunch(observed, ownership))
          throw new SpawnCleanupUnverifiedError;
        return observed;
      }
      await pause(spawnConfirmationPauseMs);
    }
    throw new SpawnCleanupUnverifiedError;
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
    if (!isSameProcess(expected, observed))
      return { kind: "browser_unverified" };
    return readEndpoint(port, expected);
  },
  terminateProcessGroup: async (expected, ownership) => {
    const table = processTable();
    if (table.kind === "unverifiable")
      return false;
    const observed = table.processes.find((processIdentity) => processIdentity.pid === expected.pid);
    if (!ownsProcess(expected, observed, ownership))
      return false;
    return terminateProcessGroupWithEscalation(expected, ownership);
  }
};

// packages/agent-browser/src/modules/warm-browser/snapshot.ts
var referencePattern = /^e([1-9][0-9]{0,3})@([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
function snapshotReference(generationId, ordinal) {
  return `e${ordinal}@${generationId}`;
}
function publishedElements(generation) {
  return generation.elements.map((element, index) => ({
    ref: snapshotReference(generation.generationId, index + 1),
    role: element.role,
    name: element.name,
    credentialField: element.credentialField
  }));
}
function resolveSnapshotReference(input) {
  const match = referencePattern.exec(input.reference);
  if (match === null)
    return { kind: "malformed" };
  const generation = input.generation;
  if (generation === undefined)
    return { kind: "absent" };
  if (match[2] !== generation.generationId)
    return { kind: "stale" };
  const age = input.nowEpochMs - generation.takenAtEpochMs;
  if (age < 0 || age > snapshotReferenceTimeoutMs)
    return { kind: "stale" };
  if (generation.basis.targetId !== input.controlledPageTargetId)
    return { kind: "stale" };
  const ordinal = Number(match[1]);
  const element = generation.elements[ordinal - 1];
  return element === undefined ? { kind: "unknown" } : { kind: "resolved", ordinal, element };
}

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
function detachedCleanupExists(paths) {
  return readdirSync(paths.root).some((entry) => entry.startsWith(".cleanup-"));
}
function ensurePrivateState(paths) {
  mkdirSync(dirname(paths.root), { recursive: true, mode: 448 });
  exactPrivateDirectory(dirname(paths.root));
  exactPrivateDirectory(paths.root);
  if (detachedCleanupExists(paths))
    throw new UnsafeStateError;
}
function acquireSessionLock(paths) {
  try {
    mkdirSync(paths.lock, { mode: 448 });
    chmodSync(paths.lock, 448);
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
    validateSessionLock(paths);
    return false;
  }
  if (detachedCleanupExists(paths)) {
    rmdirSync(paths.lock);
    throw new UnsafeStateError;
  }
  return true;
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
var identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function isIdentifier(value) {
  return typeof value === "string" && identifier.test(value);
}
function isEpochMs(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function isProcessIdentifier(value) {
  return Number.isSafeInteger(value) && value >= 1;
}
function isPort(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}
function isNonEmptyString(value) {
  return typeof value === "string" && value !== "";
}
function processShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const processIdentity = value;
  return isProcessIdentifier(processIdentity.pid) && isProcessIdentifier(processIdentity.processGroupId) && isNonEmptyString(processIdentity.startedAtToken) && isNonEmptyString(processIdentity.executable) && isNonEmptyString(processIdentity.commandLine);
}
function isBoundedText(value) {
  return typeof value === "string" && value.length <= snapshotTextLimit;
}
function basisShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const basis = value;
  return isNonEmptyString(basis.targetId) && isNonEmptyString(basis.frameId) && isNonEmptyString(basis.loaderId) && isNonEmptyString(basis.url);
}
function elementShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const element = value;
  return isProcessIdentifier(element.backendNodeId) && isBoundedText(element.role) && isBoundedText(element.name) && typeof element.credentialField === "boolean";
}
function snapshotShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const generation = value;
  return isIdentifier(generation.generationId) && isEpochMs(generation.takenAtEpochMs) && basisShape(generation.basis) && typeof generation.truncated === "boolean" && Array.isArray(generation.elements) && generation.elements.length <= snapshotElementLimit && generation.elements.every(elementShape);
}
function launchShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const launch = value;
  return isNonEmptyString(launch.executable) && isNonEmptyString(launch.commandLine);
}
function endpointShape(value, verified) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const endpoint = value;
  if (endpoint.host !== "127.0.0.1" || !isPort(endpoint.port))
    return false;
  return verified ? isNonEmptyString(endpoint.browserVersion) && isNonEmptyString(endpoint.controlledPageTargetId) : endpoint.browserVersion === undefined && endpoint.controlledPageTargetId === undefined;
}
function commonShape(state) {
  return state.schemaVersion === 1 && isIdentifier(state.sessionId) && isIdentifier(state.startRunId) && isIdentifier(state.launchMarker) && isEpochMs(state.createdAtEpochMs) && isNonEmptyString(state.profileRoot) && launchShape(state.launch);
}
function phaseShape(state) {
  if (state.phase === "launching") {
    return !("process" in state) && endpointShape(state.endpoint, false);
  }
  if (state.phase === "starting") {
    return processShape(state.process) && endpointShape(state.endpoint, false);
  }
  if (state.phase === "running") {
    const running = state;
    return processShape(running.process) && endpointShape(state.endpoint, true) && (running.snapshot === undefined || snapshotShape(running.snapshot));
  }
  return false;
}
function stateShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const state = value;
  if (!commonShape(state))
    return false;
  if (state.phase !== "running" && "snapshot" in state)
    return false;
  return phaseShape(state);
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
  if (!stateShape(state))
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
function removeOwnedState(paths, sessionId) {
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
var runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var controlCharacter = /\p{Cc}/u;
var commandNames = new Set(commandVocabulary.map(({ name }) => name));
var selectorFlags = new Set(refusedSelectorFlags);
function renderOption(option) {
  return option.value === null ? `[${option.flag}]` : `[${option.flag} ${option.value}]`;
}
var usageLine = `warm-browser <${commandVocabulary.map(({ name }) => name).join("|")}> ${[
  runIdOption,
  ...commandVocabulary.flatMap(({ options }) => options)
].filter((option, index, all) => all.findIndex((other) => other.flag === option.flag) === index).map(renderOption).join(" ")}`;

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
function selectorRefusal(runId, command, flag) {
  raise({
    command,
    resultCode: "SELECTOR_UNSUPPORTED",
    exitCode: 21,
    runId,
    retrySafe: false,
    nextAction: "Run warm-browser snapshot --run-id ID and act through the references it issues.",
    message: `Warm Browser acts through Snapshot References, not the ${flag} selector.`
  });
}
var optionFlag = /^--[a-z][a-z0-9-]{0,31}$/;
function unsupportedArgument(argument) {
  return optionFlag.test(argument) ? `Warm Browser does not accept the ${argument} option here.` : "Warm Browser accepts options here, and this argument is not one.";
}
function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return;
  }
}
var optionValidators = {
  "--run-id": (runId, command, raw) => {
    if (!runIdPattern.test(raw))
      usage(runId, command, "The --run-id value is missing or invalid.");
    return raw;
  },
  "--port": (runId, command, raw) => {
    if (!/^[0-9]+$/.test(raw))
      usage(runId, command, "The --port value must be a decimal port number.");
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      usage(runId, command, "The --port value must be between 1024 and 65535.");
    }
    return port;
  },
  "--url": (runId, command, raw) => {
    const parsed = raw.length > 2048 || controlCharacter.test(raw) ? undefined : safeUrl(raw);
    if (parsed === undefined)
      usage(runId, command, "The --url value must be an absolute URL.");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      raise({
        command,
        resultCode: "NAVIGATION_TARGET_REFUSED",
        exitCode: 21,
        runId,
        retrySafe: false,
        nextAction: "Run warm-browser open --url URL --run-id ID with an http or https address.",
        message: "Warm Browser opens http and https pages only."
      });
    }
    return raw;
  },
  "--ref": (runId, command, raw) => {
    if (raw === "" || raw.length > 160 || /\s/u.test(raw) || controlCharacter.test(raw)) {
      usage(runId, command, "The --ref value is missing or invalid.");
    }
    return raw;
  },
  "--value": (runId, command, raw) => {
    if (raw === "" || raw.length > fillValueLimit || controlCharacter.test(raw)) {
      usage(runId, command, "The --value text is missing or invalid.");
    }
    return raw;
  }
};
function readOptions(arguments_, firstOptionIndex, command, accepted, generatedRunId) {
  const seen = new Map;
  let runId = generatedRunId;
  for (let index = firstOptionIndex;index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (selectorFlags.has(argument))
      selectorRefusal(runId, command, argument);
    const option = accepted.get(argument);
    if (option === undefined)
      usage(runId, command, unsupportedArgument(argument));
    if (seen.has(option.flag))
      usage(runId, command, `The ${option.flag} flag may appear only once.`);
    if (option.value === null) {
      seen.set(option.flag, true);
      continue;
    }
    const raw = arguments_[index + 1];
    if (raw === undefined)
      usage(runId, command, `The ${option.flag} value is missing.`);
    const value = optionValidators[option.flag](runId, command, raw);
    seen.set(option.flag, value);
    if (option.flag === runIdOption.flag)
      runId = value;
    index += 1;
  }
  return { seen, runId };
}
function parseArguments(arguments_, adapter) {
  const generatedRunId = candidateRunId(arguments_, adapter);
  const first = arguments_[0];
  const command = first === undefined || first === "--help" || first === "-h" ? "help" : commandNames.has(first) ? first : "unknown";
  if (command === "unknown") {
    if (first !== undefined && selectorFlags.has(first)) {
      selectorRefusal(generatedRunId, command, first);
    }
    usage(generatedRunId, command, "Unknown Warm Browser command.");
  }
  const accepted = new Map([
    [runIdOption.flag, runIdOption],
    ...commandVocabulary.find(({ name }) => name === command).options.map((option) => [option.flag, option])
  ]);
  const { seen, runId } = readOptions(arguments_, first === undefined ? 0 : 1, command, accepted, generatedRunId);
  for (const option of accepted.values()) {
    if (option.required && !seen.has(option.flag)) {
      usage(runId, command, `The ${option.flag} option is required by ${command}.`);
    }
  }
  const port = seen.get("--port");
  const url = seen.get("--url");
  const reference = seen.get("--ref");
  const value = seen.get("--value");
  return {
    command,
    runId,
    adoptPage: seen.get("--adopt-page") === true,
    ...port === undefined ? {} : { port },
    ...url === undefined ? {} : { url },
    ...reference === undefined ? {} : { reference },
    ...value === undefined ? {} : { value }
  };
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
function endpointRefusal(verification, subject) {
  if (verification === "controlled_page_unavailable") {
    return ["CONTROLLED_PAGE_UNAVAILABLE", "The verified CDP endpoint exposes no Controlled Page."];
  }
  if (verification === "controlled_page_ambiguous") {
    return ["CONTROLLED_PAGE_AMBIGUOUS", "The verified CDP endpoint exposes more than one page."];
  }
  return ["CDP_IDENTITY_UNVERIFIED", `The ${subject} identity could not be verified.`];
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
function adoptControlledPage(state, controlledPageTargetId) {
  const rebound = withoutSnapshot(state);
  return { ...rebound, endpoint: { ...rebound.endpoint, controlledPageTargetId } };
}
function recoverAbsentLaunch(command, runId, paths, state, adapter) {
  const owners = adapter.findProfileProcesses(state.profileRoot);
  if (owners.kind === "unverifiable")
    inspectionFailure(command, runId);
  if (owners.processes.length > 0)
    identityFailure(command, runId);
  removeOwnedState(paths, state.sessionId);
  return { kind: "recovered", stoppedOwnedProcess: false };
}
async function recoverLaunching(command, runId, paths, state, adapter) {
  const first = adapter.findLaunchProcesses(state.launchMarker);
  if (first.kind === "unverifiable")
    inspectionFailure(command, runId);
  if (first.processes.length === 0) {
    return recoverAbsentLaunch(command, runId, paths, state, adapter);
  }
  if (first.processes.length !== 1) {
    staticFailure(command, runId, "LAUNCH_PROCESS_AMBIGUOUS", 20, "The stale launch marker does not identify exactly one browser leader.", "Inspect the marker-matched processes and private state; Warm Browser did not signal them.");
  }
  const candidate = first.processes[0];
  if (!isOwnedLaunch(candidate, state.launch))
    identityFailure(command, runId);
  const second = adapter.findLaunchProcesses(state.launchMarker);
  if (second.kind === "unverifiable")
    inspectionFailure(command, runId);
  if (second.processes.length === 0) {
    return recoverAbsentLaunch(command, runId, paths, state, adapter);
  }
  if (second.processes.length !== 1 || !isSameProcess(candidate, second.processes[0]) || !isOwnedLaunch(second.processes[0], state.launch)) {
    staticFailure(command, runId, "LAUNCH_PROCESS_AMBIGUOUS", 20, "The stale launch marker changed before cleanup.", "Inspect the marker-matched processes and private state; Warm Browser did not signal them.");
  }
  if (!await adapter.terminateProcessGroup(second.processes[0], state.launch)) {
    staticFailure(command, runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not clean up its stale marked process group.", "Inspect the owned process group and private state before retrying.");
  }
  removeStateAfterStop(command, runId, paths, state.sessionId);
  return { kind: "recovered", stoppedOwnedProcess: true };
}
function proveReceiptContract(command, runId, state, adapter) {
  const port = state.endpoint.port;
  if (state.profileRoot !== adapter.profileRoot() || state.launchMarker !== state.sessionId || port < 1024 || port > 65535) {
    throw new UnsafeStateError;
  }
  const canonical = launchOwnership({
    executable: adapter.chromeExecutable(),
    profileRoot: state.profileRoot,
    port,
    launchMarker: state.launchMarker
  });
  if (state.launch.executable !== canonical.executable || state.launch.commandLine !== canonical.commandLine) {
    throw new UnsafeStateError;
  }
  if (state.phase !== "launching" && (state.process.executable !== state.launch.executable || state.process.commandLine !== state.launch.commandLine)) {
    identityFailure(command, runId);
  }
}
async function inspectSession(command, runId, paths, adapter, pageReplacement = "refuse") {
  const lockExists = validateSessionLock(paths);
  const state = readSessionState(paths);
  if (state !== undefined)
    proveReceiptContract(command, runId, state, adapter);
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
  if (!isSameProcess(state.process, first.process) || !isOwnedLaunch(first.process, state.launch))
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
    if (!isSameProcess(state.process, second.process) || !isOwnedLaunch(second.process, state.launch))
      identityFailure(command, runId);
    if (!await adapter.terminateProcessGroup(second.process, state.launch)) {
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
  const preservedProcessAction = "Inspect the Browser Session with its owned process still preserved.";
  if (verification.kind !== "verified") {
    const [resultCode, message] = endpointRefusal(verification.kind, "stored CDP endpoint");
    staticFailure(command, runId, resultCode, 20, message, preservedProcessAction);
  }
  if (verification.endpoint.browserVersion !== state.endpoint.browserVersion) {
    const [resultCode, message] = endpointRefusal("browser_unverified", "stored CDP endpoint");
    staticFailure(command, runId, resultCode, 20, message, preservedProcessAction);
  }
  if (verification.endpoint.controlledPageTargetId !== state.endpoint.controlledPageTargetId) {
    if (pageReplacement === "refuse") {
      const transaction = invalidationState(state);
      invalidateReferences(command, runId, paths, state, "invalidated");
      staticFailure(command, runId, "CONTROLLED_PAGE_REPLACED", 20, "The Browser Session's Controlled Page was replaced by another page.", "Run warm-browser open --url URL --adopt-page --run-id ID to bind the replacement Controlled Page.", false, transaction);
    }
    const adopted = adoptControlledPage(state, verification.endpoint.controlledPageTargetId);
    writeSessionState(paths, adopted);
    return { kind: "running", state: adopted, adoptedPage: true };
  }
  return { kind: "running", state, adoptedPage: false };
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
  const argumentList = chromeArgumentList({
    profileRoot,
    port,
    launchMarker: sessionId
  });
  const launching = {
    schemaVersion: 1,
    phase: "launching",
    launch: launchOwnership({ executable, profileRoot, port, launchMarker: sessionId }),
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
      argumentList,
      ownership: launching.launch
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
      const mapped = endpointRefusal(verification.kind, "launched Chrome CDP");
      if (!await adapter.terminateProcessGroup(spawned, launching.launch)) {
        staticFailure("start", parsed.runId, "UNEXPECTED_FAILURE", 1, "Warm Browser could not roll back its unverified browser process group.", "Inspect the owned process group and private state before retrying.");
      }
      removeStateAfterStop("start", parsed.runId, paths, sessionId);
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
      if (!await adapter.terminateProcessGroup(spawned, launching.launch)) {
        launchCleanupUnverified(parsed.runId, priorTx);
      }
      removeStateAfterStop("start", parsed.runId, paths, sessionId);
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
      data: recoveredData("status", inspection.stoppedOwnedProcess)
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
    return recoveredStop(parsed, inspection.stoppedOwnedProcess);
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
  if (!isSameProcess(state.process, observed.process) || !isOwnedLaunch(observed.process, state.launch))
    identityFailure("stop", parsed.runId);
  if (!await adapter.terminateProcessGroup(observed.process, state.launch)) {
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
function requiredArgument(value) {
  if (value === undefined)
    throw new Error("a required option reached execution unset");
  return value;
}
async function requireControlledPage(parsed, command, paths, adapter) {
  const inspection = await inspectSession(command, parsed.runId, paths, adapter, parsed.adoptPage ? "adopt" : "refuse");
  if (inspection.kind === "running") {
    return { state: inspection.state, adoptedPage: inspection.adoptedPage };
  }
  staticFailure(command, parsed.runId, "SESSION_ABSENT", 21, "No verified Browser Session owns a Controlled Page.", "Run warm-browser start --run-id ID to create a Browser Session.", false, inspection.kind === "recovered" ? "recovered" : "unchanged");
}
function recordAfterAction(command, runId, paths, state, transactionState) {
  try {
    writeSessionState(paths, state);
  } catch {
    staticFailure(command, runId, "STATE_UNSAFE", 20, "Warm Browser could not record the Snapshot Generation its Controlled Page left behind.", "Repair the private Warm Browser session state; the Snapshot References it holds are already dead.", false, transactionState);
  }
}
function withoutSnapshot(state) {
  const { snapshot: _invalidated, ...rest } = state;
  return rest;
}
function invalidationState(state) {
  return state.snapshot === undefined ? "unchanged" : "invalidated";
}
function invalidateReferences(command, runId, paths, state, transactionState) {
  if (state.snapshot === undefined)
    return state;
  const cleared = withoutSnapshot(state);
  recordAfterAction(command, runId, paths, cleared, transactionState);
  return cleared;
}
function controlledPageData(basis) {
  return { targetId: basis.targetId, url: basis.url };
}
var freshSnapshotAction = "Run warm-browser snapshot --run-id ID to issue fresh Snapshot References.";
function pageControlUnverified(command, runId, message, transactionState) {
  staticFailure(command, runId, "PAGE_CONTROL_UNVERIFIED", 20, message, "Inspect the Browser Session and its CDP endpoint before retrying.", false, transactionState);
}
function refuseReference(command, runId, resolution) {
  if (resolution === "absent") {
    staticFailure(command, runId, "SNAPSHOT_ABSENT", 21, "This Browser Session holds no Snapshot Generation.", "Run warm-browser snapshot --run-id ID before acting on the Controlled Page.");
  }
  const [resultCode, message] = resolution === "malformed" ? [
    "SNAPSHOT_REFERENCE_INVALID",
    "Warm Browser acts through a Snapshot Reference, and this is not one."
  ] : resolution === "unknown" ? [
    "SNAPSHOT_REFERENCE_INVALID",
    "The Snapshot Reference names no element of the current Snapshot Generation."
  ] : [
    "SNAPSHOT_REFERENCE_STALE",
    "The Snapshot Reference belongs to another Snapshot Generation, another Controlled Page, or a generation that has expired."
  ];
  staticFailure(command, runId, resultCode, 21, message, freshSnapshotAction);
}
var undeliverableMessages = {
  click_target_unproved: "Warm Browser could not prove the click would reach the referenced element.",
  field_unreadable: "Warm Browser could not read the referenced field before typing into it.",
  field_not_empty: "Warm Browser fills an empty field, and the referenced one already holds a value.",
  field_not_focusable: "Warm Browser could not focus the referenced field.",
  field_focus_moved: "Warm Browser could not prove the referenced field holds focus."
};
function undeliverableAct(command, runId, reason) {
  staticFailure(command, runId, "ELEMENT_NOT_ACTIONABLE", 21, undeliverableMessages[reason], freshSnapshotAction);
}
function credentialRefusal(command, runId) {
  staticFailure(command, runId, "CREDENTIAL_FIELD_REFUSED", 21, "Warm Browser does not type credentials into the Controlled Page.", "Use the Warm Browser login command for a credential field; it is not callable in this slice.");
}
async function open(parsed, paths, adapter) {
  const session = await requireControlledPage(parsed, "open", paths, adapter);
  const state = invalidateReferences("open", parsed.runId, paths, session.state, "acted");
  const navigation = await openControlledPage({
    port: state.endpoint.port,
    targetId: state.endpoint.controlledPageTargetId,
    url: requiredArgument(parsed.url)
  });
  if (navigation.kind === "refused") {
    staticFailure("open", parsed.runId, "NAVIGATION_FAILED", 20, "The Controlled Page did not complete the requested navigation.", "Run warm-browser snapshot --run-id ID to read where the Controlled Page actually is.", false, "acted");
  }
  if (navigation.kind === "superseded") {
    staticFailure("open", parsed.runId, "PAGE_IDENTITY_CHANGED", 21, "The Controlled Page is showing a document this navigation did not request.", freshSnapshotAction, false, "acted");
  }
  if (navigation.kind === "unverified") {
    pageControlUnverified("open", parsed.runId, "Warm Browser could not verify what its Controlled Page did with the navigation.", "acted");
  }
  return success({
    schemaVersion,
    status: "ok",
    command: "open",
    resultCode: "PAGE_OPENED",
    runId: parsed.runId,
    transactionState: "acted",
    retrySafe: false,
    nextAction: freshSnapshotAction,
    data: {
      controlledPage: controlledPageData(navigation.basis),
      adoptedPage: session.adoptedPage,
      invalidatedReferences: true,
      postcondition: "running"
    }
  });
}
async function snapshot(parsed, paths, adapter) {
  const session = await requireControlledPage(parsed, "snapshot", paths, adapter);
  const state = session.state;
  const reading = await readControlledPageSnapshot({
    port: state.endpoint.port,
    targetId: state.endpoint.controlledPageTargetId
  });
  if (reading.kind === "identity_changed") {
    const transaction = invalidationState(state);
    invalidateReferences("snapshot", parsed.runId, paths, state, "invalidated");
    staticFailure("snapshot", parsed.runId, "PAGE_IDENTITY_CHANGED", 21, "The Controlled Page moved while it was being read, so no Snapshot Reference was issued.", freshSnapshotAction, false, transaction);
  }
  if (reading.kind === "unverified") {
    pageControlUnverified("snapshot", parsed.runId, "Warm Browser could not read the Controlled Page.", "unchanged");
  }
  const generation = {
    generationId: adapter.createSnapshotId(),
    takenAtEpochMs: adapter.nowEpochMs(),
    basis: reading.basis,
    truncated: reading.truncated,
    elements: reading.elements
  };
  recordAfterAction("snapshot", parsed.runId, paths, { ...state, snapshot: generation }, "acted");
  return success({
    schemaVersion,
    status: "ok",
    command: "snapshot",
    resultCode: "SNAPSHOT_TAKEN",
    runId: parsed.runId,
    transactionState: "acted",
    retrySafe: true,
    nextAction: "Run warm-browser click --ref REFERENCE --run-id ID or warm-browser fill --ref REFERENCE --value TEXT --run-id ID.",
    data: {
      generationId: generation.generationId,
      controlledPage: controlledPageData(generation.basis),
      elementCount: generation.elements.length,
      truncated: generation.truncated,
      elements: publishedElements(generation),
      postcondition: "running"
    }
  });
}
async function actOnPage(parsed, command, paths, adapter) {
  const session = await requireControlledPage(parsed, command, paths, adapter);
  const state = session.state;
  const reference = requiredArgument(parsed.reference);
  const resolution = resolveSnapshotReference({
    reference,
    generation: state.snapshot,
    controlledPageTargetId: state.endpoint.controlledPageTargetId,
    nowEpochMs: adapter.nowEpochMs()
  });
  if (resolution.kind !== "resolved")
    refuseReference(command, parsed.runId, resolution.kind);
  const generation = state.snapshot;
  if (command === "fill" && resolution.element.credentialField) {
    credentialRefusal(command, parsed.runId);
  }
  const action = command === "click" ? { kind: "click" } : { kind: "fill", value: requiredArgument(parsed.value) };
  const outcome = await actOnControlledPage({
    port: state.endpoint.port,
    targetId: state.endpoint.controlledPageTargetId,
    basis: generation.basis,
    backendNodeId: resolution.element.backendNodeId,
    action
  });
  if (outcome.kind === "identity_changed") {
    const transaction = invalidationState(state);
    invalidateReferences(command, parsed.runId, paths, state, "invalidated");
    staticFailure(command, parsed.runId, "PAGE_IDENTITY_CHANGED", 21, "The Controlled Page is no longer the page this Snapshot Reference was issued against.", freshSnapshotAction, false, transaction);
  }
  if (outcome.kind === "undeliverable")
    undeliverableAct(command, parsed.runId, outcome.reason);
  if (outcome.kind === "element_absent") {
    staticFailure(command, parsed.runId, "SNAPSHOT_REFERENCE_STALE", 21, "The referenced element is no longer part of the Controlled Page.", freshSnapshotAction);
  }
  if (outcome.kind === "superseded") {
    invalidateReferences(command, parsed.runId, paths, state, "acted");
    staticFailure(command, parsed.runId, "PAGE_IDENTITY_CHANGED", 21, "The Controlled Page moved to a document this action did not ask for.", freshSnapshotAction, false, "acted");
  }
  if (outcome.kind === "credential_field")
    credentialRefusal(command, parsed.runId);
  if (outcome.kind === "unverified") {
    invalidateReferences(command, parsed.runId, paths, state, "acted");
    pageControlUnverified(command, parsed.runId, "Warm Browser could not verify what its Controlled Page did with the action.", "acted");
  }
  const invalidatedReferences = !sameBasis(outcome.basis, generation.basis);
  if (invalidatedReferences)
    invalidateReferences(command, parsed.runId, paths, state, "acted");
  return success({
    schemaVersion,
    status: "ok",
    command,
    resultCode: command === "click" ? "ELEMENT_CLICKED" : "FIELD_FILLED",
    runId: parsed.runId,
    transactionState: "acted",
    retrySafe: false,
    nextAction: freshSnapshotAction,
    data: {
      reference,
      ...command === "fill" ? { valueLength: requiredArgument(parsed.value).length } : {},
      controlledPage: controlledPageData(outcome.basis),
      invalidatedReferences,
      postcondition: "running"
    }
  });
}
var sliceCommands = {
  start,
  status,
  open,
  snapshot,
  click: (parsed, paths, adapter) => actOnPage(parsed, "click", paths, adapter),
  fill: (parsed, paths, adapter) => actOnPage(parsed, "fill", paths, adapter),
  stop
};
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
        commands: commandVocabulary.map(({ name, sideEffects, options }) => ({
          name,
          sideEffects,
          options: options.map(({ flag, value, required }) => ({
            flag,
            value,
            required
          }))
        }))
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
  return sliceCommands[parsed.command](parsed, paths, adapter);
}
async function runWarmBrowserCli(arguments_) {
  const adapter = productionAdapter;
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
var outcome = await runWarmBrowserCli(process.argv.slice(2));
if (outcome.stdout)
  process.stdout.write(outcome.stdout);
if (outcome.stderr)
  process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
