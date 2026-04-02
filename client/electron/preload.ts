import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("electronApi", {
  platform: process.platform,
  versions: process.versions,
});
