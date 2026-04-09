import { app, BrowserWindow, ipcMain } from "electron";
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
    <title>Launching Vir Space</title>
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
      <h1>Vir Space is starting</h1>
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
