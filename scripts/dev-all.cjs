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

const classBScanWorkerCount = parseEnvInt("RELAY_CLASSB_SCAN_WORKERS", 1100, 50, 5000);
const classBScanTimeoutMs = parseEnvInt("RELAY_CLASSB_SCAN_TIMEOUT_MS", 220, 50, 2000);
const classBScanMaxDurationMs = parseEnvInt("RELAY_CLASSB_SCAN_MAX_DURATION_MS", 0, 0, 120000);
const localRescanMaxDurationMs = parseEnvInt("RELAY_LOCAL_RESCAN_MAX_DURATION_MS", 5000, 0, 120000);
const forceScanClassBPrefix = process.env.RELAY_FORCE_SCAN_CLASSB_PREFIX || "";
const relayCacheFilePath = path.join(rootDir, ".relay-bootstrap-cache.json");
const relayCacheMaxAgeMs = 24 * 60 * 60 * 1000;
const relayConvergeToLeader = process.env.RELAY_CONVERGE_TO_LEADER === "1";
const relayScanLogEnabled = process.env.RELAY_SCAN_LOG_ENABLED !== "0";
const relayScanLogFilePath = path.join(rootDir, process.env.RELAY_SCAN_LOG_FILE || ".relay-scan-attempts.log");
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
  const all = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    if (!interfaces) {
      continue;
    }

    for (const detail of interfaces) {
      if (!detail || detail.family !== "IPv4" || !detail.address || detail.internal) {
        continue;
      }

      all.push(detail.address);
    }
  }

  const unique = Array.from(new Set(all));
  unique.sort((left, right) => {
    const score = (ip) => {
      if (ip.startsWith("100.")) return 0; // Tailscale
      if (ip.startsWith("25.")) return 1; // Hamachi
      if (ip.startsWith("10.")) return 2;
      if (ip.startsWith("172.")) return 3;
      if (ip.startsWith("192.168.")) return 4;
      return 5;
    };
    return score(left) - score(right) || left.localeCompare(right);
  });

  return unique;
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

function collectClassBPrefixes(localIps, forcedPrefix) {
  const prefixes = [];
  const seen = new Set();

  for (const ip of localIps) {
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

function buildClassBHostsByPrefix(prefix, excludedHosts = []) {
  const normalized = parseClassBPrefix(prefix);
  if (!normalized) {
    return [];
  }

  const [first, second] = normalized.split(".");
  const excluded = new Set(excludedHosts.filter((host) => isIPv4(host)));

  const hosts = [];
  for (let third = 0; third <= 255; third += 1) {
    for (let fourth = 1; fourth <= 254; fourth += 1) {
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
      const reachable = await canReachTcp(host, port, timeoutMs, context);
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
    context: `scan-classC-${localIp}`,
  });
}

async function scanForRelayHostOnClassB(localIp, port) {
  const hosts = buildClassBHosts(localIp);
  return scanHostList(hosts, port, {
    workerCount: classBScanWorkerCount,
    timeoutMs: classBScanTimeoutMs,
    maxDurationMs: classBScanMaxDurationMs,
    context: `scan-classB-${localIp}`,
  });
}

async function discoverRelayHostLocalOnly(localIps, port) {
  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const selfReachable = await canReachTcp(localIp, port, 220, "discover-local-self");
    if (selfReachable) {
      return localIp;
    }
  }

  const prefixes = collectClassBPrefixes(localIps, forceScanClassBPrefix);
  for (const prefix of prefixes) {
    console.log(`[dev-all] Quick relay rescan on ${prefix}.0.0/16 ...`);

    const hosts = buildClassBHostsByPrefix(prefix, localIps);
    // eslint-disable-next-line no-await-in-loop
    const found = await scanHostList(hosts, port, {
      workerCount: classBScanWorkerCount,
      timeoutMs: classBScanTimeoutMs,
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
    const selfReachable = await canReachTcp(localIp, port, 220, "discover-self");
    if (selfReachable) {
      return localIp;
    }
  }

  const prefixes = collectClassBPrefixes(localIps, forceScanClassBPrefix);
  for (const prefix of prefixes) {
    console.log(`[dev-all] No relay found yet; scanning full ${prefix}.0.0/16 on port ${port} ...`);

    const hosts = buildClassBHostsByPrefix(prefix, localIps);
    // eslint-disable-next-line no-await-in-loop
    const found = await scanHostList(hosts, port, {
      workerCount: classBScanWorkerCount,
      timeoutMs: classBScanTimeoutMs,
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
    const reachable = await canReachTcp(host, port, 250, "wait-local-relay");
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
      const reachable = await canReachTcp(host, port, 220, "wait-any-relay");
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
  const preferredLocalIp = localIps[0] || null;
  if (!preferredLocalIp) {
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
    const cachedReachable = await canReachTcp(cachedRelayHost, relayPort, 220, "cache-check");
    if (cachedReachable) {
      relayHostForBootstrap = cachedRelayHost;
      console.log(`[dev-all] Found cached relay at ws://${relayHostForBootstrap}:${relayPort}`);
    } else {
      clearRelayHostCache();
      console.log(`[dev-all] Cached relay ${cachedRelayHost}:${relayPort} is unreachable; cleared stale cache.`);
    }
  }

  if (!relayHostForBootstrap) {
    const loopbackReachable = await canReachTcp("127.0.0.1", relayPort, 200, "loopback-check");
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
