const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const runningChildren = new Set();
let shuttingDown = false;
const relayPort = 8787;
const connectTimeoutMs = 350;

function parseEnvInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

const classBScanWorkerCount = parseEnvInt("RELAY_CLASSB_SCAN_WORKERS", 250, 20, 5000);
const classBScanTimeoutMs = parseEnvInt("RELAY_CLASSB_SCAN_TIMEOUT_MS", 750, 50, 5000);
const classBScanMaxDurationMs = parseEnvInt("RELAY_CLASSB_SCAN_MAX_DURATION_MS", 0, 0, 120000);
const localRescanMaxDurationMs = parseEnvInt("RELAY_LOCAL_RESCAN_MAX_DURATION_MS", 45000, 0, 120000);
const directProbeAttempts = parseEnvInt("RELAY_DIRECT_PROBE_ATTEMPTS", 2, 1, 5);
const scanProbeAttempts = parseEnvInt("RELAY_SCAN_PROBE_ATTEMPTS", 2, 1, 4);
const forceScanClassBPrefix = process.env.RELAY_FORCE_SCAN_CLASSB_PREFIX || "";
const scanAllLocalClassBPrefixes = process.env.RELAY_SCAN_ALL_LOCAL_CLASSB_PREFIXES !== "0";
const relayCacheFilePath = path.join(rootDir, ".relay-bootstrap-cache.json");
const relayCacheMaxAgeMs = 24 * 60 * 60 * 1000;
const relayConvergeToLeader = process.env.RELAY_CONVERGE_TO_LEADER === "1";
const relayScanLogEnabled = process.env.RELAY_SCAN_LOG_ENABLED !== "0";
const relayScanLogFilePath = path.join(rootDir, process.env.RELAY_SCAN_LOG_FILE || ".relay-scan-attempts.log");
const deferRelayDiscoveryUntilAfterClientStarts = process.env.RELAY_DEFER_DISCOVERY !== "0";
let relayScanLogStream = null;

function initializeRelayScanLog() {
  if (!relayScanLogEnabled || relayScanLogStream) {
    return;
  }

  try {
    relayScanLogStream = fs.createWriteStream(relayScanLogFilePath, { flags: "w" });
    relayScanLogStream.write(`# Relay scan attempt log\n`);
    relayScanLogStream.write(`# startedAt=${new Date().toISOString()}\n`);
  } catch {
    relayScanLogStream = null;
  }
}

function appendRelayScanLog(message) {
  if (!relayScanLogEnabled) {
    return;
  }

  if (!relayScanLogStream) {
    initializeRelayScanLog();
  }

  if (!relayScanLogStream) {
    return;
  }

  relayScanLogStream.write(`${new Date().toISOString()} ${message}\n`);
}

function closeRelayScanLog() {
  if (!relayScanLogStream) {
    return;
  }

  try {
    relayScanLogStream.end();
  } catch {
    // Best-effort stream close.
  }

  relayScanLogStream = null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIPv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const num = Number.parseInt(part, 10);
    return num >= 0 && num <= 255;
  });
}

function compareIPv4(left, right) {
  if (!isIPv4(left) || !isIPv4(right)) {
    return left.localeCompare(right);
  }

  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 4; i += 1) {
    if (leftParts[i] === rightParts[i]) {
      continue;
    }

    return leftParts[i] - rightParts[i];
  }

  return 0;
}

