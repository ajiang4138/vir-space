import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronApi", {
  platform: process.platform,
  versions: process.versions,
  startHostService: (requestedPort?: number) => ipcRenderer.invoke("host-service:start", requestedPort),
  stopHostService: () => ipcRenderer.invoke("host-service:stop"),
  getHostServiceStatus: () => ipcRenderer.invoke("host-service:status"),
  getLocalNetworkInfo: () => ipcRenderer.invoke("host-service:network-info"),
});
