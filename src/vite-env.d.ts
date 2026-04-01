/// <reference types="vite/client" />

interface VirSpaceDiscoveryInfo {
  discoveryUrl: string;
  discoveryPort: number;
  discoveryHost: string;
}

interface VirSpaceWindowApi {
  platform: string;
  versions: Record<string, string>;
  discovery: VirSpaceDiscoveryInfo;
}

declare global {
  interface Window {
    virSpace?: VirSpaceWindowApi;
  }
}

export { };
