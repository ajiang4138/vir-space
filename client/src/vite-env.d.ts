/// <reference types="vite/client" />

import type { HostServiceInfo, LocalNetworkInfo } from "./shared/signaling";

declare global {
  interface Window {
    electronApi: {
      platform: NodeJS.Platform;
      versions: NodeJS.ProcessVersions;
      startHostService: (requestedPort?: number) => Promise<HostServiceInfo>;
      stopHostService: () => Promise<HostServiceInfo>;
      getHostServiceStatus: () => Promise<HostServiceInfo>;
      getLocalNetworkInfo: () => Promise<LocalNetworkInfo>;
    };
  }
}

export { };

