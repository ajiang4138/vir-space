/// <reference types="vite/client" />

import type { HostServiceInfo, LocalNetworkInfo } from "./shared/signaling";

interface ImportMetaEnv {
  readonly VITE_BOOTSTRAP_SIGNALING_URL?: string;
  readonly VITE_STUN_URLS?: string;
  readonly VITE_TURN_URLS?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

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

