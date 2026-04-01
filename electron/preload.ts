import { contextBridge } from 'electron';
import os from 'os';

const discoveryPort = Number(process.env.VIR_SPACE_DISCOVERY_PORT);
const resolvedDiscoveryPort = Number.isFinite(discoveryPort) && discoveryPort > 0 ? discoveryPort : 47831;

function getLocalAddress(): string {
  if (process.env.VIR_SPACE_DISCOVERY_HOST) {
    return process.env.VIR_SPACE_DISCOVERY_HOST;
  }

  const networkInterfaces = os.networkInterfaces();
  for (const interfaces of Object.values(networkInterfaces)) {
    if (!interfaces) {
      continue;
    }

    for (const networkInterface of interfaces) {
      if (networkInterface.family === 'IPv4' && !networkInterface.internal) {
        return networkInterface.address;
      }
    }
  }

  return '127.0.0.1';
}

const discoveryUrl = process.env.VIR_SPACE_DISCOVERY_URL || `http://${getLocalAddress()}:${resolvedDiscoveryPort}`;

contextBridge.exposeInMainWorld('virSpace', {
  platform: process.platform,
  versions: process.versions,
  discovery: {
    discoveryUrl,
    discoveryPort: resolvedDiscoveryPort,
    discoveryHost: getLocalAddress(),
  },
});
