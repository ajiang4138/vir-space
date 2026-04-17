import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { HostServiceInfo, LocalNetworkInfo, RelayDiscoveryStatus } from "../src/shared/signaling.js";
import {
    buildFileManifest,
    createReceiverTransfer,
    finalizeReceiverTransfer,
    readFilePiece,
    removeReceiverTransfer,
    selectFileForSharing,
    writeReceiverPiece,
} from "./fileTransfer.js";
import { HostRoomService } from "./hostServer.js";
import {
    getPreferredIpv4AddressesIncludingLoopback,
    getPreferredNonLoopbackIpv4Addresses,
} from "./networkAddress.js";

const hostService = new HostRoomService();
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

function closeSplashWindow(): void {
  if (!splashWindow || splashWindow.isDestroyed()) {
    splashWindow = null;
    return;
  }

  splashWindow.close();
  splashWindow = null;
}

function createSplashWindow(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    return;
  }

  splashWindow = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: true,
    show: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: "#0f172a",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  splashWindow.setMenuBarVisibility(false);

  const splashHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Launching VIR</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        font-family: "Segoe UI", Tahoma, sans-serif;
        color: #e2e8f0;
        background:
          radial-gradient(circle at 15% 20%, rgba(59, 130, 246, 0.35), transparent 35%),
          radial-gradient(circle at 82% 75%, rgba(16, 185, 129, 0.28), transparent 42%),
          linear-gradient(155deg, #0f172a, #111827 55%, #0b1220);
        display: grid;
        place-items: center;
      }

      .wrap {
        width: min(360px, 82vw);
        display: grid;
        gap: 14px;
      }

      h1 {
        margin: 0;
        font-size: 1.25rem;
        letter-spacing: 0.03em;
      }

      p {
        margin: 0;
        color: #cbd5e1;
        font-size: 0.92rem;
      }

      .bar {
        height: 8px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.26);
        overflow: hidden;
      }

      .bar::after {
        content: "";
        display: block;
        height: 100%;
        width: 40%;
        border-radius: inherit;
        background: linear-gradient(90deg, #22d3ee, #60a5fa);
        animation: pulse 1.1s ease-in-out infinite;
      }

      @keyframes pulse {
        from { transform: translateX(-110%); }
        to { transform: translateX(300%); }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>VIR is starting</h1>
      <p>Preparing collaboration services and loading the workspace.</p>
      <div class="bar"></div>
    </div>
  </body>
</html>`;

  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);

  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

const relayPort = 8787;
const relayConnectTimeoutMs = 750;
const relayProbeAttempts = 2;
const relayScanWorkers = 250;
const relayScanMaxDurationMs = 45_000;

let relayDiscoveryTask: Promise<RelayDiscoveryStatus> | null = null;
let relayDiscoveryStatus: RelayDiscoveryStatus = {
  phase: "idle",
  host: null,
  startedAt: null,
  updatedAt: Date.now(),
  lastError: null,
};

function isIPv4(value: string): boolean {
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

function getRelayCacheCandidatePaths(): string[] {
  return [
    path.resolve(process.cwd(), ".relay-bootstrap-cache.json"),
    path.resolve(process.cwd(), "..", ".relay-bootstrap-cache.json"),
    path.resolve(__dirname, "..", "..", "..", ".relay-bootstrap-cache.json"),
  ];
}

function readCachedRelayBootstrapHost(): string | null {
  for (const candidatePath of getRelayCacheCandidatePaths()) {
    try {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }

      const raw = fs.readFileSync(candidatePath, "utf8");
      const parsed = JSON.parse(raw) as { host?: string };
      const host = typeof parsed.host === "string" ? parsed.host.trim() : "";
      if (host && isIPv4(host)) {
        return host;
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return null;
}

function writeCachedRelayBootstrapHost(host: string): void {
  if (!isIPv4(host)) {
    return;
  }

  const candidates = getRelayCacheCandidatePaths();
  const existingPath = candidates.find((candidatePath) => fs.existsSync(candidatePath));
  const targetPath = existingPath ?? candidates[0];

  try {
    fs.writeFileSync(targetPath, JSON.stringify({ host, savedAt: Date.now() }), "utf8");
  } catch {
    // Best-effort cache write.
  }
}

function updateRelayDiscoveryStatus(next: Partial<RelayDiscoveryStatus>): RelayDiscoveryStatus {
  relayDiscoveryStatus = {
    ...relayDiscoveryStatus,
    ...next,
    updatedAt: Date.now(),
  };

  return relayDiscoveryStatus;
}

function buildPrioritizedOctetValues(minInclusive: number, maxInclusive: number, center: number | null): number[] {
  const values: number[] = [];

  if (!Number.isFinite(center) || center === null || center < minInclusive || center > maxInclusive) {
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

function getClassBPrefixFromIp(ip: string): string | null {
  if (!isIPv4(ip)) {
    return null;
  }

  const parts = ip.split(".");
  return `${parts[0]}.${parts[1]}`;
}

function buildClassBHostsByPrefix(prefix: string, excludedHosts: string[] = [], seedIp: string | null = null): string[] {
  const parts = prefix.split(".");
  if (parts.length !== 2) {
    return [];
  }

  const first = Number.parseInt(parts[0], 10);
  const second = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    return [];
  }

  if (first < 0 || first > 255 || second < 0 || second > 255) {
    return [];
  }

  let seedThird: number | null = null;
  let seedFourth: number | null = null;
  if (seedIp && isIPv4(seedIp) && getClassBPrefixFromIp(seedIp) === prefix) {
    const seedParts = seedIp.split(".").map((part) => Number.parseInt(part, 10));
    seedThird = seedParts[2];
    seedFourth = seedParts[3];
  }

  const excluded = new Set(excludedHosts.filter((host) => isIPv4(host)));
  const thirdValues = buildPrioritizedOctetValues(0, 255, seedThird);
  const fourthValues = buildPrioritizedOctetValues(1, 254, seedFourth);

  const hosts: string[] = [];
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

function canReachTcp(host: string, port: number, timeoutMs = relayConnectTimeoutMs): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finalize = (reachable: boolean): void => {
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

async function canReachTcpWithRetries(host: string, port: number, timeoutMs: number, attempts: number): Promise<boolean> {
  const totalAttempts = Math.max(1, attempts);

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const reachable = await canReachTcp(host, port, timeoutMs);
    if (reachable) {
      return true;
    }
  }

  return false;
}

async function scanHostList(
  hosts: string[],
  port: number,
  options: { workerCount?: number; timeoutMs?: number; maxDurationMs?: number; attemptsPerHost?: number } = {},
): Promise<string | null> {
  if (!hosts.length) {
    return null;
  }

  const workerCount = options.workerCount ?? relayScanWorkers;
  const timeoutMs = options.timeoutMs ?? relayConnectTimeoutMs;
  const maxDurationMs = options.maxDurationMs ?? relayScanMaxDurationMs;
  const attemptsPerHost = Math.max(1, options.attemptsPerHost ?? relayProbeAttempts);
  const deadline = maxDurationMs > 0 ? Date.now() + maxDurationMs : 0;

  let nextIndex = 0;
  let foundHost: string | null = null;

  const worker = async (): Promise<void> => {
    while (!foundHost && nextIndex < hosts.length) {
      if (deadline && Date.now() >= deadline) {
        return;
      }

      const host = hosts[nextIndex];
      nextIndex += 1;

      // eslint-disable-next-line no-await-in-loop
      const reachable = await canReachTcpWithRetries(host, port, timeoutMs, attemptsPerHost);
      if (reachable) {
        foundHost = host;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return foundHost;
}

async function getLocalNonLoopbackIPv4Addresses(): Promise<string[]> {
  return getPreferredNonLoopbackIpv4Addresses();
}

async function discoverRelayBootstrapHostInBackground(): Promise<string | null> {
  const localIps = await getLocalNonLoopbackIPv4Addresses();
  const cachedHost = readCachedRelayBootstrapHost();

  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const selfReachable = await canReachTcpWithRetries(localIp, relayPort, 500, relayProbeAttempts);
    if (selfReachable) {
      return localIp;
    }
  }

  if (cachedHost && !localIps.includes(cachedHost)) {
    const cachedReachable = await canReachTcpWithRetries(cachedHost, relayPort, 500, relayProbeAttempts);
    if (cachedReachable) {
      return cachedHost;
    }
  }

  // Scan ALL unique class-B prefixes from local interfaces so peers on
  // different subnets (e.g. 10.2.x.x VPN and 10.20.x.x Wi-Fi) can find
  // each other's relays.
  const seenPrefixes = new Set<string>();
  const prefixes: string[] = [];
  for (const ip of localIps) {
    const prefix = getClassBPrefixFromIp(ip);
    if (prefix && !seenPrefixes.has(prefix)) {
      seenPrefixes.add(prefix);
      prefixes.push(prefix);
    }
  }

  for (const prefix of prefixes) {
    const seedIp = localIps.find((ip) => getClassBPrefixFromIp(ip) === prefix) ?? null;
    const hosts = buildClassBHostsByPrefix(prefix, localIps, seedIp);
    // eslint-disable-next-line no-await-in-loop
    const found = await scanHostList(hosts, relayPort, {
      workerCount: relayScanWorkers,
      timeoutMs: relayConnectTimeoutMs,
      maxDurationMs: relayScanMaxDurationMs,
      attemptsPerHost: relayProbeAttempts,
    });
    if (found) {
      return found;
    }
  }

  return null;
}

async function runRelayDiscoveryScan(): Promise<RelayDiscoveryStatus> {
  updateRelayDiscoveryStatus({
    phase: "scanning",
    host: relayDiscoveryStatus.host,
    startedAt: Date.now(),
    lastError: null,
  });

  try {
    const discoveredHost = await discoverRelayBootstrapHostInBackground();
    if (discoveredHost) {
      writeCachedRelayBootstrapHost(discoveredHost);
      return updateRelayDiscoveryStatus({
        phase: "found",
        host: discoveredHost,
        lastError: null,
      });
    }

    return updateRelayDiscoveryStatus({
      phase: "not-found",
      host: null,
      lastError: null,
    });
  } catch (error) {
    const lastError = error instanceof Error ? error.message : "relay discovery failed";
    return updateRelayDiscoveryStatus({
      phase: "error",
      host: null,
      lastError,
    });
  }
}

function startRelayDiscoveryScan(): Promise<RelayDiscoveryStatus> {
  if (relayDiscoveryTask) {
    return relayDiscoveryTask;
  }

  relayDiscoveryTask = runRelayDiscoveryScan().finally(() => {
    relayDiscoveryTask = null;
  });

  return relayDiscoveryTask;
}

function getRelayDiscoveryStatusSnapshot(): RelayDiscoveryStatus {
  return relayDiscoveryStatus;
}

async function getLocalNetworkInfo(): Promise<LocalNetworkInfo> {
  const sortedAddresses = await getPreferredIpv4AddressesIncludingLoopback();

  return {
    hostname: os.hostname(),
    preferredAddress: sortedAddresses[0] ?? "127.0.0.1",
    addresses: sortedAddresses,
  };
}

async function stopHostService(reason: "host-ended" | "host-disconnected" = "host-disconnected"): Promise<HostServiceInfo> {
  await hostService.stop(reason);
  return hostService.getStatus();
}

ipcMain.handle("host-service:start", async (_event, requestedPort?: number) => {
  return hostService.start(requestedPort);
});

ipcMain.handle("host-service:stop", async () => {
  return stopHostService("host-disconnected");
});

ipcMain.handle("host-service:status", async () => hostService.getStatus());

ipcMain.handle("host-service:network-info", async () => getLocalNetworkInfo());

ipcMain.handle("relay-bootstrap-cache:host", async () => readCachedRelayBootstrapHost());

ipcMain.handle("relay-discovery:start", async () => startRelayDiscoveryScan());

ipcMain.handle("relay-discovery:status", async () => getRelayDiscoveryStatusSnapshot());

ipcMain.handle("file-transfer:select-file", async () => selectFileForSharing());

ipcMain.handle(
  "file-transfer:build-manifest",
  async (_event, filePath: string, roomId: string, senderPeerId: string, pieceSize: number) =>
    buildFileManifest(filePath, roomId, senderPeerId, pieceSize),
);

ipcMain.handle("file-transfer:read-piece", async (_event, filePath: string, pieceIndex: number, pieceSize: number) =>
  readFilePiece(filePath, pieceIndex, pieceSize),
);

ipcMain.handle("file-transfer:create-receiver", async (_event, manifest) => createReceiverTransfer(manifest));

ipcMain.handle("file-transfer:write-receiver-piece", async (_event, transferId: string, pieceIndex: number, data) =>
  writeReceiverPiece(transferId, pieceIndex, new Uint8Array(data)),
);

ipcMain.handle("file-transfer:finalize-receiver", async (_event, transferId: string) =>
  finalizeReceiverTransfer(transferId),
);

ipcMain.handle("file-transfer:cancel-receiver", async (_event, transferId: string) => removeReceiverTransfer(transferId));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;

  win.once("ready-to-show", () => {
    win.maximize();
    win.show();
    closeSplashWindow();
  });

  win.webContents.once("did-fail-load", () => {
    closeSplashWindow();
  });

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
    return;
  }

  const indexPath = path.join(__dirname, "../../dist-renderer/index.html");
  void win.loadFile(indexPath);
}

app.whenReady().then(() => {
  createSplashWindow();
  createWindow();
  void startRelayDiscoveryScan();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplashWindow();
      createWindow();
    }
  });
});

app.on("before-quit", (event) => {
  if (isQuitting) {
    return;
  }

  const hostStatus = hostService.getStatus();
  if (hostStatus.status === "stopped") {
    return;
  }

  event.preventDefault();
  isQuitting = true;
  void stopHostService("host-disconnected").finally(() => {
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