function getLocalIPv4Addresses() {
  const entries = [];
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    if (!interfaces) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (
      lowerName.includes("virtual") ||
      lowerName.includes("vbox") ||
      lowerName.includes("wsl") ||
      lowerName.includes("loopback")
    ) {
      continue;
    }

    for (const detail of interfaces) {
      if (!detail || detail.family !== "IPv4" || !detail.address || detail.internal) {
        continue;
      }

      // Exclude known virtual/link-local IP ranges
      if (detail.address.startsWith("169.254.") || detail.address.startsWith("192.168.56.")) {
        continue;
      }

      entries.push({ ip: detail.address, ifaceName: name });
    }
  }

  const seen = new Set();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.ip)) {
      return false;
    }
    seen.add(entry.ip);
    return true;
  });

  unique.sort((left, right) => {
    const ipScore = (ip) => {
      if (ip.startsWith("100.")) return 0; // Tailscale
      if (ip.startsWith("25.")) return 1; // Hamachi
      if (ip.startsWith("10.")) return 2;
      if (ip.startsWith("172.")) return 3;
      if (ip.startsWith("192.168.")) return 4;
      return 5;
    };

    // Ethernet/VPN adapters get priority over Wi-Fi.
    const ifaceScore = (ifaceName) => {
      const lower = ifaceName.toLowerCase();
      if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wireless") || lower.includes("wlan")) return 1;
      return 0;
    };

    const scoreDelta = ipScore(left.ip) - ipScore(right.ip);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    const ifaceDelta = ifaceScore(left.ifaceName) - ifaceScore(right.ifaceName);
    if (ifaceDelta !== 0) {
      return ifaceDelta;
    }

    return left.ip.localeCompare(right.ip);
  });

  return unique.map((entry) => entry.ip);
}
function readRelayHostCache() {
  try {
    if (!fs.existsSync(relayCacheFilePath)) {
      return null;
    }

    const raw = fs.readFileSync(relayCacheFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const host = typeof parsed.host === "string" ? parsed.host.trim() : "";
    const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
    if (!host || !isIPv4(host) || !Number.isFinite(savedAt)) {
      return null;
    }

    if (Date.now() - savedAt > relayCacheMaxAgeMs) {
      return null;
    }

    return host;
  } catch {
    return null;
  }
}

function writeRelayHostCache(host) {
  if (!host || !isIPv4(host)) {
    return;
  }

  try {
    fs.writeFileSync(relayCacheFilePath, JSON.stringify({
      host,
      savedAt: Date.now(),
    }), "utf8");
  } catch {
    // Best-effort cache write.
  }
}

function clearRelayHostCache() {
  try {
    if (fs.existsSync(relayCacheFilePath)) {
      fs.unlinkSync(relayCacheFilePath);
    }
  } catch {
    // Best-effort cache clear.
  }
}

function canReachTcp(host, port, timeoutMs = connectTimeoutMs, context = "probe") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finalize = (reachable, reason) => {
      if (settled) {
        return;
      }

      settled = true;
      appendRelayScanLog(`[${context}] ${host}:${port} timeoutMs=${timeoutMs} result=${reachable ? "open" : "closed"} reason=${reason}`);
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finalize(true, "connect"));
    socket.on("timeout", () => finalize(false, "timeout"));
    socket.on("error", (error) => finalize(false, `error:${error?.code || "unknown"}`));
  });
}

async function canReachTcpWithRetries(host, port, timeoutMs, attempts, context) {
  const totalAttempts = Number.isFinite(attempts) ? Math.max(1, attempts) : 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const attemptContext = totalAttempts > 1 ? `${context}-attempt${attempt}` : context;
    // eslint-disable-next-line no-await-in-loop
    const reachable = await canReachTcp(host, port, timeoutMs, attemptContext);
    if (reachable) {
      return true;
    }

    if (attempt < totalAttempts) {
      // eslint-disable-next-line no-await-in-loop
      await delay(30);
    }
  }

  return false;
}

function buildClassCHosts(ip) {
  if (!isIPv4(ip)) {
    return [];
  }

  const parts = ip.split(".");
  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const selfLast = Number.parseInt(parts[3], 10);
  const hosts = [];

  for (let i = 1; i <= 254; i += 1) {
    if (i === selfLast) {
      continue;
    }

    hosts.push(`${prefix}.${i}`);
  }

  return hosts;
}

function buildClassBHosts(ip) {
  if (!isIPv4(ip)) {
    return [];
  }

  const parts = ip.split(".");
  const first = parts[0];
  const second = parts[1];
  const selfThird = Number.parseInt(parts[2], 10);
  const selfFourth = Number.parseInt(parts[3], 10);

  const prioritizedThirds = [];
  for (let offset = 0; offset <= 255; offset += 1) {
    const upper = selfThird + offset;
    if (upper >= 0 && upper <= 255) {
      prioritizedThirds.push(upper);
    }

    if (offset === 0) {
      continue;
    }

    const lower = selfThird - offset;
    if (lower >= 0 && lower <= 255) {
      prioritizedThirds.push(lower);
    }
  }

  const hosts = [];
  for (const third of prioritizedThirds) {
    for (let fourth = 1; fourth <= 254; fourth += 1) {
      if (third === selfThird && fourth === selfFourth) {
        continue;
      }

      hosts.push(`${first}.${second}.${third}.${fourth}`);
    }
  }

  return hosts;
}

