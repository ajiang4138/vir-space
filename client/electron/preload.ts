import { contextBridge, ipcRenderer } from "electron";
import type { FileManifest } from "../src/shared/fileTransfer.js";
import type {
  RoomDiscoveryAnnouncement,
  RoomDiscoveryAnnouncementInput,
  RoomDiscoveryAnnouncementStatusInfo,
  RoomDiscoveryListenerStatusInfo,
} from "../src/shared/signaling.js";

contextBridge.exposeInMainWorld("electronApi", {
  platform: process.platform,
  versions: process.versions,
  startHostService: (requestedPort?: number) => ipcRenderer.invoke("host-service:start", requestedPort),
  stopHostService: () => ipcRenderer.invoke("host-service:stop"),
  getHostServiceStatus: () => ipcRenderer.invoke("host-service:status"),
  getLocalNetworkInfo: () => ipcRenderer.invoke("host-service:network-info"),
  startRoomDiscoveryListener: (requestedPort?: number): Promise<RoomDiscoveryListenerStatusInfo> =>
    ipcRenderer.invoke("room-discovery:start-listener", requestedPort),
  stopRoomDiscoveryListener: (): Promise<RoomDiscoveryListenerStatusInfo> =>
    ipcRenderer.invoke("room-discovery:stop-listener"),
  getRoomDiscoveryListenerStatus: (): Promise<RoomDiscoveryListenerStatusInfo> =>
    ipcRenderer.invoke("room-discovery:listener-status"),
  startRoomDiscoveryAnnouncement: (payload: {
    discoveryPort?: number;
    intervalMs?: number;
    announcement: RoomDiscoveryAnnouncementInput;
  }): Promise<RoomDiscoveryAnnouncementStatusInfo> => ipcRenderer.invoke("room-discovery:start-announcement", payload),
  stopRoomDiscoveryAnnouncement: (): Promise<RoomDiscoveryAnnouncementStatusInfo> =>
    ipcRenderer.invoke("room-discovery:stop-announcement"),
  getRoomDiscoveryAnnouncementStatus: (): Promise<RoomDiscoveryAnnouncementStatusInfo> =>
    ipcRenderer.invoke("room-discovery:announcement-status"),
  onRoomDiscoveryAnnouncement: (callback: (announcement: RoomDiscoveryAnnouncement) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, announcement: RoomDiscoveryAnnouncement): void => {
      callback(announcement);
    };

    ipcRenderer.on("room-discovery:announcement", listener);
    return () => {
      ipcRenderer.removeListener("room-discovery:announcement", listener);
    };
  },
  onRoomDiscoveryError: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string): void => {
      callback(message);
    };

    ipcRenderer.on("room-discovery:error", listener);
    return () => {
      ipcRenderer.removeListener("room-discovery:error", listener);
    };
  },
  selectFileForSharing: () => ipcRenderer.invoke("file-transfer:select-file"),
  buildFileManifest: (filePath: string, roomId: string, senderPeerId: string, pieceSize: number) =>
    ipcRenderer.invoke("file-transfer:build-manifest", filePath, roomId, senderPeerId, pieceSize),
  readFilePiece: (filePath: string, pieceIndex: number, pieceSize: number) =>
    ipcRenderer.invoke("file-transfer:read-piece", filePath, pieceIndex, pieceSize),
  createReceiverTransfer: (manifest: FileManifest) => ipcRenderer.invoke("file-transfer:create-receiver", manifest),
  writeReceiverPiece: (transferId: string, pieceIndex: number, data: Uint8Array) =>
    ipcRenderer.invoke("file-transfer:write-receiver-piece", transferId, pieceIndex, data),
  finalizeReceiverTransfer: (transferId: string) => ipcRenderer.invoke("file-transfer:finalize-receiver", transferId),
  cancelReceiverTransfer: (transferId: string) => ipcRenderer.invoke("file-transfer:cancel-receiver", transferId),
});
