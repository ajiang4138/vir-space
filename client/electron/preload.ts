import { contextBridge, ipcRenderer } from "electron";
import type { TorrentManifest } from "../src/shared/fileTransfer.js";

interface MetricsSessionInfo {
  runId: string;
  peerFileId: string;
  logDirPath: string;
  logFilePath: string;
}

contextBridge.exposeInMainWorld("electronApi", {
  platform: process.platform,
  versions: process.versions,
  startHostService: (requestedPort?: number) => ipcRenderer.invoke("host-service:start", requestedPort),
  stopHostService: () => ipcRenderer.invoke("host-service:stop"),
  getHostServiceStatus: () => ipcRenderer.invoke("host-service:status"),
  getLocalNetworkInfo: () => ipcRenderer.invoke("host-service:network-info"),
  selectFileForSharing: () => ipcRenderer.invoke("file-transfer:select-file"),
  buildFileManifest: (filePath: string, roomId: string, senderPeerId: string, pieceSize: number) =>
    ipcRenderer.invoke("file-transfer:build-manifest", filePath, roomId, senderPeerId, pieceSize),
  readFilePiece: (filePath: string, pieceIndex: number, pieceSize: number) =>
    ipcRenderer.invoke("file-transfer:read-piece", filePath, pieceIndex, pieceSize),
  createReceiverTransfer: (manifest: TorrentManifest) => ipcRenderer.invoke("file-transfer:create-receiver", manifest),
  writeReceiverPiece: (transferId: string, pieceIndex: number, data: Uint8Array) =>
    ipcRenderer.invoke("file-transfer:write-receiver-piece", transferId, pieceIndex, data),
  finalizeReceiverTransfer: (transferId: string) => ipcRenderer.invoke("file-transfer:finalize-receiver", transferId),
  cancelReceiverTransfer: (transferId: string) => ipcRenderer.invoke("file-transfer:cancel-receiver", transferId),
  initMetricsSession: (runId: string, peerFileId: string): Promise<MetricsSessionInfo> =>
    ipcRenderer.invoke("metrics:init", { runId, peerFileId }),
  getMetricsSession: (): Promise<MetricsSessionInfo | null> => ipcRenderer.invoke("metrics:get-session"),
  appendMetricsRecord: (record: unknown): Promise<void> => ipcRenderer.invoke("metrics:append", record),
  openMetricsFolder: (): Promise<void> => ipcRenderer.invoke("metrics:open-folder"),
});
