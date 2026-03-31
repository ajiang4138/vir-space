import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('virSpace', {
  platform: process.platform,
  versions: process.versions,
});
