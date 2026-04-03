import { app, BrowserWindow, ipcMain } from "electron";
import os from "node:os";
import path from "node:path";
import type {
  HostServiceInfo,
  LocalNetworkInfo,
  RoomDiscoveryAnnouncementInput,
} from "../src/shared/signaling.js";
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
import { DEFAULT_ROOM_DISCOVERY_PORT, RoomDiscoveryService } from "./roomDiscovery.js";

const hostService = new HostRoomService();
const roomDiscoveryService = new RoomDiscoveryService({
  onAnnouncement: (announcement) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("room-discovery:announcement", announcement);
    }
  },
  onError: (message) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("room-discovery:error", message);
    }
  },
});
let isQuitting = false;

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

ipcMain.handle("room-discovery:start-listener", async (_event, requestedPort?: number) => {
  return roomDiscoveryService.startListener(requestedPort ?? DEFAULT_ROOM_DISCOVERY_PORT);
});

ipcMain.handle("room-discovery:stop-listener", async () => {
  await roomDiscoveryService.stopListener();
  return roomDiscoveryService.getListenerStatus();
});

ipcMain.handle("room-discovery:listener-status", async () => roomDiscoveryService.getListenerStatus());

ipcMain.handle(
  "room-discovery:start-announcement",
  async (
    _event,
    payload: {
      discoveryPort?: number;
      intervalMs?: number;
      announcement: RoomDiscoveryAnnouncementInput;
    },
  ) => roomDiscoveryService.startAnnouncement(payload),
);

ipcMain.handle("room-discovery:stop-announcement", async () => {
  await roomDiscoveryService.stopAnnouncement();
  return roomDiscoveryService.getAnnouncementStatus();
});

ipcMain.handle("room-discovery:announcement-status", async () => roomDiscoveryService.getAnnouncementStatus());

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
  const listenerStatus = roomDiscoveryService.getListenerStatus();
  const announcementStatus = roomDiscoveryService.getAnnouncementStatus();
  const hasActiveBackgroundService =
    hostStatus.status !== "stopped"
    || listenerStatus.status !== "stopped"
    || announcementStatus.status !== "stopped";

  if (!hasActiveBackgroundService) {
    return;
  }

  event.preventDefault();
  isQuitting = true;
  void (async () => {
    if (hostStatus.status !== "stopped") {
      await stopHostService("host-disconnected");
    }

    await roomDiscoveryService.stop();
  })().finally(() => {
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