function shouldTryClassBScan(ip) {
  if (!isIPv4(ip)) {
    return false;
  }

  return ip.startsWith("10.") || ip.startsWith("100.") || ip.startsWith("25.");
}

function parseClassBPrefix(rawValue) {
  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmed = rawValue.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const first = Number.parseInt(parts[0], 10);
  const second = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    return null;
  }

  if (first < 0 || first > 255 || second < 0 || second > 255) {
    return null;
  }

  return `${first}.${second}`;
}

function getClassBPrefixFromIp(ip) {
  if (!isIPv4(ip)) {
    return null;
  }

  const parts = ip.split(".");
  return `${parts[0]}.${parts[1]}`;
}

function buildPrioritizedOctetValues(minInclusive, maxInclusive, center) {
  const values = [];

  if (!Number.isFinite(center) || center < minInclusive || center > maxInclusive) {
    for (let value = minInclusive; value <= maxInclusive; value += 1) {
      values.push(value);
    }

    return values;
  }

  for (let offset = 0; offset <= (maxInclusive - minInclusive); offset += 1) {
    const upper = center + offset;
    if (upper >= minInclusive && upper <= maxInclusive) {
      values.push(upper);
    }

    if (offset === 0) {
      continue;
    }

    const lower = center - offset;
    if (lower >= minInclusive && lower <= maxInclusive) {
      values.push(lower);
    }
  }

  return values;
}

function collectClassBPrefixes(localIps, forcedPrefix, includeAllLocalPrefixes = false) {
  const prefixes = [];
  const seen = new Set();

  const localCandidates = includeAllLocalPrefixes ? localIps : localIps.slice(0, 1);
  for (const ip of localCandidates) {
    const prefix = getClassBPrefixFromIp(ip);
    if (!prefix || seen.has(prefix)) {
      continue;
    }

    seen.add(prefix);
    prefixes.push(prefix);
  }

  const normalizedForcedPrefix = parseClassBPrefix(forcedPrefix);
  if (normalizedForcedPrefix && !seen.has(normalizedForcedPrefix)) {
    seen.add(normalizedForcedPrefix);
    prefixes.push(normalizedForcedPrefix);
  }

  return prefixes;
}

function buildClassBHostsByPrefix(prefix, excludedHosts = [], seedIp = null) {
  const normalized = parseClassBPrefix(prefix);
  if (!normalized) {
    return [];
  }

  const [first, second] = normalized.split(".");
  const excluded = new Set(excludedHosts.filter((host) => isIPv4(host)));

  let seedThird = null;
  let seedFourth = null;
  if (seedIp && isIPv4(seedIp) && getClassBPrefixFromIp(seedIp) === normalized) {
    const parts = seedIp.split(".").map((part) => Number.parseInt(part, 10));
    seedThird = parts[2];
    seedFourth = parts[3];
  }

  const thirdValues = buildPrioritizedOctetValues(0, 255, seedThird);
  const fourthValues = buildPrioritizedOctetValues(1, 254, seedFourth);

  const hosts = [];
  for (const third of thirdValues) {
    for (const fourth of fourthValues) {
      const host = `${first}.${second}.${third}.${fourth}`;
      if (excluded.has(host)) {
        continue;
      }

      hosts.push(host);
    }
  }

  return hosts;
}

