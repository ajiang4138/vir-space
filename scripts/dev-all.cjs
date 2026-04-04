const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const runningChildren = new Set();
let shuttingDown = false;
const relayPort = 8787;
const connectTimeoutMs = 350;

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

function buildSubnetHosts(ip) {
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

async function scanForRelayHostOnSubnet(localIp, port) {
  const hosts = buildSubnetHosts(localIp);
  if (hosts.length === 0) {
    return null;
  }

  let nextIndex = 0;
  let foundHost = null;
  const workerCount = 40;

  const worker = async () => {
    while (!foundHost && nextIndex < hosts.length) {
      const host = hosts[nextIndex];
      nextIndex += 1;

      // eslint-disable-next-line no-await-in-loop
      const reachable = await canReachTcp(host, port);
      if (reachable) {
        foundHost = host;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return foundHost;
}

async function discoverRelayHost(localIps, port) {
  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const found = await scanForRelayHostOnSubnet(localIp, port);
    if (found) {
      return found;
    }
  }

  if (await canReachTcp("127.0.0.1", port)) {
    return "127.0.0.1";
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
  const preferredLocalIp = localIps[0] || "127.0.0.1";

  let bootstrapUrl = "";
  let relayHostForBootstrap = await discoverRelayHost(localIps, relayPort);

  if (relayHostForBootstrap) {
    bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
    console.log(`[dev-all] Found existing relay at ${bootstrapUrl}`);
  }

  if (!relayHostForBootstrap) {
    await delay(600);
    relayHostForBootstrap = await discoverRelayHost(localIps, relayPort);
    if (relayHostForBootstrap) {
      bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
      console.log(`[dev-all] Found existing relay after retry at ${bootstrapUrl}`);
    }
  }

  if (!relayHostForBootstrap) {
    console.log(`[dev-all] No relay found on subnet; starting local relay on ${preferredLocalIp}:${relayPort}`);
    const relay = track(spawnNpmCommand(["run", "dev:server"]));

    const localReady = await waitForLocalRelay("127.0.0.1", relayPort);
    if (!localReady) {
      console.error("[dev-all] Local relay failed to become reachable on 127.0.0.1:8787");
      stopChildren();
      process.exit(1);
      return;
    }

    relayHostForBootstrap = preferredLocalIp;
    bootstrapUrl = `ws://${relayHostForBootstrap}:${relayPort}`;
    console.log(`[dev-all] Local relay ready. Bootstrap URL: ${bootstrapUrl}`);

    relay.on("exit", (code, signal) => {
      if (shuttingDown) {
        return;
      }

      if (!signal && code === 0) {
        return;
      }

      console.error("[dev-all] Relay server exited unexpectedly.");
      stopChildren();
      process.exit(1);
    });
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
