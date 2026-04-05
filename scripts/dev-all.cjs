const { spawn, spawnSync } = require("node:child_process");
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
  let nextIndex = 0;
  let foundHost = null;

  const worker = async () => {
    while (!foundHost && nextIndex < hosts.length) {
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
  });
}

async function discoverRelayHostLocalOnly(localIps, port) {
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
  const relayEnv = {
    ...process.env,
    RELAY_IDLE_SHUTDOWN_MS: process.env.RELAY_IDLE_SHUTDOWN_MS || "60000",
  };
  const relayEntryPath = "server/src/index.ts";
  const relayRunCommand = `npm --prefix server exec tsx ${relayEntryPath}`;

  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    const child = spawn(comspec, ["/d", "/s", "/c", relayRunCommand], {
      cwd: rootDir,
      env: relayEnv,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child;
  }

  const child = spawn("npm", ["--prefix", "server", "exec", "tsx", relayEntryPath], {
    cwd: rootDir,
    env: relayEnv,
    detached: true,
    stdio: "ignore",
  });
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
  let relayHostForBootstrap = await discoverRelayHost(localIps, relayPort);

  if (relayHostForBootstrap) {
    bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
    console.log(`[dev-all] Found existing relay at ${bootstrapUrl}`);
  }

  if (!relayHostForBootstrap) {
    await delay(600);
    relayHostForBootstrap = await discoverRelayHostLocalOnly(localIps, relayPort);
    if (relayHostForBootstrap) {
      bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
      console.log(`[dev-all] Found existing relay after retry at ${bootstrapUrl}`);
    }
  }

  if (!relayHostForBootstrap) {
    console.log(`[dev-all] No relay found on subnet; starting local relay on ${preferredLocalIp}:${relayPort}`);
    localRelayCandidate = spawnDetachedRelayServer();
    startedLocalRelay = true;

    const localReady = await waitForLocalRelay(preferredLocalIp, relayPort);
    if (!localReady) {
      console.error(`[dev-all] Local relay failed to become reachable on ${preferredLocalIp}:${relayPort}`);
      stopChildren();
      process.exit(1);
      return;
    }

    relayHostForBootstrap = preferredLocalIp;
    bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
    console.log(`[dev-all] Local relay ready in background. Bootstrap URL: ${bootstrapUrl}`);
  }

  if (startedLocalRelay && relayHostForBootstrap) {
    await delay(900);
    const discoveredAfterSpawn = await discoverRelayHost(localIps, relayPort);
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