async function scanHostList(hosts, port, options = {}) {
  if (!hosts.length) {
    return null;
  }

  const workerCount = options.workerCount ?? 40;
  const timeoutMs = options.timeoutMs ?? connectTimeoutMs;
  const attemptsPerHost = options.attemptsPerHost ?? 1;
  const maxDurationMs = options.maxDurationMs ?? 0;
  const context = options.context ?? "scan";
  const deadline = maxDurationMs > 0 ? Date.now() + maxDurationMs : 0;
  let nextIndex = 0;
  let foundHost = null;

  const worker = async () => {
    while (!foundHost && nextIndex < hosts.length) {
      if (deadline && Date.now() >= deadline) {
        return;
      }

      const host = hosts[nextIndex];
      nextIndex += 1;

      // eslint-disable-next-line no-await-in-loop
      const reachable = await canReachTcpWithRetries(host, port, timeoutMs, attemptsPerHost, context);
      if (reachable) {
        foundHost = host;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return foundHost;
}

async function scanForRelayHostOnSubnet(localIp, port) {
  const classCHosts = buildClassCHosts(localIp);
  return scanHostList(classCHosts, port, {
    workerCount: 80,
    timeoutMs: 250,
    attemptsPerHost: scanProbeAttempts,
    context: `scan-classC-${localIp}`,
  });
}

async function scanForRelayHostOnClassB(localIp, port) {
  const hosts = buildClassBHosts(localIp);
  return scanHostList(hosts, port, {
    workerCount: classBScanWorkerCount,
    timeoutMs: classBScanTimeoutMs,
    attemptsPerHost: scanProbeAttempts,
    maxDurationMs: classBScanMaxDurationMs,
    context: `scan-classB-${localIp}`,
  });
}

async function discoverRelayHostLocalOnly(localIps, port) {
  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const selfReachable = await canReachTcpWithRetries(localIp, port, 500, directProbeAttempts, "discover-local-self");
    if (selfReachable) {
      return localIp;
    }
  }

  const prefixes = collectClassBPrefixes(localIps, forceScanClassBPrefix, scanAllLocalClassBPrefixes);
  for (const prefix of prefixes) {
    console.log(`[dev-all] Quick relay rescan on ${prefix}.0.0/16 ...`);
    const seedIp = localIps.find((ip) => getClassBPrefixFromIp(ip) === prefix) || null;

    const hosts = buildClassBHostsByPrefix(prefix, localIps, seedIp);
    // eslint-disable-next-line no-await-in-loop
    const found = await scanHostList(hosts, port, {
      workerCount: classBScanWorkerCount,
      timeoutMs: classBScanTimeoutMs,
      attemptsPerHost: scanProbeAttempts,
      maxDurationMs: localRescanMaxDurationMs,
      context: `scan-local-rescan-${prefix}`,
    });
    if (found) {
      return found;
    }
  }

  return null;
}

async function discoverRelayHost(localIps, port) {
  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const selfReachable = await canReachTcpWithRetries(localIp, port, 500, directProbeAttempts, "discover-self");
    if (selfReachable) {
      return localIp;
    }
  }

  const prefixes = collectClassBPrefixes(localIps, forceScanClassBPrefix, scanAllLocalClassBPrefixes);
  for (const prefix of prefixes) {
    console.log(`[dev-all] No relay found yet; scanning full ${prefix}.0.0/16 on port ${port} ...`);
    const seedIp = localIps.find((ip) => getClassBPrefixFromIp(ip) === prefix) || null;

    const hosts = buildClassBHostsByPrefix(prefix, localIps, seedIp);
    // eslint-disable-next-line no-await-in-loop
    const found = await scanHostList(hosts, port, {
      workerCount: classBScanWorkerCount,
      timeoutMs: classBScanTimeoutMs,
      attemptsPerHost: scanProbeAttempts,
      maxDurationMs: classBScanMaxDurationMs,
      context: `scan-classB-full-${prefix}`,
    });
    if (found) {
      return found;
    }
  }

  return null;
}

async function waitForLocalRelay(host, port, totalWaitMs = 8000) {
  const deadline = Date.now() + totalWaitMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const reachable = await canReachTcpWithRetries(host, port, 250, directProbeAttempts, "wait-local-relay");
    if (reachable) {
      return true;
    }

    // eslint-disable-next-line no-await-in-loop
    await delay(250);
  }

  return false;
}

