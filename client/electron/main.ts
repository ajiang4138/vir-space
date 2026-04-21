import { app, BrowserWindow, ipcMain } from "electron";
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
      <p>Discovering network relays...</p>
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
const relayScanWorkers = 1024;
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

function scorePreferredAddress(address: string): number {
  if (address === "127.0.0.1") {
    return 100;
  }

  if (address.startsWith("169.254.")) {
    return 90;
  }

  if (address.startsWith("192.168.56.")) {
    return 80;
  }

  if (address.startsWith("10.2.")) {
    return -1;
  }

  if (address.startsWith("10.")) {
    return 0;
  }

  if (address.startsWith("172.")) {
    return 1;
  }

  if (address.startsWith("192.168.")) {
    return 2;
  }

  if (address.startsWith("100.")) {
    return 5;
  }

  if (address.startsWith("25.")) {
    return 6;
  }

  return 10;
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

function getLocalNonLoopbackIPv4Addresses(): string[] {
  const entries: Array<{ ip: string; ifaceName: string }> = [];

  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    if (!interfaces) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (
      (lowerName.includes("virtual") && !lowerName.includes("pangp") && !lowerName.includes("vpn")) ||
      lowerName.includes("vbox") ||
      lowerName.includes("wsl") ||
      lowerName.includes("loopback")
    ) {
      continue;
    }

    for (const detail of interfaces) {
      if (detail.family !== "IPv4" || detail.internal || !detail.address || !isIPv4(detail.address)) {
        continue;
      }

      // Exclude known virtual/link-local IP ranges
      if (detail.address.startsWith("169.254.") || detail.address.startsWith("192.168.56.")) {
        continue;
      }

      entries.push({ ip: detail.address, ifaceName: name });
    }
  }

  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.ip)) {
      return false;
    }
    seen.add(entry.ip);
    return true;
  });

  // Ethernet/VPN adapters get priority over Wi-Fi.
  const ifaceScore = (ifaceName: string): number => {
    const lower = ifaceName.toLowerCase();
    if (
      lower.includes("pangp") ||
      lower.includes("vpn") ||
      lower.includes("cisco") ||
      lower.includes("anyconnect") ||
      lower.includes("globalprotect")
    ) {
      return -1;
    }
    if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wireless") || lower.includes("wlan")) {
      return 1;
    }
    return 0;
  };

  const sorted = unique.sort((left, right) => {
    const ifaceDelta = ifaceScore(left.ifaceName) - ifaceScore(right.ifaceName);
    if (ifaceDelta !== 0) {
      return ifaceDelta;
    }

    const ipScoreDelta = scorePreferredAddress(left.ip) - scorePreferredAddress(right.ip);
    if (ipScoreDelta !== 0) {
      return ipScoreDelta;
    }

    return left.ip.localeCompare(right.ip);
  });

  // If a VPN is present (by name or by 10.2.x.x IP), we exclusively use the VPN
  // interface(s) to avoid scanning huge home/CGNAT subnets.
  const vpnOnly = sorted.filter(
    (entry) => ifaceScore(entry.ifaceName) === -1 || entry.ip.startsWith("10.2."),
  );
  if (vpnOnly.length > 0) {
    return vpnOnly.map((entry) => entry.ip);
  }

  return sorted.map((entry) => entry.ip);
}

async function discoverRelayBootstrapHostInBackground(): Promise<string | null> {
  const localIps = getLocalNonLoopbackIPv4Addresses();

  for (const localIp of localIps) {
    // eslint-disable-next-line no-await-in-loop
    const selfReachable = await canReachTcpWithRetries(localIp, relayPort, 500, relayProbeAttempts);
    if (selfReachable) {
      return localIp;
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

  // --- Phase 1: Fast Scan (Local /24 Subnets) ---
  // Scan the immediate 254 neighbors of all local interfaces simultaneously.
  const fastScanHosts: string[] = [];
  for (const ip of localIps) {
    const parts = ip.split(".");
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
    for (let i = 1; i <= 254; i++) {
      const host = `${prefix}.${i}`;
      if (!localIps.includes(host)) fastScanHosts.push(host);
    }
  }

  const fastFound = await scanHostList([...new Set(fastScanHosts)], relayPort, {
    workerCount: relayScanWorkers,
    timeoutMs: 500, // Very aggressive for local subnet
    attemptsPerHost: 1,
  });

  if (fastFound) return fastFound;

  // --- Phase 2: Deep Scan (Full Class B Prefixes) ---
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

function getLocalNetworkInfo(): LocalNetworkInfo {
  const addresses = new Set<string>();

  for (const interfaces of Object.values(os.networkInterfaces())) {
    if (!interfaces) {
      continue;
    }

    for (const detail of interfaces) {
      if (detail.family !== "IPv4") {
        continue;
      }

      addresses.add(detail.address);
    }
  }

  if (addresses.size === 0) {
    addresses.add("127.0.0.1");
  } else {
    addresses.add("127.0.0.1");
  }

  const sortedAddresses = Array.from(addresses).sort((left, right) => {
    const scoreDelta = scorePreferredAddress(left) - scorePreferredAddress(right);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return left.localeCompare(right);
  });

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

  const handleAppReady = () => {
    createWindow();
  };

  if (process.env.VITE_BOOTSTRAP_SIGNALING_URL) {
    handleAppReady();
  } else {
    startRelayDiscoveryScan().finally(handleAppReady);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplashWindow();
      if (process.env.VITE_BOOTSTRAP_SIGNALING_URL) {
        handleAppReady();
      } else {
        startRelayDiscoveryScan().finally(handleAppReady);
      }
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
