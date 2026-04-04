import { app, BrowserWindow, ipcMain, shell } from "electron";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostServiceInfo, LocalNetworkInfo } from "../src/shared/signaling.js";
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

interface MetricsSession {
  runId: string;
  peerFileId: string;
  logDirPath: string;
  logFilePath: string;
}

const metricsSessionsByWebContentsId = new Map<number, MetricsSession>();

function normalizeToken(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

function findWorkspaceRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const hasClientDir = existsSync(path.join(current, "client"));
    const hasServerDir = existsSync(path.join(current, "server"));
    if (hasClientDir && hasServerDir) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function resolveMetricsBaseDir(): string {
  const override = process.env.VIR_SPACE_METRICS_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  // Prefer workspace root in development so logs are next to client/ and server/.
  for (const candidate of [process.cwd(), app.getAppPath(), __dirname]) {
    const workspaceRoot = findWorkspaceRoot(candidate);
    if (workspaceRoot) {
      return path.join(workspaceRoot, ".metrics");
    }
  }

  // Fallback for unknown launch layouts.
  return path.resolve(process.cwd(), ".metrics");
}

async function ensureMetricsSession(runIdInput: string, peerFileIdInput: string): Promise<MetricsSession> {
  const runId = normalizeToken(runIdInput, "run-unknown");
  const peerFileId = normalizeToken(peerFileIdInput, `peer-${Date.now()}`);
  const runDir = path.join(resolveMetricsBaseDir(), runId);
  await fs.mkdir(runDir, { recursive: true });

  return {
    runId,
    peerFileId,
    logDirPath: runDir,
    logFilePath: path.join(runDir, `peer_${peerFileId}.ndjson`),
  };
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
    if (left === "127.0.0.1") {
      return -1;
    }

    if (right === "127.0.0.1") {
      return 1;
    }

    return left.localeCompare(right);
  });

  return {
    hostname: os.hostname(),
    preferredAddress: sortedAddresses.find((address) => address !== "127.0.0.1") ?? "127.0.0.1",
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

ipcMain.handle(
  "metrics:init",
  async (event, payload: { runId?: string; peerFileId?: string } | undefined): Promise<MetricsSession> => {
    const nextSession = await ensureMetricsSession(
      payload?.runId ?? "run-unknown",
      payload?.peerFileId ?? `peer-${event.sender.id}`,
    );

    metricsSessionsByWebContentsId.set(event.sender.id, nextSession);
    await fs.appendFile(
      nextSession.logFilePath,
      `${JSON.stringify({
        timestampMs: Date.now(),
        eventType: "metrics_session_initialized",
        runId: nextSession.runId,
        peerFileId: nextSession.peerFileId,
      })}\n`,
      "utf8",
    );

    return nextSession;
  },
);

ipcMain.handle("metrics:get-session", async (event): Promise<MetricsSession | null> => {
  return metricsSessionsByWebContentsId.get(event.sender.id) ?? null;
});

ipcMain.handle("metrics:append", async (event, record: unknown): Promise<void> => {
  const session = metricsSessionsByWebContentsId.get(event.sender.id);
  if (!session) {
    throw new Error("metrics session not initialized; call metrics:init first");
  }

  const payload = typeof record === "object" && record !== null ? (record as Record<string, unknown>) : { value: record };
  const line = {
    ...payload,
    runId: session.runId,
    peerFileId: session.peerFileId,
    loggedAtMs: Date.now(),
  };

  await fs.appendFile(session.logFilePath, `${JSON.stringify(line)}\n`, "utf8");
});

ipcMain.handle("metrics:open-folder", async (event): Promise<void> => {
  const session = metricsSessionsByWebContentsId.get(event.sender.id);
  const targetPath = session?.logDirPath ?? resolveMetricsBaseDir();
  const errorMessage = await shell.openPath(targetPath);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
});

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

  win.maximize();

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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("web-contents-created", (_event, contents) => {
  contents.once("destroyed", () => {
    metricsSessionsByWebContentsId.delete(contents.id);
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