async function waitForRelayOnAnyHost(hosts, port, totalWaitMs = 8000) {
  const uniqueHosts = Array.from(new Set(hosts.filter((host) => isIPv4(host))));
  if (!uniqueHosts.length) {
    return null;
  }

  const deadline = Date.now() + totalWaitMs;
  while (Date.now() < deadline) {
    for (const host of uniqueHosts) {
      // eslint-disable-next-line no-await-in-loop
      const reachable = await canReachTcpWithRetries(host, port, 220, directProbeAttempts, "wait-any-relay");
      if (reachable) {
        return host;
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await delay(220);
  }

  return null;
}

function buildNpmCommand(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      commandArgs: ["/d", "/s", "/c", `npm ${args.join(" ")}`],
    };
  }

  return {
    command: "npm",
    commandArgs: args,
  };
}

function spawnNpmCommand(args) {
  const npm = buildNpmCommand(args);
  return spawn(npm.command, npm.commandArgs, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function spawnHiddenDetachedRelayOnWindows(nodeArgs, relayEnv) {
  const powerShellPath = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

  const relayIdleShutdownMs = relayEnv.RELAY_IDLE_SHUTDOWN_MS || "60000";
  const quotedNodePath = escapePowerShellSingleQuoted(process.execPath);
  const quotedRootDir = escapePowerShellSingleQuoted(rootDir);
  const quotedArgString = nodeArgs
    .map((arg) => `"${String(arg).replace(/"/g, "\\\"")}"`)
    .join(" ");
  const escapedArgString = escapePowerShellSingleQuoted(quotedArgString);

  const script = [
    "$ErrorActionPreference='Stop'",
    `$env:RELAY_IDLE_SHUTDOWN_MS='${escapePowerShellSingleQuoted(relayIdleShutdownMs)}'`,
    `$p = Start-Process -FilePath '${quotedNodePath}' -ArgumentList '${escapedArgString}' -WorkingDirectory '${quotedRootDir}' -WindowStyle Hidden -PassThru`,
    "Write-Output $p.Id",
  ].join("; ");

  const launched = spawnSync(powerShellPath, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    cwd: rootDir,
    env: relayEnv,
    windowsHide: true,
    encoding: "utf8",
  });

  if (launched.error) {
    throw launched.error;
  }

  if (launched.status !== 0) {
    const details = `${launched.stderr || launched.stdout || ""}`.trim();
    throw new Error(`Failed to launch hidden relay process on Windows: ${details || `exit code ${launched.status}`}`);
  }

  const pidCandidate = `${launched.stdout || ""}`.trim().split(/\s+/).pop() || "";
  const pid = Number.parseInt(pidCandidate, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Failed to parse hidden relay process PID from PowerShell output: ${launched.stdout || "<empty>"}`);
  }

  return {
    pid,
    killed: false,
  };
}

function spawnDetachedRelayServer() {
  const relayEnv = {
    ...process.env,
    RELAY_IDLE_SHUTDOWN_MS: process.env.RELAY_IDLE_SHUTDOWN_MS || "60000",
  };
  const relayEntryPath = "server/src/index.ts";
  const detachedOptions = {
    cwd: rootDir,
    env: relayEnv,
    // Keep relay alive independently of the dev-all process across platforms.
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  };

  // Use direct node invocation only (never npm/cmd) to avoid extra terminal windows.
  const tsxCliPath = path.join(rootDir, "server", "node_modules", "tsx", "dist", "cli.mjs");
  if (fs.existsSync(tsxCliPath)) {
    if (process.platform === "win32") {
      return spawnHiddenDetachedRelayOnWindows([tsxCliPath, relayEntryPath], relayEnv);
    }

    const child = spawn(process.execPath, [tsxCliPath, relayEntryPath], detachedOptions);
    child.unref();
    return child;
  }

  // Build fallback: run compiled server directly, still via node with hidden detached process.
  const builtServerEntryPath = path.join(rootDir, "server", "dist", "index.js");
  if (fs.existsSync(builtServerEntryPath)) {
    if (process.platform === "win32") {
      return spawnHiddenDetachedRelayOnWindows([builtServerEntryPath], relayEnv);
    }

    const child = spawn(process.execPath, [builtServerEntryPath], detachedOptions);
    child.unref();
    return child;
  }

  throw new Error(
    "Unable to launch relay without shell: missing server/node_modules/tsx/dist/cli.mjs and server/dist/index.js",
  );
}

function spawnNpmCommandWithEnv(args, env) {
  const npm = buildNpmCommand(args);
  return spawn(npm.command, npm.commandArgs, {
    cwd: rootDir,
    stdio: "inherit",
    env,
  });
}

function track(child) {
  runningChildren.add(child);
  child.on("exit", () => runningChildren.delete(child));
  return child;
}

function terminateChild(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === "win32") {
    if (typeof child.pid === "number" && child.pid > 0) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    return;
  }

  child.kill("SIGTERM");
}

function stopChildren() {
  for (const child of runningChildren) {
    terminateChild(child);
  }
}

async function main() {
  initializeRelayScanLog();
  const localIps = getLocalIPv4Addresses();
  appendRelayScanLog(`[startup] localIps=${localIps.join(",") || "<none>"}`);
  const preferredLocalIp = localIps[0] || "127.0.0.1";

  if (deferRelayDiscoveryUntilAfterClientStarts) {
    // --- Quick pre-launch discovery: check for an existing relay before spawning ---
    let deferredRelayHost = null;
    let deferredSpawnedLocalRelay = null;

    // 1. Check the cache for a previously known relay.
    const deferredCachedHost = readRelayHostCache();
    if (deferredCachedHost) {
      const cachedReachable = await canReachTcpWithRetries(deferredCachedHost, relayPort, 250, directProbeAttempts, "deferred-cache-check");
      if (cachedReachable) {
        deferredRelayHost = deferredCachedHost;
        console.log(`[dev-all] Deferred: found cached relay at ${deferredRelayHost}:${relayPort}`);
      } else {
        clearRelayHostCache();
        console.log(`[dev-all] Deferred: cached relay ${deferredCachedHost}:${relayPort} unreachable; cleared.`);
      }
    }

    // 2. Probe local IPs for an already-running relay (e.g. from a previous run).
    if (!deferredRelayHost) {
      for (const localIp of localIps) {
        // eslint-disable-next-line no-await-in-loop
        const selfReachable = await canReachTcpWithRetries(localIp, relayPort, 250, directProbeAttempts, "deferred-local-probe");
        if (selfReachable) {
          deferredRelayHost = localIp;
          console.log(`[dev-all] Deferred: found existing local relay at ${deferredRelayHost}:${relayPort}`);
          break;
        }
      }
    }

    // 3. Probe loopback as a last local check.
    if (!deferredRelayHost) {
      const loopbackReachable = await canReachTcpWithRetries("127.0.0.1", relayPort, 200, directProbeAttempts, "deferred-loopback-check");
      if (loopbackReachable) {
        deferredRelayHost = preferredLocalIp;
        console.log(`[dev-all] Deferred: found existing loopback relay, using ${deferredRelayHost}:${relayPort}`);
      }
    }

    // 4. Only spawn a local relay if none was found.
    if (!deferredRelayHost) {
      try {
        deferredSpawnedLocalRelay = spawnDetachedRelayServer();
        console.log(`[dev-all] Deferred: no existing relay found; spawned local relay candidate.`);
      } catch (error) {
        const message = error && typeof error === "object" && "message" in error ? error.message : String(error);
        console.warn(`[dev-all] Could not launch local relay candidate: ${message}`);
      }

      // Wait briefly for the newly spawned relay to become reachable.
      if (deferredSpawnedLocalRelay) {
        const readyHost = await waitForRelayOnAnyHost(localIps, relayPort, 3000);
        if (readyHost) {
          deferredRelayHost = readyHost;
          console.log(`[dev-all] Deferred: local relay ready at ${deferredRelayHost}:${relayPort}`);
        } else {
          deferredRelayHost = preferredLocalIp;
          console.log(`[dev-all] Deferred: local relay not yet confirmed; using ${deferredRelayHost}:${relayPort} optimistically.`);
        }
      } else {
        deferredRelayHost = preferredLocalIp;
      }
    }

    writeRelayHostCache(deferredRelayHost);

    const bootstrapUrl = process.env.VITE_BOOTSTRAP_SIGNALING_URL?.trim() || `ws://${deferredRelayHost}:${relayPort}`;
    const clientEnv = {
      ...process.env,
      VITE_BOOTSTRAP_SIGNALING_URL: bootstrapUrl,
    };

    const client = track(spawnNpmCommandWithEnv(["run", "dev:client"], clientEnv));
    console.log(`[dev-all] Client launched immediately with bootstrap ${bootstrapUrl}`);
    console.log("[dev-all] Relay discovery is running in background (non-blocking startup).\n");

    // --- Background convergence: scan for a remote relay after client is up ---
    (async () => {
      try {
        await delay(2000);
        if (shuttingDown) {
          return;
        }

        // Scan class-B subnets for remote relays, excluding our own local IPs
        // so we don't just rediscover the relay we spawned ourselves.
        const prefixes = collectClassBPrefixes(localIps, forceScanClassBPrefix, scanAllLocalClassBPrefixes);
        let discoveredHost = null;
        for (const prefix of prefixes) {
          if (shuttingDown) {
            return;
          }

          const seedIp = localIps.find((ip) => getClassBPrefixFromIp(ip) === prefix) || null;
          const hosts = buildClassBHostsByPrefix(prefix, localIps, seedIp);
          // eslint-disable-next-line no-await-in-loop
          const found = await scanHostList(hosts, relayPort, {
            workerCount: classBScanWorkerCount,
            timeoutMs: classBScanTimeoutMs,
            attemptsPerHost: scanProbeAttempts,
            maxDurationMs: localRescanMaxDurationMs > 0 ? localRescanMaxDurationMs : 8000,
            context: `convergence-scan-${prefix}`,
          });
          if (found) {
            discoveredHost = found;
            break;
          }
        }

        if (!discoveredHost || discoveredHost === deferredRelayHost || shuttingDown) {
          return;
        }

        // Found a different (remote) relay — update cache so future launches converge.
        writeRelayHostCache(discoveredHost);
        console.log(`[dev-all] Background convergence: found remote relay at ${discoveredHost}:${relayPort}, updated cache.`);

        // If we spawned a local relay and a remote one is available, kill ours.
        if (deferredSpawnedLocalRelay) {
          terminateChild(deferredSpawnedLocalRelay);
          deferredSpawnedLocalRelay = null;
          console.log(`[dev-all] Background convergence: stopped local relay in favor of remote relay.`);
        }
      } catch {
        // Best-effort background convergence.
      }
    })();

    const shutdown = () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      stopChildren();
      closeRelayScanLog();
      setTimeout(() => {
        closeRelayScanLog();
        process.exit(0);
      }, 250);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    client.on("exit", (code, signal) => {
      stopChildren();
      closeRelayScanLog();

      if (signal) {
        process.exit(1);
        return;
      }

      process.exit(code || 0);
    });

    return;
  }

  if (!localIps.length) {
    console.error("[dev-all] No non-loopback IPv4 network interface found. Cannot start network relay.");
    process.exit(1);
    return;
  }
  let localRelayCandidate = null;
  let startedLocalRelay = false;

  let bootstrapUrl = "";
  let relayHostForBootstrap = null;

  const cachedRelayHost = readRelayHostCache();
  if (cachedRelayHost) {
    const cachedReachable = await canReachTcpWithRetries(cachedRelayHost, relayPort, 250, directProbeAttempts, "cache-check");
    if (cachedReachable) {
      relayHostForBootstrap = cachedRelayHost;
      console.log(`[dev-all] Found cached relay at ws://${relayHostForBootstrap}:${relayPort}`);
    } else {
      clearRelayHostCache();
      console.log(`[dev-all] Cached relay ${cachedRelayHost}:${relayPort} is unreachable; cleared stale cache.`);
    }
  }

  if (!relayHostForBootstrap) {
    const loopbackReachable = await canReachTcpWithRetries("127.0.0.1", relayPort, 200, directProbeAttempts, "loopback-check");
    if (loopbackReachable) {
      relayHostForBootstrap = preferredLocalIp;
      console.log(`[dev-all] Found existing local relay at ws://${relayHostForBootstrap}:${relayPort}`);
    }
  }

  if (!relayHostForBootstrap) {
    relayHostForBootstrap = await discoverRelayHost(localIps, relayPort);
  }

  if (relayHostForBootstrap) {
    bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
    console.log(`[dev-all] Found existing relay at ${bootstrapUrl}`);
    writeRelayHostCache(relayHostForBootstrap);
  }

  if (!relayHostForBootstrap) {
    await delay(600);
    relayHostForBootstrap = await discoverRelayHostLocalOnly(localIps, relayPort);
    if (relayHostForBootstrap) {
      bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
      console.log(`[dev-all] Found existing relay after retry at ${bootstrapUrl}`);
      writeRelayHostCache(relayHostForBootstrap);
    }
  }

  if (!relayHostForBootstrap) {
    console.log(`[dev-all] No relay found on subnet; starting local relay on ${preferredLocalIp}:${relayPort}`);
    localRelayCandidate = spawnDetachedRelayServer();
    startedLocalRelay = true;

    const preferredHostReachable = await waitForLocalRelay(preferredLocalIp, relayPort, 5000);
    let reachableLocalRelayHost = preferredHostReachable ? preferredLocalIp : null;
    if (!reachableLocalRelayHost) {
      reachableLocalRelayHost = await waitForRelayOnAnyHost(localIps, relayPort);
    }

    if (!reachableLocalRelayHost) {
      const localhostReachable = await waitForLocalRelay("127.0.0.1", relayPort, 1200);
      if (localhostReachable) {
        console.error(`[dev-all] Relay started but is not reachable on any network IPv4 interface (${localIps.join(", ")}).`);
        console.error("[dev-all] This is usually a firewall or VPN adapter policy issue. Ensure inbound TCP 8787 is allowed on the active VPN/LAN adapter.");
      } else {
        console.error(`[dev-all] Local relay failed to become reachable on network interfaces (${localIps.join(", ")}).`);
      }
      stopChildren();
      closeRelayScanLog();
      process.exit(1);
      return;
    }

    relayHostForBootstrap = reachableLocalRelayHost;
    bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
    console.log(`[dev-all] Local relay ready in background. Bootstrap URL: ${bootstrapUrl}`);
    writeRelayHostCache(relayHostForBootstrap);
  }

  if (relayConvergeToLeader && startedLocalRelay && relayHostForBootstrap) {
    await delay(400);
    const discoveredAfterSpawn = await discoverRelayHostLocalOnly(localIps, relayPort);
    const usableDiscoveredHost = discoveredAfterSpawn;

    if (usableDiscoveredHost && usableDiscoveredHost !== relayHostForBootstrap) {
      const leaderHost = compareIPv4(usableDiscoveredHost, relayHostForBootstrap) < 0
        ? usableDiscoveredHost
        : relayHostForBootstrap;

      if (leaderHost !== relayHostForBootstrap) {
        relayHostForBootstrap = leaderHost;
        bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
        console.log(`[dev-all] Converged to existing relay leader at ${bootstrapUrl}`);

        if (localRelayCandidate) {
          terminateChild(localRelayCandidate);
          localRelayCandidate = null;
          console.log("[dev-all] Stopped local relay candidate after convergence.");
        }
      }
    }
  } else if (startedLocalRelay) {
    console.log("[dev-all] Leader convergence disabled; keeping local relay candidate active.");
  }

  const clientEnv = {
    ...process.env,
    VITE_BOOTSTRAP_SIGNALING_URL: bootstrapUrl,
  };
  const client = track(spawnNpmCommandWithEnv(["run", "dev:client"], clientEnv));
  console.log(`[dev-all] Client bootstrap set to ${bootstrapUrl}`);

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    stopChildren();
    closeRelayScanLog();
    setTimeout(() => {
      closeRelayScanLog();
      process.exit(0);
    }, 250);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  client.on("exit", (code, signal) => {
    stopChildren();
    closeRelayScanLog();

    if (signal) {
      process.exit(1);
      return;
    }

    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error("[dev-all] Failed to start:", error);
  stopChildren();
  closeRelayScanLog();
  process.exit(1);
});
