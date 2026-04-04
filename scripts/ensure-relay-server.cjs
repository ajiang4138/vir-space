const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const defaultBootstrapUrl = "ws://127.0.0.1:8787";
const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

for (const interfaces of Object.values(os.networkInterfaces())) {
  if (!interfaces) {
    continue;
  }

  for (const detail of interfaces) {
    if (!detail || !detail.address) {
      continue;
    }

    localHostnames.add(detail.address.toLowerCase());
  }
}

function parseBootstrapTarget(rawValue) {
  const candidate = (rawValue || defaultBootstrapUrl).trim();

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("Bootstrap URL must use ws or wss");
    }

    const host = parsed.hostname.toLowerCase();
    const fallbackPort = parsed.protocol === "wss:" ? 443 : 80;
    const parsedPort = parsed.port ? Number.parseInt(parsed.port, 10) : fallbackPort;
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error("Bootstrap URL has invalid port");
    }

    return {
      url: parsed.toString(),
      host,
      port: parsedPort,
      isLocal: localHostnames.has(host),
    };
  } catch {
    const parsed = new URL(defaultBootstrapUrl);
    return {
      url: parsed.toString(),
      host: parsed.hostname.toLowerCase(),
      port: Number.parseInt(parsed.port, 10),
      isLocal: true,
    };
  }
}

function canReachTcp(host, port, timeoutMs = 1200) {
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

function spawnRelayServer() {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", "npm run dev --prefix server"], {
      cwd: rootDir,
      stdio: "inherit",
    });
  }

  return spawn("npm", ["run", "dev", "--prefix", "server"], {
    cwd: rootDir,
    stdio: "inherit",
  });
}

async function main() {
  const bootstrap = parseBootstrapTarget(process.env.VITE_BOOTSTRAP_SIGNALING_URL);
  const reachable = await canReachTcp(bootstrap.host, bootstrap.port);

  if (reachable) {
    console.log(`[relay-ensure] Relay already reachable at ${bootstrap.url}. Skipping local relay startup.`);
    return;
  }

  if (!bootstrap.isLocal) {
    console.log(`[relay-ensure] Bootstrap target ${bootstrap.url} is remote and currently unreachable. Skipping local relay startup.`);
    return;
  }

  console.log(`[relay-ensure] No relay detected at ${bootstrap.url}. Starting local relay server...`);
  const child = spawnRelayServer();

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exitCode = 1;
      return;
    }

    process.exitCode = code || 0;
  });
}

main().catch((error) => {
  console.error("[relay-ensure] Failed:", error);
  process.exit(1);
});
