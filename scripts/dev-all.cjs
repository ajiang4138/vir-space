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
const classBScanWorkerCount = 900;
const classBScanTimeoutMs = 100;
const classBScanMaxDurationMs = 3500;
const relayCacheFilePath = path.join(rootDir, ".relay-bootstrap-cache.json");
const relayCacheMaxAgeMs = 24 * 60 * 60 * 1000;

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

function canReachTcp(host, port, timeoutMs = connectTimeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finalize = (reachable) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finalize(true));
    socket.on("timeout", () => finalize(false));
    socket.on("error", () => finalize(false));
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

  const hosts = [];
  for (let third = 0; third <= 255; third += 1) {
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

async function scanHostList(hosts, port, options = {}) {
  if (!hosts.length) {
    return null;
  }

  const workerCount = options.workerCount ?? 40;
  const timeoutMs = options.timeoutMs ?? connectTimeoutMs;
  const maxDurationMs = options.maxDurationMs ?? 0;
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
      const reachable = await canReachTcp(host, port, timeoutMs);
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
  });
}

async function scanForRelayHostOnClassB(localIp, port) {
  const hosts = buildClassBHosts(localIp);
  return scanHostList(hosts, port, {
    workerCount: classBScanWorkerCount,
    timeoutMs: classBScanTimeoutMs,
    maxDurationMs: classBScanMaxDurationMs,
  });
}

async function discoverRelayHostLocalOnly(localIps, port) {
  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const selfReachable = await canReachTcp(localIp, port, 220);
    if (selfReachable) {
      return localIp;
    }
  }

  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const found = await scanForRelayHostOnSubnet(localIp, port);
    if (found) {
      return found;
    }
  }

  return null;
}

async function discoverRelayHost(localIps, port) {
  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const selfReachable = await canReachTcp(localIp, port, 220);
    if (selfReachable) {
      return localIp;
    }
  }

  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const found = await scanForRelayHostOnSubnet(localIp, port);
    if (found) {
      return found;
    }
  }

  const scannedClassBPrefixes = new Set();
  for (const localIp of localIps) {
    if (!shouldTryClassBScan(localIp)) {
      continue;
    }

    const parts = localIp.split(".");
    const prefix = `${parts[0]}.${parts[1]}`;
    if (scannedClassBPrefixes.has(prefix)) {
      continue;
    }

    scannedClassBPrefixes.add(prefix);
    console.log(`[dev-all] No relay in local /24 for ${localIp}; scanning broader ${prefix}.0.0/16 ...`);

    // eslint-disable-next-line no-await-in-loop
    const found = await scanForRelayHostOnClassB(localIp, port);
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
    const reachable = await canReachTcp(host, port, 250);
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
      const reachable = await canReachTcp(host, port, 220);
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

function spawnDetachedRelayServer() {
  const isWindows = process.platform === "win32";
  const relayEnv = {
    ...process.env,
    RELAY_IDLE_SHUTDOWN_MS: process.env.RELAY_IDLE_SHUTDOWN_MS || "60000",
  };
  const relayEntryPath = "server/src/index.ts";
  const detachedOptions = {
    cwd: rootDir,
    env: relayEnv,
    detached: !isWindows,
    stdio: "ignore",
    windowsHide: true,
  };

  // Prefer direct node + tsx cli invocation to avoid spawning an extra cmd.exe window.
  const tsxCliPath = path.join(rootDir, "server", "node_modules", "tsx", "dist", "cli.mjs");
  if (fs.existsSync(tsxCliPath)) {
    const child = spawn(process.execPath, [tsxCliPath, relayEntryPath], detachedOptions);
    child.unref();
    return child;
  }

  // Fallback to npm-cli.js directly (still avoids cmd.exe as an intermediate process).
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    const child = spawn(process.execPath, [npmExecPath, "--prefix", "server", "exec", "tsx", relayEntryPath], detachedOptions);
    child.unref();
    return child;
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["--prefix", "server", "exec", "tsx", relayEntryPath], detachedOptions);
  child.unref();
  return child;
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
  const localIps = getLocalIPv4Addresses();
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
    const cachedReachable = await canReachTcp(cachedRelayHost, relayPort, 220);
    if (cachedReachable) {
      relayHostForBootstrap = cachedRelayHost;
      console.log(`[dev-all] Found cached relay at ws://${relayHostForBootstrap}:${relayPort}`);
    }
  }

  if (!relayHostForBootstrap) {
    const loopbackReachable = await canReachTcp("127.0.0.1", relayPort, 200);
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

    const reachableLocalRelayHost = await waitForRelayOnAnyHost(localIps, relayPort);
    if (!reachableLocalRelayHost) {
      const localhostReachable = await waitForLocalRelay("127.0.0.1", relayPort, 1200);
      if (localhostReachable) {
        console.error(`[dev-all] Relay started but is not reachable on any network IPv4 interface (${localIps.join(", ")}).`);
        console.error("[dev-all] This is usually a firewall or VPN adapter policy issue. Ensure inbound TCP 8787 is allowed on the active VPN/LAN adapter.");
      } else {
        console.error(`[dev-all] Local relay failed to become reachable on network interfaces (${localIps.join(", ")}).`);
      }
      stopChildren();
      process.exit(1);
      return;
    }

    relayHostForBootstrap = reachableLocalRelayHost;
    bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
    console.log(`[dev-all] Local relay ready in background. Bootstrap URL: ${bootstrapUrl}`);
    writeRelayHostCache(relayHostForBootstrap);
  }

  if (startedLocalRelay && relayHostForBootstrap) {
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
    setTimeout(() => {
      process.exit(0);
    }, 250);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  client.on("exit", (code, signal) => {
    stopChildren();

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
  process.exit(1);
});
