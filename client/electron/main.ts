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

const hostService = new HostRoomService();
let isQuitting = false;

const relayPort = 8787;
const relayConnectTimeoutMs = 2000;
const relayProbeAttempts = 3;
const relayScanWorkers = 100;
const relayScanMaxDurationMs = 90_000;

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

  if (address.startsWith("100.")) {
    return 0;
  }

  if (address.startsWith("25.")) {
    return 1;
  }

  if (address.startsWith("10.")) {
    return 2;
  }

  if (address.startsWith("172.")) {
    return 3;
  }

  if (address.startsWith("192.168.")) {
    return 4;
  }

  return 10;
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

function getLocalNonLoopbackIPv4Addresses(): string[] {
  const entries: Array<{ ip: string; ifaceName: string }> = [];

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

  return unique.sort((left, right) => {
    const ipScoreDelta = scorePreferredAddress(left.ip) - scorePreferredAddress(right.ip);
    if (ipScoreDelta !== 0) {
      return ipScoreDelta;
    }

    // Ethernet/VPN adapters get priority over Wi-Fi.
    const ifaceScore = (ifaceName: string): number => {
      const lower = ifaceName.toLowerCase();
      if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wireless") || lower.includes("wlan")) return 1;
      return 0;
    };

    const ifaceDelta = ifaceScore(left.ifaceName) - ifaceScore(right.ifaceName);
    if (ifaceDelta !== 0) {
      return ifaceDelta;
    }

    return left.ip.localeCompare(right.ip);
  }).map((entry) => entry.ip);
}

async function discoverRelayBootstrapHostInBackground(): Promise<string | null> {
  const localIps = getLocalNonLoopbackIPv4Addresses();
  const cachedHost = readCachedRelayBootstrapHost();

  if (cachedHost) {
    const cachedReachable = await canReachTcpWithRetries(cachedHost, relayPort, 500, relayProbeAttempts);
    if (cachedReachable) {
      return cachedHost;
    }
  }

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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
    return;
  }

  const indexPath = path.join(__dirname, "../../dist/index.html");
  void win.loadFile(indexPath);
}

app.whenReady().then(() => {
  createWindow();
  void startRelayDiscoveryScan();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
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
